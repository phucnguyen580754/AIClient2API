# Kiro Enterprise Auth — Microsoft 365 Organization Login Support

## Feature Overview

**In short:** Add Microsoft 365 / Entra ID (Azure AD) organization login support to AIClient2API's Kiro authentication system, matching the enterprise SSO capabilities already present in Kiro-Go.

**Why this matters:** Users with Microsoft 365 work/school accounts cannot authenticate to Kiro through AIClient2API today — the app only supports social login (Google/GitHub) and AWS Builder ID. Kiro-Go already handles enterprise IdP flows (external_idp auth method with PKCE OIDC against Microsoft Entra ID), and users expect the same capability in AIClient2API. Without it, enterprise users are forced to use Kiro-Go directly or find workarounds, reducing AIClient2API's value as a unified access point.

**What will change:**
- A new "Microsoft 365 / Enterprise SSO" authentication method in the Kiro login flow
- Support for the two-leg browser SSO flow: Kiro portal → redirect with enterprise IdP descriptor → OIDC PKCE against Microsoft Entra ID → token exchange
- Proper credential storage and refresh for external_idp tokens (refresh against Microsoft token endpoint, not AWS OIDC)
- UI support to view and manage enterprise-linked accounts

---

## Clarifications

### Session 2026-07-09
- Q: Should concurrent SSO login attempts be allowed? → A: Single active session — starting a new login cancels the previous one.
- Q: How should enterprise credentials be stored? → A: Extend the existing per-file credential JSON format with new fields (`tokenEndpoint`, `issuerUrl`, `scopes`, `authMethod`, `provider`).
- Q: Should partial credentials be saved on login failure? → A: No partial saves — never persist anything unless the full token exchange succeeds.
- Q: How should token refresh retries behave? → A: Exponential backoff (1s/4s/16s), max 3 retries on transient errors (5xx/network); auth errors (401/403/invalid_grant) fail immediately.

## User Scenarios & Testing

### Scenario 1: First-time Kiro login with Microsoft 365 organization account

A user with a `user@company.com` Microsoft 365 account wants to add Kiro access through AIClient2API.

1. User navigates to AIClient2API's admin panel → Kiro authentication section
2. User selects "Kiro SSO Login" (or similar entry point)
3. System opens a browser to the Kiro hosted sign-in page (`app.kiro.dev/signin`)
4. User enters their Microsoft 365 email and clicks "Sign in with Microsoft"
5. Kiro portal detects the enterprise domain and sends the IdP descriptor back to the local redirect listener
6. The system redirects the browser to the Microsoft Entra ID login page
7. User authenticates with their Microsoft 365 organization credentials (may include MFA)
8. Microsoft redirects back to the local redirect listener with an authorization code
9. System exchanges the code for tokens via Microsoft's token endpoint
10. Credentials are saved, account appears in the account list with type "Enterprise SSO (Azure AD)"
11. User receives success confirmation

### Scenario 2: Token refresh for enterprise accounts

An existing enterprise account's access token has expired.

1. System detects the token is near or past expiration
2. System uses the stored refresh token against the Microsoft token endpoint (`login.microsoftonline.com/<tenant>/oauth2/v2.0/token`)
3. Microsoft issues a new access token (and optionally rotates the refresh token)
4. System updates stored credentials with new tokens
5. API requests continue to work seamlessly

### Scenario 3: Enterprise credential import (paste JSON)

A user has an existing Kiro enterprise credential export and wants to import it directly.

1. User copies credential JSON containing `authMethod: "external_idp"`, `refreshToken`, `clientId`, `tokenEndpoint`, `scopes`
2. User pastes into the credential import dialog
3. System validates the `tokenEndpoint` against the allow-list (`*.microsoftonline.com`)
4. System performs a refresh against the token endpoint to validate the credential
5. Upon success, credential is persisted with full refresh material
6. Account appears in the list as "Enterprise SSO (Azure AD)"

### Edge Cases

- **Expired/bad refresh token:** Microsoft returns `invalid_grant` → account is disabled with an auth failure message
- **Network restrictions:** Microsoft login endpoints blocked by firewall → graceful error message, no partial credential saved
- **Login abandoned or fails mid-flow:** User closes browser or MFA fails after the first leg → no partial credential is persisted; next login starts fresh
- **Invalid token endpoint:** User pastes a credential with a non-Microsoft token endpoint → rejected at validation
- **Multiple accounts:** User can add multiple enterprise accounts from different tenants
- **Token rotation:** Microsoft may or may not return a new refresh token on each refresh — system handles both cases

---

## Functional Requirements

### FR1: Kiro SSO Browser Login Flow

The system shall support a Kiro-hosted browser SSO login flow that handles both social and enterprise identity providers.

