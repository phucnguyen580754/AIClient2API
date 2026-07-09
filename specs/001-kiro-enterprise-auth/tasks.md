# Tasks: Kiro Enterprise Auth -- Microsoft 365 Organization Login Support

**Input**: Design documents from `/specs/001-kiro-enterprise-auth/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/kiro-enterprise-module.md

**Tests**: Not requested in specification; verification per quickstart.md manual scenarios

**Organization**: Tasks grouped by user story (US1-P1, US2-P2, US3-P3) for independent implementation and testing.

## Format: `[ID] [P?] [Story] Description with file path`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: User story from spec.md (US1 = P1 login flow, US2 = P2 token refresh, US3 = P3 credential import)
- Include exact file paths in descriptions

## Implementation Strategy

**MVP** = US1 (P1 Enterprise SSO Login). Everything else builds on the credential file and module foundation laid by US1. Implement in order: US1 first (produces a working login), then US2 (keeps accounts alive), then US3 (import convenience). The UI label changes (FR7) are cross-cutting and done progressively.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the new enterprise auth module backbone and shared utilities.

- [X] T001 Create `src/auth/kiro-enterprise.js` with module skeleton, exports map, and file header documenting the 8 public functions per contract
- [X] T002 [P] Add enterprise auth constants in `src/auth/kiro-enterprise.js`: `ALLOWED_IDP_SUFFIXES` (`.microsoftonline.com`, `.microsoftonline.us`, `.microsoftonline.cn`), `ENTERPRISE_SESSION_TIMEOUT_MS` (600000), `MAX_REFRESH_RETRIES` (3), `REFRESH_BACKOFF_BASE_MS` (1000)
- [X] T003 [P] Implement PKCE helper functions in `src/auth/kiro-enterprise.js`: `generateCodeVerifier()` (crypto random 64 bytes, base64url), `generateCodeChallenge(verifier)` (SHA-256 base64url), `generateState()` (crypto random hex 32 bytes)
- [X] T004 [P] Implement `validateExternalIdpEndpoint(endpointUrl)` in `src/auth/kiro-enterprise.js` per contract: HTTPS check, IP literal rejection, host suffix matching against allow-list. Return `{ valid: boolean, reason?: string }`
- [X] T005 [P] Implement `getExternalIdpAllowList()` in `src/auth/kiro-enterprise.js`: return hardcoded defaults merged with any additional suffixes from `configs/kiro/external-idp-allow-list.json` (if file exists)
- [X] T006 [P] Implement `detectEnterpriseAuthAlias(authMethod)` in `src/auth/kiro-enterprise.js`: recognize `external_idp`, `azuread`, `entra`, `microsoft`, `m365`, `office365` and normalize to `"external_idp"`
- [X] T007 Implement `parseJwtPayload(token)` and `extractEmailFromIdToken` in `src/auth/kiro-enterprise.js`: decode base64url JWT payload without signature verification, for email extraction
- [X] T008 Implement `loadAllowListConfig()` in `src/auth/kiro-enterprise.js`: read optional `configs/kiro/external-idp-allow-list.json`, validate + merge with defaults

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: OIDC discovery and token exchange -- needed by both US1 and US2.

- [X] T009 Implement `oidcDiscover(issuerUrl)` in `src/auth/kiro-enterprise.js`: fetch `{issuerUrl}/.well-known/openid-configuration`, parse `authorization_endpoint`, `token_endpoint`, `issuer`, validate all endpoints via `validateExternalIdpEndpoint`, validate issuer match
- [X] T010 Implement `exchangeExternalIdpCode(tokenEndpoint, code, codeVerifier, redirectUri, clientId)` in `src/auth/kiro-enterprise.js`: form-encoded POST to Microsoft token endpoint with `grant_type=authorization_code`, parse response, validate tokenEndpoint via `validateExternalIdpEndpoint` before request
- [X] T011 Implement `extractEmailFromIdToken(idToken)` in `src/auth/kiro-enterprise.js`: parse JWT, extract `email` > `preferred_username` > `upn` claims
- [X] T012 Implement `buildMicrosoftAuthUrl(issuerUrl, clientId, redirectUri, codeChallenge, state, scopes)` in `src/auth/kiro-enterprise.js`: build Microsoft Entra ID authorize URL with PKCE and scope parameters
- [X] T012b [P] Implement `resolveProfileArn(accessToken, region, isExternalIdp)` in `src/auth/kiro-enterprise.js`: call CodeWhisperer `ListAvailableProfiles` API with `TokenType: EXTERNAL_IDP` header (required for enterprise tokens), parse profile ARN from response, implement retry on transient errors. Validate response endpoint host against allow-list

---

## Phase 3: US1 (P1) -- Enterprise SSO Login Flow

**Story goal**: User with Microsoft 365 account can log in via Kiro portal and the two-leg enterprise SSO flow, saving credentials.

**Independent test**: Scenario 1 in quickstart.md -- complete login end-to-end, verify credential file at `configs/kiro/<timestamp>_kiro-auth-token/<timestamp>_kiro-auth-token.json` contains `authMethod: "external_idp"`.

- [X] T013 [US1] Implement `startEnterpriseSSO(options)` in `src/auth/kiro-enterprise.js` -- main orchestration:
  1. Check no active SSO session; if exists, cancel it ("single active session" rule)
  2. Generate PKCE verifier + challenge (S256)
  3. Generate anti-CSRF state
  4. Start loopback HTTP server on `127.0.0.1` (scan port range 19876-19880, fallback OS-assigned port 0)
  5. Build Kiro portal URL: `https://app.kiro.dev/signin?redirect_uri=http://127.0.0.1:<port>`
  6. Open browser to Kiro portal
  7. Handle first callback: detect `login_option=external_idp` and `issuer_url` parameters
  8. If enterprise detected: validate issuer URL via `validateExternalIdpEndpoint`, call `oidcDiscover`, build Microsoft auth URL, redirect browser, wait for second callback
  9. On second callback: validate state, extract code, call `exchangeExternalIdpCode`
  10. On success: resolve profile ARN via `resolveProfileArn`, prefer region from ARN, save credential file (including `profileArn`), auto-link to provider pool
  11. On failure/abandon/timeout: clean up, no partial save

