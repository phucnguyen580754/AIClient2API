import http from 'http';
import https from 'https';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import { CONFIG } from '../core/config-manager.js';
import { getProxyConfigForProvider } from '../utils/proxy-utils.js';

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

/**
 * Make an HTTP(S) request with proxy support.
 * Wraps axios for proxy compatibility, mirrors fetch() interface.
 * @param {string} url
 * @param {object} options
 * @param {string} [providerType='kiro-enterprise']
 * @returns {Promise<{ok: boolean, status: number, statusText: string, json: Function, text: Function}>}
 */
async function fetchWithProxy(url, options = {}, providerType = 'kiro-enterprise') {
  const proxyConfig = getProxyConfigForProvider(CONFIG, providerType);
  const axiosConfig = {
    url,
    method: options.method || 'GET',
    headers: options.headers || {},
    timeout: 30000,
  };
  if (options.body) {
    axiosConfig.data = options.body;
  }
  if (proxyConfig) {
    axiosConfig.httpAgent = proxyConfig.httpAgent;
    axiosConfig.httpsAgent = proxyConfig.httpsAgent;
    axiosConfig.proxy = false;
  }
  try {
    const axios = (await import('axios')).default;
    const response = await axios(axiosConfig);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      json: async () => response.data,
      text: async () => typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
    };
  } catch (error) {
    if (error.response) {
      return {
        ok: false,
        status: error.response.status,
        statusText: error.response.statusText,
        headers: error.response.headers,
        json: async () => error.response.data,
        text: async () => typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data),
      };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hardcoded default IdP host suffixes for SSRF protection (additive-only). */
const DEFAULT_ALLOWED_IDP_SUFFIXES = [
  '.microsoftonline.com',
  '.microsoftonline.us',
  '.microsoftonline.cn',
];

/** Enterprise SSO session timeout in milliseconds (10 minutes). */
const ENTERPRISE_SESSION_TIMEOUT_MS = 10 * 60 * 1000;

/** Maximum token refresh retries on transient errors. */
const MAX_REFRESH_RETRIES = 3;

/** Exponential backoff base interval in milliseconds. */
const REFRESH_BACKOFF_BASE_MS = 1000;

/** Preferred loopback port range for the enterprise SSO callback server. */
const CALLBACK_PORT_START = 3128;
const CALLBACK_PORT_END = 3128;

/** Enterprise credential storage — matches the kiro-oauth.js directory pattern. */
const CREDENTIALS_DIR = 'configs/kiro';

const LOG_PREFIX = '[Kiro Enterprise]';

// ---------------------------------------------------------------------------
// Active session tracking
// ---------------------------------------------------------------------------

/**
 * Active enterprise SSO session (in-memory only).
 * Only one enterprise SSO session is allowed at a time.
 * @type {import('./kiro-enterprise.js').KiroSSOSession | null}
 */
let activeEnterpriseSession = null;

// ---------------------------------------------------------------------------
// PKCE helpers  (T003)
// ---------------------------------------------------------------------------

/**
 * Generate a PKCE code verifier (crypto random 64 bytes, base64url).
 * @returns {string}
 */
function generateCodeVerifier() {
  return crypto.randomBytes(64).toString('base64url');
}

/**
 * Generate a PKCE code challenge (SHA-256 base64url of verifier).
 * @param {string} codeVerifier
 * @returns {string}
 */
function generateCodeChallenge(codeVerifier) {
  const hash = crypto.createHash('sha256');
  hash.update(codeVerifier);
  return hash.digest('base64url');
}

/**
 * Generate an anti-CSRF state parameter (crypto random 32 bytes, hex).
 * @returns {string}
 */
function generateState() {
  return crypto.randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------------------
// Endpoint validation  (T004)
// ---------------------------------------------------------------------------

/**
 * Parse a URL string and return its components, or null if invalid.
 * Uses a safe wrapper around new URL() — does NOT follow redirects.
 * @param {string} urlString
 * @returns {{hostname: string, protocol: string, href: string} | null}
 */
function safeParseUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    return { hostname: parsed.hostname, protocol: parsed.protocol, href: parsed.href };
  } catch {
    return null;
  }
}

/**
 * Check if a hostname string is an IP literal (IPv4 or IPv6).
 * @param {string} hostname
 * @returns {boolean}
 */
function isIpLiteral(hostname) {
  // IPv4: dotted quad
  const ipv4Regex = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  if (ipv4Regex.test(hostname)) {
    return hostname.split('.').every(octet => parseInt(octet, 10) <= 255);
  }
  // IPv6: contains ':'
  return hostname.includes(':');
}