**Acceptance Criteria:**
- A loopback HTTP listener is started on a local port when the user initiates Kiro SSO login
- The listener accepts redirect callbacks from the Kiro portal at `http://localhost:<port>`
- The listener correctly routes social callbacks (authorization code directly) and enterprise callbacks (IdP descriptor → second OIDC leg)
- The system uses PKCE (S256) for all OAuth2 authorization code flows
- Login timeout is enforced (the listener automatically shuts down after 10 minutes)
- The listener is bound to loopback only (127.0.0.1) by default
- Only one active SSO login session is allowed at a time; starting a new login cancels the previous session and frees the port
- After token exchange succeeds, the system resolves the CodeWhisperer profile ARN via `ListAvailableProfiles` with the `TokenType: EXTERNAL_IDP` header before persisting credentials

### FR2: Enterprise IdP Detection and Two-Leg Flow

When the Kiro portal indicates an enterprise identity provider (via `login_option=external_idp` or `issuer_url` parameter), the system shall execute a second OIDC authorization code + PKCE flow against the enterprise IdP.

**Acceptance Criteria:**
- System detects `issuer_url`, `client_id`, `scopes` parameters from the portal callback
- System validates the issuer URL against an allow-list of approved enterprise IdP hosts
- System performs OIDC discovery against the issuer to obtain authorization and token endpoints
- System generates fresh PKCE parameters for the second leg and redirects the browser to the IdP login page
- The second leg callback arrives at a distinct path (e.g., `/oauth/callback`)
- State parameter is validated to prevent CSRF across both legs
- If a single callback contains both social and enterprise parameters simultaneously, enterprise parameters (`login_option=external_idp`, `issuer_url`) take precedence — enterprise leg detection fires first and leg state tracking prevents parameter confusion
- OIDC discovery requests MUST NOT follow HTTP redirects (prevents SSRF bounce attacks)
- The Microsoft authorization URL SHOULD include a `login_hint` parameter pre-filling the user's email if available

### FR3: Secure IdP Endpoint Allow-List

The system shall restrict enterprise IdP endpoints to a configurable allow-list of known enterprise providers.

**Acceptance Criteria:**
- Default allow-list includes `*.microsoftonline.com`, `*.microsoftonline.us`, `*.microsoftonline.cn`
- Validation rejects non-HTTPS URLs
- IP literal hosts are rejected
- Validation is applied to: the OIDC issuer URL, the discovered authorization endpoint, the discovered token endpoint, and any user-supplied token endpoint (credential import)
- The allow-list is hardcoded by default (`*.microsoftonline.com`, `*.microsoftonline.us`, `*.microsoftonline.cn`) but supports an optional config file that adds additional IdP hosts without replacing the defaults.

### FR4: Token Refresh for Enterprise Accounts

The system shall refresh enterprise account tokens using the OAuth2 refresh_token grant against the Microsoft token endpoint, not the AWS SSO OIDC endpoint.

**Acceptance Criteria:**
- Refresh uses the stored `tokenEndpoint` URL and `clientId`
- Request uses `grant_type=refresh_token` with form-encoded body
- Response includes `access_token`, optional `refresh_token`, and `expires_in`
- If Microsoft rotates the refresh token, the new refresh token is stored
- If Microsoft does not return a new refresh token, the existing one is retained
- Auth-level errors (401, 403, `invalid_grant`) disable the account immediately; transient errors (5xx, network timeouts) trigger up to 3 retries with exponential backoff (1s/4s/16s) before disabling

### FR5: Enterprise Credential Storage

The system shall persist all fields needed for enterprise token lifecycle management.

**Acceptance Criteria:**
- Stored fields include: `authMethod: "external_idp"`, `provider: "AzureAD"`, `tokenEndpoint`, `issuerUrl`, `scopes`, `clientId`, `accessToken`, `refreshToken`, `expiresAt`
- Credentials are stored in the existing per-file JSON format (`configs/kiro/`) with the new fields added alongside existing ones
- Account list displays enterprise accounts with their provider label

### FR6: Credential Import for Enterprise Accounts

The system shall accept and validate enterprise credentials via the credential import (paste JSON) feature.

**Acceptance Criteria:**
- Import accepts `authMethod: "external_idp"` or recognized aliases (`azuread`, `entra`, `microsoft`, `m365`, `office365`)
- `tokenEndpoint` is validated against the allow-list before any network request
- A refresh attempt is made to validate the credential before persisting
- Import fails gracefully with clear error messages if validation fails

### FR7: UI Support for Enterprise Auth

The admin panel shall provide clear interface elements for enterprise authentication.

