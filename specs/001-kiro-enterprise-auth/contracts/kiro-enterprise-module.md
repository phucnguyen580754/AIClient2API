# Contract: kiro-enterprise.js -- Enterprise IdP Module

**Module Path**: `src/auth/kiro-enterprise.js`

**Purpose**: Encapsulates all enterprise identity provider logic for Kiro SSO -- OIDC discovery, PKCE generation, token exchange against Microsoft Entra ID, endpoint validation, and token refresh. This module has no direct HTTP route bindings; it exports pure async functions consumed by `kiro-oauth.js` and `oauth-api.js`.

## Exported Functions

### `startEnterpriseSSO(options)`

Initiates the enterprise SSO flow. Opens the Kiro portal sign-in page, then handles both legs of the flow.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `options.port` | number | no | Explicit port for loopback server (optional, scanned otherwise) |
| `options.region` | string | no | Kiro region (default: `"us-east-1"`) |
| `options.saveToConfigs` | boolean | no | Save credentials into `configs/kiro/` (default: true) |

**Returns:** `Promise<{ success: boolean, credential: EnterpriseCredential | null, error?: string }>`

**Side Effects:**
- Starts local HTTP server on `127.0.0.1`
- Opens browser to Kiro portal
- On success: resolves profile ARN via `resolveProfileArn`, saves credential file (including `profileArn`), auto-links to provider pool
- On failure/abandon: no partial save, cleans up server

**Errors:**
- `"Already in progress"` -- if another SSO session is active
- `"Timeout"` -- if no callback received within 10 minutes
- `"IdP validation failed"` -- if endpoint allow-list validation fails
- `"Network error"` -- if unable to reach IdP endpoints
- `"Token exchange failed"` -- if Microsoft token endpoint returns error

---

### `exchangeExternalIdpCode(tokenEndpoint, code, codeVerifier, redirectUri, clientId)`

Exchanges an authorization code for tokens at the Microsoft Entra ID token endpoint.

**Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `tokenEndpoint` | string | Microsoft token endpoint URL |
| `code` | string | Authorization code from Microsoft redirect |
| `codeVerifier` | string | PKCE code verifier used in the auth request |
| `redirectUri` | string | Redirect URI used in the auth request |
| `clientId` | string | Azure AD client ID |

**Returns:** `Promise<{ accessToken: string, refreshToken: string, expiresIn: number }>`

**Request format:**
```
POST {tokenEndpoint}
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code={code}
&redirect_uri={redirectUri}
&client_id={clientId}
&code_verifier={codeVerifier}
```

**Validation:** Validates `tokenEndpoint` against allow-list before POST.

---

### `refreshEnterpriseToken(credential)`

Refreshes an enterprise account's access token using the OAuth2 refresh_token grant.

**Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `credential` | EnterpriseCredential | The stored enterprise credential object |

**Returns:** `Promise<{ accessToken: string, refreshToken?: string, expiresIn: number }>`

**Request format:**
```
POST {credential.tokenEndpoint}
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token={credential.refreshToken}
&client_id={credential.clientId}
&scope={credential.scopes}
```

**Retry behavior:** 3 retries with exponential backoff (1s/4s/16s) on transient errors (5xx/network). Auth errors (401/403/`invalid_grant`) fail immediately -- no retry.

**Validation:** Validates `tokenEndpoint` against allow-list before each POST (defense-in-depth).

---

### `oidcDiscover(issuerUrl)`

Performs OIDC discovery against the issuer to obtain authorization and token endpoints.

**Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `issuerUrl` | string | OIDC issuer URL (e.g., `https://login.microsoftonline.com/<tenant>/v2.0`) |

**Returns:** `Promise<{ authorizationEndpoint: string, tokenEndpoint: string, issuer: string }>`

**Flow:**
1. GET `{issuerUrl}/.well-known/openid-configuration`
2. Parse JSON response for `authorization_endpoint`, `token_endpoint`, `issuer`
3. Validate both endpoints against allow-list
4. Validate `issuer` matches `issuerUrl`

**Errors:**
- `"Issuer URL rejected by allow-list"` -- if issuer host is not allowed
- `"Discovered endpoint rejected by allow-list"` -- if discovered endpoint host is not allowed
- `"OIDC discovery failed"` -- if HTTP error or invalid response

**Security note:** This function MUST NOT follow HTTP redirects during discovery (prevents SSRF bounce attacks). Redirects are disabled.

---

### `validateExternalIdpEndpoint(endpointUrl)`

Validates an external IdP endpoint URL against the allow-list.

**Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `endpointUrl` | string | The endpoint URL to validate |

**Returns:** `{ valid: boolean, reason?: string }`