- [X] T014 [US1] Implement loopback callback handler integration in `src/auth/kiro-enterprise.js`: handle enterprise callbacks within the same server. Use leg state tracking (`"firstLeg"` -> `"enterprise"` transition)

- [X] T015 [P] [US1] Add enterprise SSO session tracking in `src/auth/kiro-enterprise.js`: module-level `activeEnterpriseSession` variable, session state machine, 10-minute timeout with auto-cleanup

- [X] T016 [US1] Add `method: 'external_idp'` dispatch in `handleKiroOAuth(options)` in `src/auth/kiro-oauth.js`: if `options.method === 'external_idp'`, call `startEnterpriseSSO(options)` instead of the social or Builder ID handlers

- [X] T017 [P] [US1] Add enterprise login route in `src/ui-modules/oauth-api.js`: handle `options.method = 'external_idp'` in `handleGenerateAuthUrl` (or the relevant Kiro auth URL generation endpoint), pass through to `handleKiroOAuth`

- [X] T018 [P] [US1] Export new functions from `src/auth/index.js`: add `startEnterpriseSSO`, `refreshEnterpriseToken`, `detectEnterpriseAuthAlias`, `validateExternalIdpEndpoint` to the `export { ... } from './kiro-enterprise.js'` block

- [X] T019 [P] [US1] Export new functions from `src/auth/oauth-handlers.js`: re-export the same symbols from `./index.js` for backward compatibility

- [X] T020 [US1] Implement enterprise credential save in `src/auth/kiro-enterprise.js`: create `configs/kiro/<timestamp>_kiro-auth-token/` directory, write JSON with fields per data model

- [X] T021 [US1] Integrate credential auto-linking after enterprise save in `src/auth/kiro-enterprise.js`: call `autoLinkProviderConfigs(CONFIG, { onlyCurrentCred: true, credPath })` and broadcast `oauth_success` event

- [X] T022 [US1] Implement `redirectBrowser(url)` in `src/auth/kiro-enterprise.js`: use `child_process.exec` or `open`-equivalent to open the system browser to the specified URL

---

## Phase 4: US2 (P2) -- Token Refresh for Enterprise Accounts

**Story goal**: Enterprise account tokens refresh automatically against Microsoft token endpoint, not AWS SSO OIDC.

**Independent test**: Scenario 2 in quickstart.md -- verify credential file `expiresAt` updates after refresh, or force refresh by temporarily reducing `expiresAt` value.

- [X] T023 [P] [US2] Implement `refreshEnterpriseToken(credential)` in `src/auth/kiro-enterprise.js`: form-encoded POST `grant_type=refresh_token` to `credential.tokenEndpoint` with `refresh_token`, `client_id`, `scope`. Validate `tokenEndpoint` via `validateExternalIdpEndpoint` before each request

- [X] T024 [US2] Implement retry logic in `refreshEnterpriseToken()` in `src/auth/kiro-enterprise.js`: exponential backoff 1s/4s/16s, max 3 retries. Auth errors (401/403/`invalid_grant`) -> fail immediately. Transient errors (5xx/network) -> retry. Return `{ accessToken, refreshToken?, expiresIn }`

- [X] T025 [US2] Add enterprise dispatch in `_doTokenRefresh()` in `src/providers/claude/claude-kiro.js`: if `this.authMethod === 'external_idp'`, call `refreshEnterpriseToken(credential)` instead of social or IDC refresh paths

- [X] T026 [US2] Handle refresh token rotation in `refreshEnterpriseToken()` in `src/auth/kiro-enterprise.js`: if response includes new `refresh_token`, store it; if absent, keep existing one. Update credential file with new tokens after successful refresh