/**
 * Validate an external IdP endpoint URL against the allow-list.
 *
 * @param {string} endpointUrl - The endpoint URL to validate.
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateExternalIdpEndpoint(endpointUrl) {
  const parsed = safeParseUrl(endpointUrl);
  if (!parsed) {
    return { valid: false, reason: 'URL is malformed or unparseable' };
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, reason: 'Endpoint must use HTTPS' };
  }

  if (isIpLiteral(parsed.hostname)) {
    return { valid: false, reason: 'IP literal hosts are not allowed (SSRF protection)' };
  }

  const allowedSuffixes = getExternalIdpAllowList();
  const matches = allowedSuffixes.some(suffix => parsed.hostname.endsWith(suffix));

  if (!matches) {
    return { valid: false, reason: `Host "${parsed.hostname}" is not in the allow-list` };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Allow-list configuration  (T005, T008)
// ---------------------------------------------------------------------------

/**
 * Load additional IdP host suffixes from the optional config file.
 * The config file is at configs/kiro/external-idp-allow-list.json.
 * If the file is missing or malformed, defaults are used.
 *
 * @returns {string[]} Additional suffixes, or empty array on error.
 */
function loadAllowListConfig() {
  const configPath = path.resolve(CREDENTIALS_DIR, 'external-idp-allow-list.json');
  try {
    if (!fs.existsSync(configPath)) {
      return [];
    }
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.additionalSuffixes)) {
      logger.warn(`${LOG_PREFIX} allow-list config file has invalid format (expected { additionalSuffixes: [...] }), using defaults`);
      return [];
    }
    // Filter out non-string entries
    const suffixes = parsed.additionalSuffixes.filter(s => typeof s === 'string' && s.length > 0);
    if (suffixes.length === 0) {
      logger.warn(`${LOG_PREFIX} allow-list config file contains no valid suffixes`);
      return [];
    }
    return suffixes;
  } catch (err) {
    logger.warn(`${LOG_PREFIX} failed to load allow-list config: ${err.message}, using defaults`);
    return [];
  }
}

/**
 * Return the current allow-list of approved IdP host suffixes.
 * Always includes hardcoded defaults, merged with any configured additions.
 *
 * @returns {string[]}
 */
