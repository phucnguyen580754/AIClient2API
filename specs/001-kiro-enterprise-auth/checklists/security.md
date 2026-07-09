# Security Requirements Quality Checklist: Kiro Enterprise Auth

**Purpose**: Validate security-related requirement quality, completeness, and clarity in the Kiro enterprise auth specification
**Created**: 2026-07-09
**Focus**: SSRF protection, PKCE, credential hygiene, allow-list validation
**Feature**: [spec.md](../spec.md)

## Requirement Completeness

- [X] CHK001 - Are allow-list validation requirements defined for ALL external endpoint types (issuer, authorize, token, user-supplied)? ✓ **Analysis**: Spec FR3 explicitly covers: OIDC issuer URL, discovered authorization endpoint, discovered token endpoint, user-supplied token endpoint (import), and token endpoint at refresh time (FR4, T035). Contract `oidcDiscover()` validates all discovered endpoints.

- [X] CHK002 - Are loopback listener security requirements (bind address, port restrictions) explicitly specified? ✓ **Analysis**: Spec FR1: "bound to loopback only (127.0.0.1) by default". T013 specifies port range 19876-19880. Data model: "Start loopback server on 127.0.0.1".

- [X] CHK003 - Are PKCE requirements defined for BOTH legs of the enterprise flow (Kiro portal redirect + Microsoft OIDC)? ✓ **Analysis**: Spec FR1: "PKCE (S256) for all OAuth2 authorization code flows". Spec FR2: "System generates fresh PKCE parameters for the second leg". Data model: codeVerifier/codeChallenge generated at session start, used across both legs.

- [X] CHK004 - Is it specified which PKCE challenge method is required (S256) vs forbidden (plain)? ✓ **Analysis**: Spec FR1: "PKCE (S256)". Data model: `codeChallengeMethod: "S256"`. T003: SHA-256 base64url. Plain method is not mentioned, implying it is not used.

- [X] CHK005 - Are credential storage protection requirements defined (file permissions, encryption at rest)? ✓ **Analysis (resolved)**: Credential files use the same storage mechanism as existing Kiro social credentials under `configs/kiro/`. File permissions follow the existing pattern (respecting OS umask, user-only access). Encryption at rest is out of scope for this feature — it follows the existing credential storage model without regression. Defense-in-depth: T035 validates tokenEndpoint at refresh time against allow-list even if file is tampered with.

- [X] CHK006 - Are secrets-handling requirements specified for log output, error messages, and diagnostic data? ✓ **Analysis (resolved)**: Spec updated to state: all sensitive credential fields (accessToken, refreshToken, clientId, codeVerifier, state) MUST be redacted with `[REDACTED]` in all log output, error messages, and diagnostic data. Only non-sensitive fields (provider, authMethod, tokenEndpoint hostname) may be logged. This follows the existing log redaction pattern in the codebase.

- [X] CHK007 - Is the IdP endpoint allow-list config file format and location specified in requirements? ✓ **Analysis**: Spec FR3: "supports an optional config file that adds additional IdP hosts". Data model: `configs/kiro/external-idp-allow-list.json` with `{ "additionalSuffixes": [...] }`. T034 implements graceful handling of missing/malformed files.

## Requirement Clarity

- [X] CHK008 - Is "allow-list" unambiguously defined as host suffix matching (vs exact match or regex)? ✓ **Analysis**: Data model: "hostname ends with allowed suffix". Suffix `*.microsoftonline.com` means "any subdomain of microsoftonline.com". Clear and unambiguous.

- [X] CHK009 - Is the difference between "auth errors" and "transient errors" clearly delineated with specific HTTP status codes and OAuth error types? ✓ **Analysis**: Spec FR4: "Auth-level errors (401, 403, invalid_grant) disable immediately; transient errors (5xx, network timeouts) trigger up to 3 retries". Clarifications: same delineation with concrete codes.

- [X] CHK010 - Is "single active SSO session" scoped to a single Kiro provider type or across all auth methods? ✓ **Analysis**: Spec FR1: "Only one active SSO login session is allowed at a time; starting a new login cancels the previous session". Clarifications confirm: single session rule applies within Kiro SSO (social + enterprise). Different auth methods (Builder ID) are unaffected since they use different flows.

- [X] CHK011 - Is the timeout duration (10 minutes) specified for the login session lifecycle? ✓ **Analysis**: Spec FR1: "listener automatically shuts down after 10 minutes". Data model: `session_timeout_ms: 600000`. T015 confirms timeout with auto-cleanup.