**Acceptance Criteria:**
- The Kiro login method selector includes "Microsoft 365 / Enterprise SSO" as an option  
- Enterprise accounts are displayed with an "Azure AD" or "Enterprise SSO" badge/provider label
- The credential import dialog accepts enterprise credential fields

### FR8: Observability and Secrets Hygiene

The system shall log enterprise auth lifecycle events for debugging while protecting sensitive credential data.

**Acceptance Criteria:**
- SSO lifecycle events are logged: session start, leg transitions (social→enterprise), completion, timeout, cancellation
- SSO failure events are logged with error category (auth error, network error, validation error, timeout) and a human-readable summary
- All sensitive credential fields MUST be redacted in log output, error messages, and diagnostic data: `accessToken`, `refreshToken`, `clientId`, `codeVerifier`, `state`, `authorization_code`
- Non-sensitive fields safe to log: `provider`, `authMethod`, `tokenEndpoint` hostname (not full URL with path/query), `issuerUrl` hostname, error category
- Token refresh events log: credential identifier, success/failure, and retry count (no secrets)
- Log entries must not contain full credential file paths that include timestamps

---

## Key Entities

### Enterprise Credential

- `authMethod: "external_idp"` — identifies the credential type (distinct from `"social"` and `"idc"`)
- `provider: "AzureAD"` — human-readable provider name
- `tokenEndpoint` — Microsoft Entra ID OAuth2 token endpoint URL
- `issuerUrl` — OIDC issuer URL (e.g., `https://login.microsoftonline.com/<tenant>/v2.0`)
- `scopes` — space-separated OAuth2 scopes (includes `offline_access` for refresh)
- `clientId` — Azure AD application (client) ID
- `accessToken` — current bearer token for API calls
- `refreshToken` — token used to obtain new access tokens
- `expiresAt` — access token expiration timestamp
- `profileArn` — CodeWhisperer/Amazon Q profile ARN (resolved after token exchange, e.g., `arn:aws:codewhisperer:us-east-1:...:profile/...`)
- `region` — Kiro region (e.g., `"us-east-1"`); may be resolved from the profile ARN

### Kiro SSO Session

- Transient state for a browser-based sign-in attempt
- Tracks PKCE verifier/challenge, anti-CSRF state, social vs. enterprise leg
- Owns the local loopback HTTP listener
- Self-destructs on timeout (10 min) or completion

### IdP Endpoint Allow-List

- Set of approved host suffixes for enterprise identity providers
- Default entries: `microsoftonline.com`, `microsoftonline.us`, `microsoftonline.cn`
- Used to validate all external IdP endpoints (SSRF protection)

---

## Success Criteria

1. A user with a Microsoft 365 organization account can complete the Kiro SSO login flow end-to-end and start using Kiro API services through AIClient2API within 5 minutes of starting the process.
2. Enterprise account tokens refresh automatically without user intervention; the account remains usable for at least 30 consecutive days without manual re-authentication.
3. All credential imports with valid `external_idp` objects succeed; all imports with forged or malicious `tokenEndpoint` values are rejected with a clear error.
4. The system correctly distinguishes enterprise accounts from social and Builder ID accounts in the admin panel UI.
5. Users can add multiple enterprise accounts from different Azure AD tenants concurrently.

---

## Assumptions

- The Kiro hosted sign-in portal (`app.kiro.dev/signin`) and its enterprise IdP detection behavior remain stable and compatible with the existing Kiro-Go implementation.
- The loopback redirect listener approach (bind to `127.0.0.1:<port>`) works for the majority of users; users in containerized environments may need alternative setup guidance.
- The Microsoft Entra ID OIDC endpoints follow the standard `openid-configuration` discovery protocol.
- The existing Kiro social token refresh endpoint (`prod.us-east-1.auth.desktop.kiro.dev/refreshToken`) remains unchanged.
- Enterprise account users will have the `offline_access` scope granted by their Azure AD admin to enable token refresh.

---

## Dependencies

- Kiro hosted sign-in portal (`app.kiro.dev/signin`) — external dependency, no control over changes
- Microsoft Entra ID / Azure AD OIDC endpoints — external dependency, follows Microsoft's release schedule
- Existing AIClient2API credential storage and service-manager infrastructure — must remain backward-compatible

---

## Out of Scope

- Adding new enterprise IdPs beyond Microsoft 365 / Entra ID (Google Workspace, Okta, etc.) — the allow-list could be extended later, but implementation and testing for each IdP is separate work
- Modifying the Kiro API proxy behavior or the underlying AWS CodeWhisperer protocol
- Building a fully headless/CLI-only enterprise login flow (browser interaction is required for OIDC)
- Credential migration from Kiro-Go's config format to AIClient2API's format