**Validation rules:**
- Must be HTTPS
- Host must not be an IP literal
- Host must match one of the allowed suffixes:
  - `*.microsoftonline.com`
  - `*.microsoftonline.us`
  - `*.microsoftonline.cn`
  - Plus any configured additional suffixes

---

### `getExternalIdpAllowList()`

Returns the current allow-list configuration.

**Returns:** `string[]` -- Array of allowed host suffixes.

**Behavior:**
- Always includes hardcoded defaults
- Merges any additional suffixes from `configs/kiro/external-idp-allow-list.json` (if file exists)

---

### `extractEmailFromIdToken(idToken)`

Extracts the user's email from a Microsoft Entra ID JWT (id_token).

**Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `idToken` | string | Base64url-encoded JWT from Microsoft |

**Returns:** `string | null` -- Email address or null if not found.

**Claim resolution order:**
1. `email` claim
2. `preferred_username` claim
3. `upn` claim

---

### `detectEnterpriseAuthAlias(authMethod)`

Detects whether an auth method string refers to enterprise auth.

**Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `authMethod` | string | The auth method value from a credential or import |

**Returns:** `string | null` -- Returns `"external_idp"` if matched, null otherwise.

**Recognized aliases:**
- `"external_idp"` -- canonical
- `"azuread"`, `"entra"`, `"microsoft"`, `"m365"`, `"office365"` -- accepted on import

---

### `resolveProfileArn(accessToken, region, isExternalIdp)`

Resolves the CodeWhisperer/Amazon Q profile ARN for a newly-obtained token.

**Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `accessToken` | string | Bearer token from the token exchange |
| `region` | string | AWS region for the ListAvailableProfiles call (e.g., `"us-east-1"`) |
| `isExternalIdp` | boolean | Must be `true` to send the `TokenType: EXTERNAL_IDP` header |

**Returns:** `Promise<string>` -- The resolved profile ARN (e.g., `"arn:aws:codewhisperer:us-east-1:...:profile/..."`)

**Behavior:**
- Sends POST to `q.<region>.amazonaws.com` with `X-Amz-Target: AmazonCodeWhispererService.ListAvailableProfiles`
- When `isExternalIdp=true`, adds `TokenType: EXTERNAL_IDP` header (mandatory for enterprise tokens -- without it, CodeWhisperer returns empty profiles)
- Validates the CodeWhisperer endpoint host against allow-list before request
- On failure: falls back to `us-east-1` (canonical control region) before giving up
- Returns the first profile ARN from the response array

## Non-Exported (Internal) Functions

These are implementation details not exposed outside the module:

| Function | Purpose |
|----------|---------|
| `generatePKCE()` | Creates code verifier (random bytes) and challenge (SHA-256 base64url) |
| `generateState()` | Creates anti-CSRF state parameter (crypto random hex) |
| `redirectBrowser(url)` | Opens the system browser to the specified URL |
| `loadAllowListConfig()` | Loads additional suffixes from config file |
| `parseJwtPayload(token)` | Decodes and parses base64url JWT payload without verification |
| `buildMicrosoftAuthUrl(issuerUrl, clientId, redirectUri, codeChallenge, state, scopes)` | Builds the Microsoft Entra ID authorize URL |

## Integration Contract

### With kiro-oauth.js

`kiro-oauth.js` imports and calls:
```js
import {
  startEnterpriseSSO,
  refreshEnterpriseToken,
  detectEnterpriseAuthAlias,
  validateExternalIdpEndpoint
} from './kiro-enterprise.js';
```

- `handleKiroOAuth()` dispatches `method: 'external_idp'` to `startEnterpriseSSO()`
- `refreshKiroToken()` checks `authMethod` -- enterprise tokens dispatched to `refreshEnterpriseToken()`
- `importAwsCredentials()` -- unchanged (Builder ID only)
- Batch import -- new function or extended stream handler detects enterprise tokens via `detectEnterpriseAuthAlias()`

### With oauth-api.js

- `handleGenerateAuthUrl` -- passes `options.method: 'external_idp'` for enterprise SSO
- `handleManualOAuthCallback` -- may need to handle enterprise callback (2nd leg) if manual callback used
- `handleBatchImportKiroTokens` -- may need to detect enterprise tokens and handle differently

### With claude-kiro.js (provider adapter)

- `_doTokenRefresh()` -- add case for `authMethod === 'external_idp'`, call `refreshEnterpriseToken()`
- `loadCredentials()` -- already field-based; new fields (`tokenEndpoint`, `issuerUrl`, `scopes`, `authMethod`, `provider`) auto-populate

### With service-manager.js

- Existing auto-linking works unchanged -- new credential files in `configs/kiro/` are auto-detected by the Kiro pattern matching
- Provider pool entry may optionally include new fields for display purposes