export function getExternalIdpAllowList() {
  const configured = loadAllowListConfig();
  // Merge: configured suffixes are additive only, defaults always present
  const merged = [...DEFAULT_ALLOWED_IDP_SUFFIXES];
  for (const suffix of configured) {
    // Ensure the suffix has a leading dot for suffix matching consistency
    const normalized = suffix.startsWith('.') ? suffix : `.${suffix}`;
    if (!merged.includes(normalized)) {
      merged.push(normalized);
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Enterprise auth detection  (T006)
// ---------------------------------------------------------------------------

/**
 * Detect whether an auth method value refers to enterprise (external IdP) auth.
 * Recognises canonical and alias values. Returns the normalised value or null.
 *
 * @param {string} authMethod
 * @returns {string|null} "external_idp" if matched, null otherwise.
 */
export function detectEnterpriseAuthAlias(authMethod) {
  if (!authMethod || typeof authMethod !== 'string') return null;
  const normalized = authMethod.trim().toLowerCase();
  const aliases = ['external_idp', 'azuread', 'entra', 'microsoft', 'm365', 'office365'];
  return aliases.includes(normalized) ? 'external_idp' : null;
}

// ---------------------------------------------------------------------------
// JWT helper  (T007)
// ---------------------------------------------------------------------------

/**
 * Decode the payload of a JWT without signature verification.
 * Used to extract claims (email, preferred_username, upn) from an id_token.
 *
 * @param {string} token - Base64url-encoded JWT string.
 * @returns {Object|null} Parsed payload object, or null on failure.
 */
export function parseJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    // Base64url-decode the payload (second part)
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    // Add padding if needed
    const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
    const decoded = Buffer.from(padded, 'base64').toString('utf-8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

/**
 * Extract the email address from a Microsoft Entra ID id_token JWT.
 * Claim resolution order: email > preferred_username > upn.
 *
 * @param {string} idToken - The raw id_token string.
 * @returns {string|null}
 */
export function extractEmailFromIdToken(idToken) {
  const payload = parseJwtPayload(idToken);
  if (!payload) return null;
  return payload.email || payload.preferred_username || payload.upn || null;
}

// ---------------------------------------------------------------------------
// Browser redirect  (T022)
// ---------------------------------------------------------------------------

/**
 * Open the system browser to the given URL.
 * Uses platform-specific command: start (Windows), open (macOS), xdg-open (Linux).
 *
 * @param {string} url
 * @returns {Promise<void>}
 */
export async function redirectBrowser(url) {
  const { exec } = await import('child_process');
  const platform = process.platform;
  const cmd = platform === 'win32' ? 'start' : platform === 'darwin' ? 'open' : 'xdg-open';
  return new Promise((resolve, reject) => {
    const child = exec(`${cmd} "${url}"`, (err) => {
      if (err) reject(err);
      else resolve();
    });
    // Detach from parent — don't wait for browser to close
    child.unref();
  });
}

// ---------------------------------------------------------------------------
// OIDC Discovery  (T009)
// ---------------------------------------------------------------------------

/**
 * Perform OIDC discovery against an issuer URL.
 * Fetches the .well-known/openid-configuration document.
 * Does NOT follow HTTP redirects (SSRF bounce protection).
 *
 * @param {string} issuerUrl - OIDC issuer URL (e.g. https://login.microsoftonline.com/<tenant>/v2.0)
 * @returns {Promise<{ authorizationEndpoint: string, tokenEndpoint: string, issuer: string }>}
 */
export async function oidcDiscover(issuerUrl) {
  const issuerValidation = validateExternalIdpEndpoint(issuerUrl);
  if (!issuerValidation.valid) {
    throw new Error(`Issuer URL rejected by allow-list: ${issuerValidation.reason}`);
  }

  const discoveryUrl = `${issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const response = await fetchWithProxy(discoveryUrl, {}, 'kiro-enterprise');

  if (!response.ok) {
    throw new Error(`OIDC discovery failed: HTTP ${response.status}`);
  }

  const data = await response.json();

  if (!data.authorization_endpoint || !data.token_endpoint || !data.issuer) {
    throw new Error('OIDC discovery failed: incomplete response (missing authorization_endpoint, token_endpoint, or issuer)');
  }

  // Validate discovered endpoints against allow-list
  const authEndpointValidation = validateExternalIdpEndpoint(data.authorization_endpoint);
  if (!authEndpointValidation.valid) {
    throw new Error(`Discovered authorization endpoint rejected by allow-list: ${authEndpointValidation.reason}`);
  }

  const tokenEndpointValidation = validateExternalIdpEndpoint(data.token_endpoint);
  if (!tokenEndpointValidation.valid) {
    throw new Error(`Discovered token endpoint rejected by allow-list: ${tokenEndpointValidation.reason}`);
  }

  // Validate issuer matches the requested issuer URL
  const parsedIssuer = new URL(data.issuer);
  const parsedRequested = new URL(issuerUrl);
  if (parsedIssuer.hostname !== parsedRequested.hostname) {
    throw new Error(`OIDC issuer mismatch: discovered "${data.issuer}" does not match requested issuer host "${parsedRequested.hostname}"`);
  }

  return {
    authorizationEndpoint: data.authorization_endpoint,
    tokenEndpoint: data.token_endpoint,
    issuer: data.issuer,
  };
}

// ---------------------------------------------------------------------------
// Token Exchange  (T010)
// ---------------------------------------------------------------------------

/**
 * Exchange an authorization code for tokens at the Microsoft token endpoint.
 * Uses form-encoded POST (standard OAuth2).
 *
 * @param {string} tokenEndpoint - Microsoft token endpoint URL
 * @param {string} code - Authorization code from Microsoft redirect
 * @param {string} codeVerifier - PKCE code verifier
 * @param {string} redirectUri - Redirect URI used in the auth request
 * @param {string} clientId - Azure AD client ID
 * @returns {Promise<{ accessToken: string, refreshToken?: string, expiresIn: number, idToken?: string }>}
 */
export async function exchangeExternalIdpCode(tokenEndpoint, code, codeVerifier, redirectUri, clientId) {
  const endpointValidation = validateExternalIdpEndpoint(tokenEndpoint);
  if (!endpointValidation.valid) {
    throw new Error(`Token endpoint rejected by allow-list: ${endpointValidation.reason}`);
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  }).toString();

  const response = await fetchWithProxy(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  }, 'kiro-enterprise');

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Token exchange failed: HTTP ${response.status} — ${errorBody}`);
  }

  const data = await response.json();

  if (!data.access_token) {
    throw new Error('Token exchange failed: response missing access_token');
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in || 3600,
    idToken: data.id_token,
  };
}

// ---------------------------------------------------------------------------
// Microsoft Auth URL Builder  (T012)
// ---------------------------------------------------------------------------

/**
 * Build a Microsoft Entra ID authorize URL with PKCE and scope parameters.
 *
 * @param {string} issuerUrl - OIDC issuer URL
 * @param {string} clientId - Azure AD application (client) ID
 * @param {string} redirectUri - Redirect URI (loopback listener)
 * @param {string} codeChallenge - PKCE code challenge (S256)
 * @param {string} state - Anti-CSRF state parameter
 * @param {string} scopes - Space-separated OAuth2 scopes
 * @param {string} [loginHint] - Optional login_hint to pre-fill the user's email
 * @returns {string} Full Microsoft Entra ID authorize URL
 */
export function buildMicrosoftAuthUrl(issuerUrl, clientId, redirectUri, codeChallenge, state, scopes, loginHint) {
  const base = `${issuerUrl.replace(/\/$/, '')}/authorize`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  if (loginHint) {
    params.set('login_hint', loginHint);
  }
  return `${base}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Profile ARN Resolution  (T012b)
// ---------------------------------------------------------------------------

/**
 * Resolve the CodeWhisperer/Amazon Q profile ARN for an enterprise token.
 * Calls ListAvailableProfiles with the TokenType: EXTERNAL_IDP header.
 *
 * @param {string} accessToken - Bearer token from the token exchange
 * @param {string} region - AWS region (e.g. "us-east-1")
 * @param {boolean} isExternalIdp - Must be true to send EXTERNAL_IDP header
 * @returns {Promise<string>} Resolved profile ARN
 */
export async function resolveProfileArn(accessToken, region, isExternalIdp) {
  const endpoint = `https://q.${region}.amazonaws.com`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Amz-Target': 'AmazonCodeWhispererService.ListAvailableProfiles',
    'Authorization': `Bearer ${accessToken}`,
  };
  if (isExternalIdp) {
    headers['TokenType'] = 'EXTERNAL_IDP';
  }

  const response = await fetchWithProxy(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  }, 'kiro-enterprise');

  if (!response.ok) {
    // Fallback to us-east-1 (canonical control region)
    if (region !== 'us-east-1') {
      logger.warn(`${LOG_PREFIX} Profile ARN resolution failed in ${region}, falling back to us-east-1`);
      return resolveProfileArn(accessToken, 'us-east-1', isExternalIdp);
    }
    throw new Error(`Profile ARN resolution failed: HTTP ${response.status}`);
  }

  const data = await response.json();
  if (Array.isArray(data.profiles) && data.profiles.length > 0 && data.profiles[0].profileArn) {
    return data.profiles[0].profileArn;
  }

  // Fallback to us-east-1 if no profiles in this region
  if (region !== 'us-east-1') {
    logger.warn(`${LOG_PREFIX} No profiles found in ${region}, falling back to us-east-1`);
    return resolveProfileArn(accessToken, 'us-east-1', isExternalIdp);
  }

  throw new Error('Profile ARN resolution failed: no profiles returned');
}

