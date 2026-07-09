# Data Model: Kiro Enterprise Auth -- Microsoft 365 Organization Login Support

**Phase 1** | **Date**: 2026-07-09 | **Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

## Entities

### EnterpriseCredential

Stored as a JSON file in `configs/kiro/<timestamp>_kiro-auth-token/`. Represents a single enterprise Kiro account linked to a Microsoft 365 organization.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `authMethod` | string | yes | Always `"external_idp"` -- distinguishes from `"social"` and `"builder-id"` |
| `provider` | string | yes | Always `"AzureAD"` -- human-readable IdP label |
| `tokenEndpoint` | string | yes | Microsoft Entra ID OAuth2 token endpoint URL (e.g., `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`) |
| `issuerUrl` | string | yes | OIDC issuer URL (e.g., `https://login.microsoftonline.com/<tenant>/v2.0`) |
| `scopes` | string | yes | Space-separated OAuth2 scopes (e.g., `"openid profile email offline_access https://api.kiro.dev/.default"`) |
| `clientId` | string | yes | Azure AD application (client) ID |
| `accessToken` | string | yes | Current bearer token for Kiro API calls |
| `refreshToken` | string | yes | Token to obtain new access tokens (requires `offline_access` scope) |
| `expiresAt` | number | yes | Unix timestamp (ms) when `accessToken` expires |
| `profileArn` | string | no | CodeWhisperer/Amazon Q profile ARN resolved after token exchange (e.g., `"arn:aws:codewhisperer:us-east-1:...:profile/..."`) |
| `region` | string | no | Kiro region (e.g., `"us-east-1"`) -- resolved from the profile ARN when available; falls back to user-configured or default |

**Validation Rules:**
- `authMethod` must be exactly `"external_idp"` (aliases `azuread`, `entra`, `microsoft`, `m365`, `office365` accepted on import, normalized to `"external_idp"`)
- `tokenEndpoint` host must match allow-list (`*.microsoftonline.com`, `*.microsoftonline.us`, `*.microsoftonline.cn`)
- `tokenEndpoint` must use HTTPS
- `tokenEndpoint` host must not be an IP literal
- `refreshToken` must be non-empty
- `clientId` must be non-empty
- `expiresAt` must be a positive number (future timestamp when valid)

### KiroSSOSession

Transient state (in-memory only) for a browser-based enterprise sign-in attempt.

| Field | Type | Description |
|-------|------|-------------|
| `codeVerifier` | string | PKCE code verifier (crypto random, 43-128 chars) |
| `codeChallenge` | string | PKCE code challenge (SHA-256 base64url of verifier) |
| `codeChallengeMethod` | string | Always `"S256"` |
| `state` | string | Anti-CSRF state parameter, used across both legs |
| `redirectPort` | number | Port the local loopback server is listening on |
| `server` | http.Server | The loopback HTTP server reference |
| `startedAt` | number | Timestamp when session was created |
| `loginUrl` | string | The Kiro portal sign-in URL that was opened in the browser |
| `leg` | string | `"social"` (waiting for first callback) or `"enterprise"` (waiting for IdP callback) |

**State Transitions:**
1. `Created` -- Session initialized, PKCE generated, loopback server started
2. `FirstLegWaiting` -- Browser opened to Kiro portal, waiting for redirect
3. `IdPDiscovered` -- Kiro portal returned enterprise IdP descriptor (issuer_url, client_id, scopes)
4. `SecondLegWaiting` -- Browser redirected to Microsoft login, waiting for auth code
5. `TokenExchanging` -- Auth code received, exchanging for tokens at Microsoft token endpoint
6. `Completed` -- Tokens received and saved, session cleaned up
7. `Failed` -- Any error or timeout, session cleaned up, nothing persisted

**Session Cleanup:**
- On completion: close server, delete from active sessions map
- On timeout (10 min): close server, delete from map
- On cancellation (new login started): close previous server, delete from map
- On failure: close server, delete from map, no partial save

### IdPEndpointAllowList

Configuration for SSRF protection -- defines which enterprise IdP endpoints are allowed.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `suffixes` | string[] | `[".microsoftonline.com", ".microsoftonline.us", ".microsoftonline.cn"]` | Host suffixes that are allowed for IdP endpoints |

**Configuration:**
- Hardcoded defaults always active
- Optional config file: `configs/kiro/external-idp-allow-list.json` with `{ "additionalSuffixes": [".customidp.com"] }`
- Additional suffixes are merged with defaults, not replaced
- Validation checks: hostname ends with allowed suffix, uses HTTPS, not an IP literal

**Endpoints validated against allow-list:**
- OIDC issuer URL (from Kiro portal callback)
- Discovered authorization endpoint (from OIDC discovery)
- Discovered token endpoint (from OIDC discovery)
- User-supplied token endpoint (credential import)
- Token endpoint at refresh time (defense-in-depth against file tampering)

## Credential File Structure