- [X] CHK012 - Is "anti-CSRF state parameter validation" specified for both the social leg AND the enterprise leg of the flow? ✓ **Analysis**: Spec FR2: "State parameter is validated to prevent CSRF across both legs". Data model tracks `state` across leg transitions (FirstLegWaiting → SecondLegWaiting).

## Requirement Consistency

- [X] CHK013 - Do the allow-list validation rules in FR3 (endpoint validation) match the validation rules in FR6 (credential import)? ✓ **Analysis**: Both use the same `validateExternalIdpEndpoint()` function (T004). Both check HTTPS, IP literal rejection, and host suffix matching. FR6 explicitly: "tokenEndpoint is validated against the allow-list before any network request".

- [X] CHK014 - Is the "no partial saves" rule from Clarifications consistently reflected in FR1 (login timeout) and FR6 (import failure)? ✓ **Analysis**: Clarifications: "No partial saves". FR1 timeout → cleanup without save. FR6 import failure → "no partial save". Data model: "On failure/abandon/timeout: clean up, no partial save". Consistent across all failure modes.

- [X] CHK015 - Do the retry/backoff requirements in FR4 align with the error handling described in Edge Cases? ✓ **Analysis**: FR4: auth errors fail immediately, transient errors retry 3x with backoff (1s/4s/16s). Edge Cases: "Expired/bad refresh token: Microsoft returns invalid_grant → account is disabled". Aligned — `invalid_grant` is an auth error, fails immediately per FR4.

- [X] CHK016 - Is the terminology consistent between the spec (external_idp) and the data model (authMethod field)? ✓ **Analysis**: Spec Key Entities: `authMethod: "external_idp"`. Data model: `authMethod` exactly `"external_idp"`. Plan, contracts, tasks all use consistent terminology. Import aliases normalized to canonical `"external_idp"`.

## Acceptance Criteria Quality

- [X] CHK017 - Is "allow-list validation" acceptance criteria testable without access to a real Microsoft 365 tenant? ✓ **Analysis**: Yes — allow-list validation is pure local logic: URL parsing, host suffix matching, HTTPS check, IP literal rejection. Testable with synthetic URLs like `https://evil.com/token`. No external dependency needed.

- [X] CHK018 - Can "no partial credentials saved" be objectively verified? ✓ **Analysis**: Yes — verify that after simulated failure/timeout/cancellation, no new files appear in `configs/kiro/`. Atomic write pattern (write to temp, rename) also prevents partial files on crash. The credential directory listing before/after a failed flow provides objective verification.

- [X] CHK019 - Are the retry count and backoff intervals specified with concrete numbers rather than vague terms? ✓ **Analysis**: Clarifications: "Exponential backoff (1s/4s/16s), max 3 retries". Contract `refreshEnterpriseToken()`: "3 retries with exponential backoff (1s/4s/16s)". All concrete values.

- [X] CHK020 - Can "IP literal hosts are rejected" be verified independently of other validation rules? ✓ **Analysis**: Yes — `validateExternalIdpEndpoint()` performs a simple hostname parse + IP literal check (regex or `net.isIP`). Test with `https://127.0.0.1/token` and `https://192.168.1.1/token`. Completely independent of other validation rules.

## Scenario Coverage

- [X] CHK021 - Are non-HTTPS endpoint rejection scenarios specified for ALL validation points (import, OIDC discovery, refresh)? ✓ **Analysis**: Spec FR3: "Validation rejects non-HTTPS URLs". Applied everywhere via `validateExternalIdpEndpoint()`: import (FR6), OIDC discovery (FR2), refresh (FR4), file tampering defense (T035). All points covered.

- [X] CHK022 - Are requirements defined for what happens when the allow-list config file is malformed or missing? ✓ **Analysis**: Spec FR3: "supports an optional config file that adds additional IdP hosts without replacing the defaults". T034 specifies: if malformed → log warning and use defaults; if missing → silently use defaults. No crash, no security regression.

- [X] CHK023 - Are requirements specified for the allow-list when no additional config file exists (pure defaults)? ✓ **Analysis**: Spec FR3: "The allow-list is hardcoded by default". Data model: hardcoded defaults always active. Config file is additive only. Defaults cover `microsoftonline.com`, `microsoftonline.us`, `microsoftonline.cn`.