// ---------------------------------------------------------------------------
// Enterprise Credential Save  (T020)
// ---------------------------------------------------------------------------

/**
 * Save an enterprise credential to disk following existing credential storage pattern.
 *
 * @param {object} credentialData
 * @param {string} credentialData.authMethod
 * @param {string} credentialData.provider
 * @param {string} credentialData.tokenEndpoint
 * @param {string} credentialData.issuerUrl
 * @param {string} credentialData.scopes
 * @param {string} credentialData.clientId
 * @param {string} credentialData.accessToken
 * @param {string} credentialData.refreshToken
 * @param {number} credentialData.expiresAt
 * @param {string} [credentialData.profileArn]
 * @param {string} [credentialData.region]
 * @returns {Promise<string>} The relative path to the saved credential file
 */
export async function saveEnterpriseCredential(credentialData) {
  const timestamp = Date.now();
  const folderName = `${timestamp}_kiro-auth-token`;
  const targetDir = path.join(process.cwd(), CREDENTIALS_DIR, folderName);
  const credPath = path.join(targetDir, `${folderName}.json`);

  await fs.promises.mkdir(targetDir, { recursive: true });

  const saveData = {
    authMethod: credentialData.authMethod || 'external_idp',
    provider: credentialData.provider || 'AzureAD',
    tokenEndpoint: credentialData.tokenEndpoint,
    issuerUrl: credentialData.issuerUrl,
    scopes: credentialData.scopes,
    clientId: credentialData.clientId,
    accessToken: credentialData.accessToken,
    refreshToken: credentialData.refreshToken,
    expiresAt: credentialData.expiresAt,
    profileArn: credentialData.profileArn || '',
    region: credentialData.region || 'us-east-1',
  };

  await fs.promises.writeFile(credPath, JSON.stringify(saveData, null, 2));
  logger.info(`${LOG_PREFIX} Enterprise credential saved: ${credPath}`);

  return path.relative(process.cwd(), credPath);
}

// ---------------------------------------------------------------------------
// SSO Session Management  (T015)
// ---------------------------------------------------------------------------