### File Path Pattern
```
configs/kiro/<timestamp>_kiro-auth-token/<timestamp>_kiro-auth-token.json
```

*Example:*
```
configs/kiro/1720521600000_kiro-auth-token/1720521600000_kiro-auth-token.json
```

### File Content (Enterprise Credential Example)
```json
{
  "authMethod": "external_idp",
  "provider": "AzureAD",
  "tokenEndpoint": "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token",
  "issuerUrl": "https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0",
  "scopes": "openid profile email offline_access https://api.kiro.dev/.default",
  "clientId": "550e8400-e29b-41d4-a716-446655440000",
  "accessToken": "eyJhbGciOiJSUzI1NiIsImtpZCI6Ii4uLiJ9...",
  "refreshToken": "0.ARoAQ4S6X-TxGzPq7Yz...",
  "expiresAt": 1720608000000,
  "profileArn": "arn:aws:codewhisperer:us-east-1:123456789012:profile/kiro-enterprise-user",
  "region": "us-east-1"
}
```

## State Machine: Enterprise SSO Login Flow

```
[Start] --> Generate PKCE (S256)
         --> Generate anti-CSRF state
         --> Start loopback server on 127.0.0.1:<port> (IPv4 only, IPv6 ::1 excluded)
         --> Open browser to app.kiro.dev/signin?redirect_uri=http://127.0.0.1:<port>
         --> Wait for callback (10 min timeout)
         
[Callback received]
         |-- Check: login_option=external_idp AND issuer_url present?
         |     YES --> [Enterprise leg]
         |              Validate issuer_url against allow-list
         |              OIDC discovery on issuer_url/.well-known/openid-configuration
         |              Validate discovered endpoints against allow-list
         |              Build Microsoft redirect URL with PKCE
         |              Redirect browser to Microsoft login
         |              Change leg state to "enterprise"
         |              Wait for second callback (10 min timeout)
         |
         |     NO  --> [Social leg - existing behavior, unchanged]
         |              Exchange code for token via Kiro endpoint
         
[Second callback received (enterprise leg)]
         --> Validate state parameter (CSRF check)
         --> Extract authorization code from query params
         --> Exchange code at Microsoft token endpoint:
             POST {tokenEndpoint}
             Content-Type: application/x-www-form-urlencoded
             Body: grant_type=authorization_code
                   &code={authorization_code}
                   &redirect_uri=http://127.0.0.1:<port>/oauth/callback
                   &client_id={clientId}
                   &code_verifier={codeVerifier}
         --> Parse response: access_token, refresh_token, expires_in
         --> Build credential object
         --> Resolve CodeWhisperer profile ARN via ListAvailableProfiles (TokenType: EXTERNAL_IDP)
         --> Prefer region from profile ARN over user-configured region
         --> Save to configs/kiro/<timestamp>_kiro-auth-token/
         --> Auto-link credential to provider pool
         --> Cleanup session
         --> Return success
```

## Relationships

```
EnterpriseCredential --[saved in]--> configs/kiro/<dir>/ (many credentials, 1 credential per dir)
KiroSSOSession --[creates]--> EnterpriseCredential (1 session produces 1 credential on success)
IdPEndpointAllowList --[validates]--> tokenEndpoint (many-to-one: allow-list validates all endpoints)
```

## Data Flow: Token Refresh

```
[Timer or API call triggers refresh]
         |
         v
Read credential file (JSON)
         |
         v
Check authMethod == "external_idp"?
         |
    YES  v      NO  --> Use existing social or Builder ID refresh path
         |
Validate tokenEndpoint against allow-list (defense-in-depth)
         |
         v
POST {tokenEndpoint}
Content-Type: application/x-www-form-urlencoded
Body: grant_type=refresh_token
      &refresh_token={refreshToken}
      &client_id={clientId}
      &scope={scopes}
         |
         v
<response 200>              <response 4xx>              <response 5xx/network error>
Parse response              Disable account             Retry (exp backoff)
Store new tokens             (auth failure)              1s -> 4s -> 16s
If new refresh_token:                                              |
  store it                      [END]                      <all fail>
If no new refresh_token:                                          |
  retain existing                                                 [Disable account]
Update credential file
Mark account healthy
         |
         v
If profileArn carries a different region, prefer it for subsequent API calls
         |
         v
[END]
```

## Data Flow: Credential Import

```
[User pastes JSON]
         |
         v
Parse JSON
         |
         v
Detect authMethod == "external_idp" or alias?
         |
    YES  v      NO  --> Route to existing social or Builder ID import
         |
Validate tokenEndpoint against allow-list
         |
         v
Perform test refresh:
POST {tokenEndpoint} with grant_type=refresh_token
         |
     <success>                <failure>
         |                        |
Validate response              Return error message
has valid tokens                (no partial save)
         |
         v
Save credential to configs/kiro/
Auto-link to provider pool
Return success
```