- [X] T027 [US2] Handle `invalid_grant` from Microsoft in `src/providers/claude/claude-kiro.js`: disable account with auth failure message, no retry (per FR4 spec)

---

## Phase 5: US3 (P3) -- Enterprise Credential Import

**Story goal**: User can paste enterprise credential JSON to import directly.

**Independent test**: Scenarios 3 and 4 in quickstart.md -- valid import succeeds, forged/rejected imports fail gracefully.

- [X] T028 [P] [US3] Add enterprise import handling in `handleBatchImportKiroTokens` in `src/ui-modules/oauth-api.js`: detect `authMethod: "external_idp"` or alias via `detectEnterpriseAuthAlias`, route to enterprise import path instead of social token batch import

- [X] T029 [US3] Implement enterprise credential import validation function in `src/auth/kiro-enterprise.js`: validate `tokenEndpoint` against allow-list, validate `refreshToken` and `clientId` non-empty, validate `expiresAt` positive

- [X] T030 [US3] Implement import test-refresh in `src/auth/kiro-enterprise.js`: call `refreshEnterpriseToken(credential)` to validate the credential is live before persisting. On failure: return clear error, no partial save

- [X] T031 [US3] Save imported enterprise credential in `src/auth/kiro-enterprise.js`: same save pattern as T020 (atomic write, `configs/kiro/`), auto-link to provider pool

---

## Phase 6: Cross-Cutting & Polish

**Purpose**: UI support (FR7), allow-list config, edge case hardening.

- [X] T032 [P] Add "Microsoft 365 / Enterprise SSO" option in the Kiro login method selector in the admin panel UI. Locate the login method dropdown rendering code and add the new option with `method: 'external_idp'`

- [X] T033 [P] Add "Enterprise SSO (Azure AD)" badge/label display for enterprise accounts in the admin panel account list. Locate the account list rendering code that shows `authMethod`/`provider` labels and add `AzureAD` / `Enterprise SSO` formatting

- [X] T034 [P] Implement allow-list config file reading in `src/auth/kiro-enterprise.js`: read `configs/kiro/external-idp-allow-list.json` (if exists), parse `{ "additionalSuffixes": [...] }`, merge with defaults. Handle malformed/missing file gracefully

- [X] T035 Add credential file tampering defense in `src/auth/kiro-enterprise.js`: validate `tokenEndpoint` again via `validateExternalIdpEndpoint` at refresh time (not just import time), since file could be manually edited

- [X] T036 Add session timeout edge case handling in `src/auth/kiro-enterprise.js`: ensure 10-minute timeout fires even if the browser is waiting on the second leg. If first leg completes but second leg never arrives, cleanup after 10 min total

---

## Dependency Graph

```
Phase 1 (T001-T008)   Setup
      |
      v
Phase 2 (T009-T012)   Foundational (OIDC discovery, token exchange)
      |
      +-----------+-----------+
      |           |           |
      v           v           v
Phase 3 (T013-T022) US1     Phase 4 (T023-T027) US2     Phase 5 (T028-T031) US3
Enterprise Login (P1)       Token Refresh (P2)           Credential Import (P3)
      |                       |                            |
      +-----------+-----------+----------------------------+
                  |
                  v
          Phase 6 (T032-T036) Cross-Cutting
          UI labels, allow-list config, edge cases
```

## Parallel Execution Opportunities

| Phase | Parallel Tasks | Reasoning |
|-------|---------------|-----------|
| Phase 1 | T002-T006, T008 | All are independent utility functions in `kiro-enterprise.js`, different exports |
| Phase 2 | T012b | Profile ARN resolution helper -- independent utility |
| Phase 3 | T015, T017, T018, T019, T020 | Session tracking (T015), route handler (T017), exports (T018/T019), credential save (T020) -- all different files |
| Phase 4 | T023 | Refresh function alone -- independent helper |
| Phase 5 | T028 | Import detection hook alone |
| Phase 6 | T032, T033, T034 | UI login option, UI account label, config file -- all independent |

## Task Summary

| Phase | Tasks | Count |
|-------|-------|-------|
| Phase 1: Setup | T001-T008 | 8 |
| Phase 2: Foundational | T009-T012b | 5 |
| Phase 3: US1 (P1) Login Flow | T013-T022 | 10 |
| Phase 4: US2 (P2) Token Refresh | T023-T027 | 5 |
| Phase 5: US3 (P3) Credential Import | T028-T031 | 4 |
| Phase 6: Cross-Cutting | T032-T036 | 5 |
| **Total** | | **37** |

## MVP Scope

Implement Phases 1 + 2 + 3 only (T001-T022 + T012b = 23 tasks). This delivers a working enterprise SSO login flow that produces a valid credential file in `configs/kiro/`. The account is usable until tokens expire. US2 (refresh) and US3 (import) can be added incrementally without touching the login flow.