/**
 * Cancel the active enterprise SSO session, if any.
 * Closes the loopback server and cleans up state.
 */
function cancelActiveEnterpriseSession() {
  if (!activeEnterpriseSession) return;
  const session = activeEnterpriseSession;
  logger.info(`${LOG_PREFIX} Cancelling active enterprise SSO session (port ${session.redirectPort})`);
  try {
    if (session.server) {
      if (session.server.closeAllConnections) session.server.closeAllConnections();
      session.server.close();
    }
  } catch { /* ignore */ }
  if (session._timeoutHandle) clearTimeout(session._timeoutHandle);
  activeEnterpriseSession = null;
}

// ---------------------------------------------------------------------------
// Enterprise SSO Flow  (T013, T014)
// ---------------------------------------------------------------------------

function generateEnterpriseResponsePage(isSuccess, message) {
  const title = isSuccess ? 'Authorization Successful' : 'Authorization Failed';
  const icon = isSuccess ? '✅' : '❌';
  const countdown = isSuccess
    ? `<p>This window will close in <span id="c" style="font-weight:bold;color:#2196f3;">10</span> seconds.</p>
<script>let n=10;setInterval(()=>{n--;const e=document.getElementById("c");if(e)e.textContent=n;if(n<=0)window.close()},1000)</script>`
    : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;height:100vh;margin:0;background:#f5f5f5}
.container{text-align:center;padding:2rem;background:#fff;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,0.1);max-width:400px;width:90%;margin:auto}
h1{color:${isSuccess?'#4caf50':'#f44336'};margin-top:0}p{color:#666}</style></head>
<body><div class="container"><h1>${icon} ${title}</h1><p>${message}</p>${countdown}</div></body></html>`;
}

/**
 * Create the loopback HTTP server for the enterprise SSO callback.
 * Two-leg flow:
 *   Leg 1: Kiro portal redirects here with enterprise descriptor (issuer_url, client_id, scopes)
 *          → OIDC discovery → redirect browser to Microsoft login
 *   Leg 2: Microsoft redirects to /oauth/callback with authorization code
 *          → exchange at Microsoft token endpoint → save credential
 */
function createEnterpriseCallbackServer(port, session, options = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, `http://127.0.0.1:${port}`);
        const path = reqUrl.pathname;
        const q = Object.fromEntries(reqUrl.searchParams.entries());

        // Only GET requests expected for OAuth redirects
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        // --- Enterprise leg-1: portal callback with IdP descriptor ---
        // The portal redirects to the base redirect_uri (root path /)
        // with the enterprise IdP descriptor when it detects an enterprise email.
        const isEnterpriseDescriptor =
          path !== '/oauth/callback' &&
          (q.login_option === 'external_idp' || q.issuer_url);

        if (isEnterpriseDescriptor) {
          // Single-shot: ignore if leg-2 already in flight
          if (session.leg2Started) {
            res.writeHead(204);
            res.end();
            return;
          }

          const issuerUrl = q.issuer_url;
          const clientId = q.client_id;
          const scopes = q.scopes || 'openid profile email offline_access';
          const loginHint = q.login_hint;

          if (!clientId) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(generateEnterpriseResponsePage(false, 'Enterprise IdP descriptor missing client_id.'));
            cleanupEnterpriseSession();
            return;
          }

          // Validate issuer URL
          const issuerValidation = validateExternalIdpEndpoint(issuerUrl);
          if (!issuerValidation.valid) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(generateEnterpriseResponsePage(false, `Issuer validation failed: ${issuerValidation.reason}`));
            cleanupEnterpriseSession();
            return;
          }

          // OIDC discovery
          let authEndpoint, tokenEndpoint;
          try {
            const discovery = await oidcDiscover(issuerUrl);
            authEndpoint = discovery.authorizationEndpoint;
            tokenEndpoint = discovery.tokenEndpoint;
          } catch (err) {
            logger.error(`${LOG_PREFIX} OIDC discovery failed: ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(generateEnterpriseResponsePage(false, `OIDC discovery failed: ${err.message}`));
            cleanupEnterpriseSession();
            return;
          }

          // Fresh PKCE for enterprise leg-2
          const leg2Verifier = generateCodeVerifier();
          const leg2Challenge = generateCodeChallenge(leg2Verifier);
          const leg2State = generateState();
          const leg2RedirectUri = `http://localhost:${port}/oauth/callback`;

          // Save leg-2 context
          session.leg2 = {
            verifier: leg2Verifier,
            state: leg2State,
            tokenEndpoint,
            issuerUrl,
            clientId,
            scopes,
            redirectUri: leg2RedirectUri,
          };
          session.leg2Started = true;

          // Build Microsoft auth URL using discovered authorization endpoint
          // (Kiro-Go passes authEndpoint directly, not derived from issuer URL)
          const microsoftAuthUrl = (() => {
            const params = new URLSearchParams({
              client_id: clientId,
              response_type: 'code',
              redirect_uri: leg2RedirectUri,
              scope: scopes,
              code_challenge: leg2Challenge,
              code_challenge_method: 'S256',
              response_mode: 'query',
              state: leg2State,
            });
            if (loginHint) params.set('login_hint', loginHint);
            return `${authEndpoint}?${params.toString()}`;
          })();

          res.writeHead(302, { Location: microsoftAuthUrl });
          logger.info(`${LOG_PREFIX} Redirecting browser to Microsoft login`);
          res.end();
          return;
        }

        // --- Enterprise leg-2: Microsoft callback at /oauth/callback ---
        if (path === '/oauth/callback') {
          const leg2 = session.leg2;

          if (!leg2) {
            // No leg-2 in flight — likely a stray callback, ignore silently
            res.writeHead(204);
            res.end();
            return;
          }

          const code = q.code;
          const state = q.state;
          const errorParam = q.error;

          // State must match leg-2 state
          if (!state || state !== leg2.state) {
            res.writeHead(204);
            res.end();
            return;
          }

          if (errorParam) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(generateEnterpriseResponsePage(false, `Microsoft login failed: ${q.error_description || errorParam}`));
            cleanupEnterpriseSession();
            return;
          }

          if (!code) {
            res.writeHead(204);
            res.end();
            return;
          }

          logger.info(`${LOG_PREFIX} Exchanging authorization code at Microsoft token endpoint`);

          try {
            const tokenResult = await exchangeExternalIdpCode(
              leg2.tokenEndpoint, code, leg2.verifier,
              leg2.redirectUri, leg2.clientId,
            );

            // Resolve profile ARN
            let profileArn = '';
            try {
              profileArn = await resolveProfileArn(tokenResult.accessToken, session.region || 'us-east-1', true);
            } catch (e) {
              logger.warn(`${LOG_PREFIX} Profile ARN resolution failed: ${e.message}`);
            }

            const expiresAt = tokenResult.expiresIn ? Date.now() + tokenResult.expiresIn * 1000 : 0;
            const credential = {
              authMethod: 'external_idp',
              provider: 'AzureAD',
              tokenEndpoint: leg2.tokenEndpoint,
              issuerUrl: leg2.issuerUrl,
              scopes: leg2.scopes,
              clientId: leg2.clientId,
              accessToken: tokenResult.accessToken,
              refreshToken: tokenResult.refreshToken || '',
              expiresAt,
              profileArn,
              region: session.region || 'us-east-1',
            };

            const credPath = await saveEnterpriseCredential(credential);

            // Auto-link
            try {
              const { autoLinkProviderConfigs } = await import('../services/service-manager.js');
              await autoLinkProviderConfigs(CONFIG, { onlyCurrentCred: true, credPath });
            } catch (e) {
              logger.warn(`${LOG_PREFIX} Auto-linking failed: ${e.message}`);
            }

            // Broadcast success
            try {
              const { broadcastEvent } = await import('../services/ui-manager.js');
              broadcastEvent('oauth_success', {
                provider: 'claude-kiro-oauth',
                credPath,
                relativePath: credPath,
                timestamp: new Date().toISOString(),
                authMethod: 'external_idp',
              });
            } catch { /* non-critical */ }

            session.leg = 'completed';
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(generateEnterpriseResponsePage(true, 'Enterprise authentication successful!'));

            setTimeout(cleanupEnterpriseSession, 1000);
          } catch (err) {
            logger.error(`${LOG_PREFIX} Token exchange failed: ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(generateEnterpriseResponsePage(false, `Token exchange failed: ${err.message}`));
            cleanupEnterpriseSession();
          }
          return;
        }

        // --- Not a recognized callback path ---
        // This could be a favicon.ico request or other noise. Ignore silently.
        res.writeHead(204);
        res.end();
      } catch (err) {
        logger.error(`${LOG_PREFIX} Callback handler error: ${err.message}`);
        try { res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(generateEnterpriseResponsePage(false, 'Server error')); } catch { /* ignore */ }
        cleanupEnterpriseSession();
      }
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => { logger.info(`${LOG_PREFIX} Callback server listening on 127.0.0.1:${port}`); resolve(server); });
  });
}

function cleanupEnterpriseSession() {
  if (!activeEnterpriseSession) return;
  const s = activeEnterpriseSession;
  try { if (s.server) { if (s.server.closeAllConnections) s.server.closeAllConnections(); s.server.close(); } } catch { /* ignore */ }
  if (s._timeoutHandle) clearTimeout(s._timeoutHandle);
  activeEnterpriseSession = null;
  logger.info(`${LOG_PREFIX} Enterprise SSO session cleaned up`);
}

/**
 * Initiate the enterprise SSO login flow.
 *
 * 1. Cancels any active SSO session (single active session rule)
 * 2. Generates PKCE verifier + anti-CSRF state
 * 3. Starts loopback server (preferred range 19876-19880, fallback OS-assigned)
 * 4. Opens browser to Kiro portal with PKCE params (matching Kiro-Go pattern)
 * 5. Callback handler manages both legs of the flow
 *
 * @param {object} options
 * @param {string} [options.region]
 * @returns {Promise<{ success: boolean, authUrl?: string, port?: number, state?: string, error?: string }>}
 */
export async function startEnterpriseSSO(options = {}) {
  if (activeEnterpriseSession) cancelActiveEnterpriseSession();

  const region = options.region || 'us-east-1';
  const session = {
    codeVerifier: generateCodeVerifier(),
    state: generateState(),
    leg: 'portal',
    region,
    startedAt: Date.now(),
  };

  let server, port;

  if (options.port) {
    port = parseInt(options.port, 10);
    server = await createEnterpriseCallbackServer(port, session, options);
  } else {
    for (let p = CALLBACK_PORT_START; p <= CALLBACK_PORT_END; p++) {
      try { server = await createEnterpriseCallbackServer(p, session, options); port = p; break; }
      catch (err) { if (err.code === 'EADDRINUSE') continue; throw err; }
    }
    if (!server) {
      logger.warn(`${LOG_PREFIX} Port range exhausted, fallback to OS-assigned`);
      server = await createEnterpriseCallbackServer(0, session, options);
      port = server.address().port;
    }
  }

  session.server = server;
  session.redirectPort = port;

  session._timeoutHandle = setTimeout(() => {
    logger.warn(`${LOG_PREFIX} Enterprise SSO session timed out`);
    cleanupEnterpriseSession();
  }, ENTERPRISE_SESSION_TIMEOUT_MS);

  activeEnterpriseSession = session;

  // Build portal URL with ALL required parameters matching Kiro-Go reference.
  // - state: anti-CSRF, echoed back by portal
  // - code_challenge: PKCE challenge (for the Cognito social leg)
  // - code_challenge_method: S256
  // - redirect_uri: loopback listener (localhost so the browser resolves it)
  // - redirect_from: KiroIDE — client tag the portal expects
  const codeChallenge = generateCodeChallenge(session.codeVerifier);
  const redirectUri = `http://localhost:${port}`;
  const portalUrl = `https://app.kiro.dev/signin?state=${encodeURIComponent(session.state)}&code_challenge=${codeChallenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(redirectUri)}&redirect_from=KiroIDE`;

  logger.info(`${LOG_PREFIX} Opening browser: ${portalUrl}`);
  try { await redirectBrowser(portalUrl); } catch { logger.warn(`${LOG_PREFIX} Failed to open browser automatically`); }

  return {
    success: true,
    authUrl: portalUrl,
    port,
    state: session.state,
    authInfo: {
      provider: 'claude-kiro-oauth',
      authMethod: 'external_idp',
      port,
      state: session.state,
    },
    message: 'Browser opened to Kiro portal sign-in. Sign in with your Microsoft 365 enterprise account.',
  };
}

// ---------------------------------------------------------------------------
// Token Refresh  (T023, T024, T026) -- Phase 4
// ---------------------------------------------------------------------------

/**
 * Refresh an enterprise account's access token.
 * Uses OAuth2 refresh_token grant against the Microsoft token endpoint.
 *
 * @param {object} credential - Stored enterprise credential object
 * @returns {Promise<{ accessToken: string, refreshToken?: string, expiresIn: number }>}
 */
export async function refreshEnterpriseToken(credential) {
  if (!credential || !credential.tokenEndpoint) {
    throw new Error('Invalid enterprise credential: missing tokenEndpoint');
  }

  // Validate endpoint at refresh time (defense-in-depth against file tampering, T035)
  const validation = validateExternalIdpEndpoint(credential.tokenEndpoint);
  if (!validation.valid) {
    throw new Error(`Token endpoint rejected by allow-list at refresh: ${validation.reason}`);
  }

  if (!credential.refreshToken) {
    throw new Error('Invalid enterprise credential: missing refreshToken');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: credential.refreshToken,
    client_id: credential.clientId,
    scope: credential.scopes || 'openid profile email offline_access',
  }).toString();

  let lastError;
  for (let attempt = 0; attempt <= MAX_REFRESH_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = REFRESH_BACKOFF_BASE_MS * Math.pow(4, attempt - 1);
      logger.info(`${LOG_PREFIX} Refresh retry ${attempt}/${MAX_REFRESH_RETRIES} after ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }

    try {
      const response = await fetchWithProxy(credential.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }, 'kiro-enterprise');

      if (response.ok) {
        const data = await response.json();
        if (!data.access_token) {
          throw new Error('Refresh response missing access_token');
        }
        return {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresIn: data.expires_in || 3600,
        };
      }

      // Auth errors: fail immediately, no retry
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Auth error (HTTP ${response.status}) — credential invalidated`);
      }

      const errorBody = await response.text();
      const parsed = tryParseJson(errorBody);
      if (parsed && parsed.error === 'invalid_grant') {
        throw new Error('Auth error: invalid_grant — credential invalidated');
      }

      // Transient errors: retry
      if (response.status >= 500 || response.status === 429) {
        lastError = new Error(`Transient error (HTTP ${response.status}) — ${errorBody}`);
        continue;
      }

      throw new Error(`Refresh failed: HTTP ${response.status} — ${errorBody}`);

    } catch (err) {
      // Re-throw auth errors immediately
      if (err.message.includes('invalidated') || err.message.includes('Auth error')) {
        throw err;
      }
      // Network/timeout errors are transient — retry
      lastError = err;
    }
  }

  throw new Error(`Refresh failed after ${MAX_REFRESH_RETRIES + 1} attempts: ${lastError ? lastError.message : 'unknown error'}`);
}

/**
 * Try to parse a string as JSON. Returns null on failure.
 * @param {string} str
 * @returns {object|null}
 */
function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Enterprise Credential Import  (T029-T031, US3)
// ---------------------------------------------------------------------------

/**
 * Validate an enterprise credential object for import.
 * @param {object} credential
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateEnterpriseCredential(credential) {
  if (!credential || typeof credential !== 'object') {
    return { valid: false, reason: 'Credential must be a non-null object' };
  }

  if (!credential.tokenEndpoint || typeof credential.tokenEndpoint !== 'string') {
    return { valid: false, reason: 'Missing or invalid tokenEndpoint' };
  }
  const endpointValidation = validateExternalIdpEndpoint(credential.tokenEndpoint);
  if (!endpointValidation.valid) {
    return { valid: false, reason: `tokenEndpoint rejected: ${endpointValidation.reason}` };
  }

  if (!credential.refreshToken || typeof credential.refreshToken !== 'string') {
    return { valid: false, reason: 'Missing or invalid refreshToken' };
  }

  if (!credential.clientId || typeof credential.clientId !== 'string') {
    return { valid: false, reason: 'Missing or invalid clientId' };
  }

  if (credential.expiresAt !== undefined) {
    const ts = new Date(credential.expiresAt).getTime();
    if (isNaN(ts) || ts <= 0) {
      return { valid: false, reason: 'expiresAt must be a positive timestamp' };
    }
  }

  return { valid: true };
}

/**
 * Import an enterprise credential: validate, test-refresh, then save.
 * @param {object} credential - Raw credential object from user input
 * @returns {Promise<{ success: boolean, path?: string, error?: string }>}
 */
export async function importEnterpriseCredential(credential) {
  // Step 1: Validate
  const validation = validateEnterpriseCredential(credential);
  if (!validation.valid) {
    return { success: false, error: validation.reason };
  }

  // Step 2: Test-refresh to verify the credential is live (T030)
  try {
    const result = await refreshEnterpriseToken({
      tokenEndpoint: credential.tokenEndpoint,
      refreshToken: credential.refreshToken,
      clientId: credential.clientId,
      scopes: credential.scopes,
    });

    // Use the refreshed tokens for the saved credential
    credential.accessToken = result.accessToken;
    if (result.refreshToken) {
      credential.refreshToken = result.refreshToken;
    }
    credential.expiresAt = new Date(Date.now() + (result.expiresIn || 3600) * 1000).toISOString();
  } catch (err) {
    return { success: false, error: `Test refresh failed: ${err.message}` };
  }

  // Step 3: Save (T031)
  try {
    const credPath = await saveEnterpriseCredential(credential);

    // Step 4: Auto-link to provider pool
    try {
      const { autoLinkProviderConfigs } = await import('../services/service-manager.js');
      await autoLinkProviderConfigs(CONFIG, { onlyCurrentCred: true, credPath });
    } catch (linkErr) {
      logger.warn(`${LOG_PREFIX} Import auto-link warning: ${linkErr.message}`);
    }

    return { success: true, path: credPath };
  } catch (err) {
    return { success: false, error: `Save failed: ${err.message}` };
  }
}