# Research: Kiro Enterprise Auth -- Microsoft 365 Organization Login Support

**Phase 0** | **Date**: 2026-07-09 | **Spec**: [spec.md](./spec.md)

## Overview

Phase 0 research evaluates all unknowns from the Technical Context section and ensures the design phase has complete information. The feature spec (`spec.md`) was generated with no remaining [NEEDS CLARIFICATION] markers -- all ambiguities were resolved during the `/speckit-clarify` session. This research focuses on verifying patterns and confirming implementation feasibility against the existing codebase.

## Technical Context Validation

### Language/Version: JavaScript (Node.js 18+, ES modules)

**Decision**: Confirmed -- JavaScript with ES modules (import/export syntax used throughout `src/auth/`).

**Rationale**: The project uses ES module syntax (`import`/`export`) throughout `src/auth/kiro-oauth.js` and related files. No TypeScript or transpilation step is involved. Node.js 18+ provides native `fetch`, `crypto.subtle`, and `http` modules needed for OIDC flows.

### Primary Dependencies: None new

**Decision**: No new dependencies required.

**Rationale**: The existing codebase already has:
- `http` / `https` (built-in) -- for the loopback callback listener and OIDC discovery
- `crypto` (built-in) -- for PKCE code verifier/challenge generation (SHA-256)
- `fetchWithProxy` (axios-based) -- for outbound HTTP requests with proxy support, used in kiro-oauth.js
- Form-encoded POST is standard HTTP -- no library needed

### Storage: Filesystem credential JSON files

**Decision**: Extend existing per-file JSON format.

**Rationale**: The existing credential storage pattern stores one credential per directory under `configs/kiro/<timestamp>_kiro-auth-token/`. Each directory contains JSON files. The new enterprise credential fields (`tokenEndpoint`, `issuerUrl`, `scopes`, `authMethod`, `provider`) will be added to the same JSON structure alongside existing fields. No database migration is needed.

Enterprise credential JSON structure:
```json
{
  "authMethod": "external_idp",
  "provider": "AzureAD",
  "tokenEndpoint": "https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token",
  "issuerUrl": "https://login.microsoftonline.com/<tenant>/v2.0",
  "scopes": "openid profile email offline_access https://api.kiro.dev/.default",
  "clientId": "<azure-app-client-id>",
  "accessToken": "<current-bearer-token>",
  "refreshToken": "<refresh-token>",
  "expiresAt": 1234567890
}
```

### Testing: Manual verification

**Decision**: Manual verification through admin panel UI.

**Rationale**: The project has no automated test suite for auth flows. Enterprise SSO involves browser interaction (OIDC redirect) and external IdP endpoints (Microsoft Entra ID), making end-to-end automation complex. Verification will follow the quickstart guide scenarios.

### Target Platform: Cross-platform Node.js

**Decision**: Confirmed -- Windows/Linux/MacOS.

**Rationale**: The project is already cross-platform. The loopback listener binds to `127.0.0.1` and all dependencies are platform-independent.

### Performance Goals

**Decision**: Login < 5 min, token refresh < 3 seconds.

**Rationale**: Login time is dominated by user browser interaction (email entry, Microsoft login page, MFA if configured). The 10-minute SSO session timeout (from FR1) provides a comfortable bound. Token refresh is a single HTTP POST to the Microsoft token endpoint.

### Constraints

**Decision**: All constraints are clearly defined in the spec.

**Rationale**: 
- Loopback on 127.0.0.1: confirmed as existing pattern from kiro-oauth.js
- Single active session: clarified choice (option B)
- Allow-list validation: SSRF protection (default: `*.microsoftonline.com`, `*.microsoftonline.us`, `*.microsoftonline.cn`)
- HTTPS required, IP literals rejected: from Kiro-Go reference implementation

### Scale/Scope

**Decision**: Single-user admin panel, multiple concurrent Kiro accounts.

**Rationale**: AIClient2API is a single-user application. Multiple Kiro accounts (social + enterprise from different tenants) can coexist in the credential pool.

## Architecture Patterns (from existing codebase)

### Loopback Callback Server

The existing social auth creates a local HTTP server that accepts the OAuth redirect. Key patterns:

1. Server binds to `127.0.0.1` on a random high port
2. A `http.createServer()` handles the single callback route
3. The server parses the URL query parameters to extract the authorization code
4. It shuts down after receiving the callback or on timeout (10 minutes)
5. Port selection uses OS-assigned random port (port 0)

### Credential File Management

Credentials are saved as individual JSON files in:
`configs/kiro/<timestamp>_kiro-auth-token/<credential-id>.json`

Writing new credentials replaces existing files atomically (write to temp, rename).

### Auth Handler Dispatch

`handleKiroOAuth(options)` dispatches by `options.method`:
- `'google'` / `'github'` --> `handleKiroSocialAuth()`
- `'builder-id'` --> `handleKiroBuilderIDDeviceCode()`
- New: `'external_idp'` --> to be implemented

### Token Refresh Dispatch

`refreshKiroToken()` currently only handles social tokens via Kiro's social refresh endpoint. Enterprise tokens require a separate code path that calls the Microsoft token endpoint with `grant_type=refresh_token`.

## Credential Import Validation

The existing import flow validates credential JSON fields. For enterprise credentials:
1. Detect `authMethod: "external_idp"` (or alias: `azuread`, `entra`, `microsoft`, `m365`, `office365`)
2. Validate `tokenEndpoint` against allow-list
3. Perform a test refresh to verify the credential is live
4. Only persist on successful validation

## Security Validation Pattern

Following Kiro-Go's reference implementation:
- Allow-list: `*.microsoftonline.com`, `*.microsoftonline.us`, `*.microsoftonline.cn`
- HTTPS required for all external IdP endpoints
- IP literal hosts rejected
- Apply validation to: issuer URL, discovered authorize/token endpoints, user-supplied token endpoint
- Outbound POST boundary validation (validate endpoint at request time too, in case credential file is manually modified)

## Key Reference Files

| File | Purpose |
|------|---------|
| `src/auth/kiro-oauth.js` | Existing Kiro auth -- add enterprise dispatch + refresh |
| `src/auth/kiro-enterprise.js` | NEW -- enterprise OIDC flow, token exchange, validation |
| `src/ui-modules/oauth-api.js` | Route handler -- add enterprise auth URL + manual callback |
| `src/services/service-manager.js` | Account linking for enterprise credentials |
| `C:\Apps\Kiro-Go\auth\kiro_sso.go` | Reference implementation (Go) -- enterprise SSO logic |
| `C:\Apps\Kiro-Go\auth\oidc.go` | Reference implementation (Go) -- token refresh |