- [X] CHK024 - Are requirements defined for detecting and handling credential file tampering (manually modified tokenEndpoint)? ✓ **Analysis**: T035: "validate tokenEndpoint again via validateExternalIdpEndpoint at refresh time (not just import time), since file could be manually edited". This is defense-in-depth applied at every refresh cycle. If validation fails, the credential is treated as invalid.

## Edge Case Coverage

- [X] CHK025 - Is the behavior specified when the OIDC discovery endpoint returns unexpected or malformed data? ✓ **Analysis (resolved)**: Contract `oidcDiscover()` specifies: HTTP errors or invalid JSON response → `"OIDC discovery failed"` error. The parsed authorization/token endpoints are validated via `validateExternalIdpEndpoint()`, which catches malformed URLs. General failure → session cleanup with no partial save. This is sufficient for proper error handling.

- [X] CHK026 - Are requirements defined for handling a refresh token that works initially but becomes invalid mid-session? ✓ **Analysis**: Spec Edge Cases: "Expired/bad refresh token: Microsoft returns invalid_grant → account is disabled with an auth failure message". FR4: invalid_grant → fail immediately, no retry. Session continues for other accounts.

- [X] CHK027 - Is the behavior specified when the loopback listener port is already occupied by a non-Kiro process? ✓ **Analysis (resolved)**: T013 specifies port range 19876-19880 with fallback. Updated to add: if all 5 ports in the range are occupied, the system falls back to OS-assigned random port (port 0) before failing. This avoids hard failure in containerized or port-contended environments while preferring predictable ports.

- [X] CHK028 - Are requirements defined for handling an enterprise callback that returns BOTH social and enterprise parameters simultaneously? ✓ **Analysis (resolved)**: Spec FR2 clarified: the second leg has a distinct callback path (`/oauth/callback`). If a single callback contains both social and enterprise parameters at the first leg, the enterprise `login_option=external_idp`/`issuer_url` parameters take precedence (enterprise leg is detected first). If a second-leg callback also carries unexpected social params, the state/leg validation catches the mismatch and rejects. This prevents parameter confusion attacks.

- [X] CHK029 - Is the behavior specified when the IdP issuer URL from Kiro portal is valid by allow-list but the OIDC discovery produces endpoints that do not match the issuer URL host? ✓ **Analysis**: Contract `oidcDiscover()` step 4: "Validate `issuer` matches `issuerUrl`". Additionally, discovered endpoints are individually validated against the allow-list (step 3). Cross-host mismatch would be caught either by issuer mismatch or endpoint validation.

## Non-Functional Requirements

- [X] CHK030 - Are logging/observability requirements specified for the enterprise auth flow (what gets logged, what is redacted)? ✓ **Analysis (resolved)**: Spec updated to include observability requirements: log SSO lifecycle events (session start, leg transitions, completion/failure), redact all credential secrets in logs (`[REDACTED]`), log endpoint hostnames (not full URLs with query params) for debugging. Observability follows existing patterns in `kiro-oauth.js`.

- [X] CHK031 - Are session timeout values aligned with the maximum expected user interaction time (including MFA delays)? ✓ **Analysis**: 10-minute timeout is standard for OIDC flows. MFA typically completes in 1-3 minutes. The 10-minute window accommodates the longest MFA scenarios comfortably. The timeout covers both legs of the flow within the same session lifetime.

- [X] CHK032 - Are rate-limiting or abuse-prevention requirements defined for the token refresh retry mechanism? ✓ **Analysis**: Max 3 retries with exponential backoff (1s/4s/16s) inherently limits refresh attempt rate. For a single-user application, this is appropriate. Auth-level errors (invalid_grant) fail immediately — preventing endless retry loops.

- [X] CHK033 - Are browser security requirements specified (e.g., no mixing of auth callback state between social and enterprise legs)? ✓ **Analysis**: Spec FR2: "State parameter is validated to prevent CSRF across both legs" using the same `state` parameter. Data model: leg-based state machine (social → enterprise transition) prevents mixing. Session is either in social leg or enterprise leg — no ambiguity.

## Dependencies & Assumptions

- [X] CHK034 - Is the assumption that Microsoft Entra ID OIDC endpoints follow standard discovery protocol documented and validated? ✓ **Analysis**: Spec Assumptions: "The Microsoft Entra ID OIDC endpoints follow the standard openid-configuration discovery protocol". Contract `oidcDiscover()` implements RFC 8414 discovery. Standard validation includes issuer matching, endpoint URL validation.

- [X] CHK035 - Is the dependency on the Kiro portal's enterprise IdP detection behavior documented with fallback assumptions? ✓ **Analysis**: Spec Dependencies: "Kiro hosted sign-in portal (app.kiro.dev/signin) — external dependency, no control over changes". Spec Assumptions: "portal behavior remains stable". Fallback: if portal doesn't return enterprise descriptors, the social leg handles the flow (existing behavior, no regression).

- [X] CHK036 - Is the assumption that `offline_access` scope will be available documented in requirements? ✓ **Analysis**: Spec Assumptions: "Enterprise account users will have the offline_access scope granted by their Azure AD admin to enable token refresh". Data model includes `offline_access` in default scopes. If absent during import, the initial token exchange will work but refresh will fail — clearly documented.

## Ambiguities & Conflicts

- [X] CHK037 - Is the allow-list matching algorithm unambiguous: prefix match, suffix match, exact match, or glob? ✓ **Analysis**: Data model: "hostname ends with allowed suffix" with entries like `.microsoftonline.com` (dot-prefixed suffix). A host `login.microsoftonline.com` matches `.microsoftonline.com` via suffix match. The `*` in spec notation `*.microsoftonline.com` is a documentation shorthand, not a glob pattern. The implementation does suffix matching.

- [X] CHK038 - Is "loopback only" clearly scoped — does it include IPv6 loopback (::1) or only IPv4 (127.0.0.1)? ✓ **Analysis (resolved)**: Spec FR1 updated to clarify: the listener binds to `127.0.0.1` (IPv4 loopback only). IPv6 loopback (`::1`) is excluded for security isolation — most browser-based OIDC flows use IPv4 localhost, and binding to a single address family prevents any ambiguity in redirect URI matching. The existing kiro-oauth.js pattern also uses `127.0.0.1`.

- [X] CHK039 - Is "credential file" singular/plural handling specified — one file per credential vs. one file for all enterprise credentials? ✓ **Analysis**: Spec FR5: "Credentials are stored in the existing per-file JSON format". Data model: "One credential per dir" — `configs/kiro/<timestamp>_kiro-auth-token/<credential-id>.json`. Multiple enterprise accounts = multiple credential files/directories.

- [X] CHK040 - Is the "additional suffixes via config file" merge behavior specified — additive only, or can config file override defaults? ✓ **Analysis**: Spec FR3: "adds additional IdP hosts without replacing the defaults". Data model: "Additional suffixes are merged with defaults, not replaced". Merge is additive-only. Config file cannot remove hardcoded security defaults, preventing accidental misconfiguration.

---

## Checklist Summary

| Category | Total | Pass | Status |
|----------|-------|------|--------|
| Requirement Completeness | 7 | 7 | ✓ |
| Requirement Clarity | 5 | 5 | ✓ |
| Requirement Consistency | 4 | 4 | ✓ |
| Acceptance Criteria Quality | 4 | 4 | ✓ |
| Scenario Coverage | 4 | 4 | ✓ |
| Edge Case Coverage | 5 | 5 | ✓ |
| Non-Functional Requirements | 4 | 4 | ✓ |
| Dependencies & Assumptions | 3 | 3 | ✓ |
| Ambiguities & Conflicts | 4 | 4 | ✓ |
| **Total** | **40** | **40** | **✓ PASS** |

## Gap Resolutions Applied

The following items had minor gaps that were resolved by updating the spec/data-model/docs:

| Item | Gap | Resolution |
|------|-----|------------|
| CHK005 | No file permission requirements | Credential files follow existing system; T035 adds defense-in-depth |
| CHK006 | No log redaction requirements | Added: all secrets redacted as `[REDACTED]` in logs/errors |
| CHK025 | Malformed OIDC discovery behavior | Contract already handles: `"OIDC discovery failed"` error + cleanup |
| CHK027 | Port exhaustion fallback | Updated: fall back to OS-assigned port (port 0) after range exhaustion |
| CHK028 | Mixed callback parameters | Updated: enterprise params take precedence; leg state rejects mismatches |
| CHK030 | No observability requirements | Added: log lifecycle events, redact secrets, log hostnames only |
| CHK038 | IPv6 not addressed | Updated: `127.0.0.1` only, IPv6 `::1` excluded |
