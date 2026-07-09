# Implementation Plan: Kiro Enterprise Auth -- Microsoft 365 Organization Login Support

**Branch**: `001-kiro-enterprise-auth` | **Date**: 2026-07-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-kiro-enterprise-auth/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

Add Microsoft 365 / Entra ID (Azure AD) organization login support to AIClient2API's Kiro authentication system. Implement the two-leg browser SSO flow (Kiro portal -> enterprise IdP descriptor -> OIDC PKCE against Microsoft Entra ID -> token exchange), plus credential import/refresh for `external_idp` credentials. The implementation mirrors the enterprise SSO support already present in Kiro-Go (`auth/kiro_sso.go`).

## Technical Context

**Language/Version**: JavaScript (Node.js 18+, ES modules)

**Primary Dependencies**: None new -- all OIDC/OAuth2 flows use existing `http`, `crypto`, and `fetchWithProxy` (axios). Token exchange uses form-encoded POST (standard OAuth2).

**Storage**: Filesystem -- extend existing `configs/kiro/<timestamp>_kiro-auth-token/<file>.json` per-credential format with new fields: `tokenEndpoint`, `issuerUrl`, `scopes`, `authMethod`, `provider`.

**Testing**: Manual verification through admin panel UI (project has no automated test suite for auth flows)

**Target Platform**: Windows/Linux/MacOS -- Node.js web server with browser-based OIDC login

**Project Type**: Web service (admin panel + API proxy)

**Performance Goals**: Login under 5 minutes (includes user browser interaction); token refresh < 3 seconds

**Constraints**: Loopback HTTP listener bound to 127.0.0.1 only; single active SSO session at a time; allow-list validation on all external IdP endpoints for SSRF protection

**Scale/Scope**: Single-user admin panel; multiple Kiro accounts supported concurrently in pool

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution [v1.0.0](../.specify/memory/constitution.md) applies:

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Spec-Driven Development | ✅ Pass | Spec complete, clarifications resolved |
| II. Security-First Design | ✅ Pass | Allow-list, loopback isolation, atomic writes all specified |
| III. Minimal External Dependencies | ✅ Pass | No new npm packages needed |
| IV. Backward-Compatible Extensions | ✅ Pass | Extends existing credential JSON format |
| V. Observable Failure | ✅ Pass | Retry policy, auth/transient error distinction, no partial saves |

**Verdict**: Constitution check passes. Proceed to Phase 0 research.

## Project Structure

### Documentation (this feature)

```text
specs/001-kiro-enterprise-auth/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/auth/
├── kiro-oauth.js         # Main target -- add enterprise SSO login flow
├── kiro-enterprise.js     # NEW: Enterprise IdP logic (OIDC discovery, token exchange, validation)
├── oauth-handlers.js      # Export re-route -- add new enterprise handler exports
└── index.js               # Export re-route -- add new enterprise exports

src/ui-modules/
├── oauth-api.js           # Add enterprise auth URL generation + manual callback handling
└── auth.js                # Unchanged

src/services/
├── ui-manager.js          # Add enterprise-specific API endpoints if needed
└── service-manager.js     # Handle enterprise credential linking
```

**Structure Decision**: Follow existing provider pattern -- each auth provider has its own file under `src/auth/`. Enterprise Kiro SSO will be a new file (`kiro-enterprise.js`) rather than inlining into the already-large `kiro-oauth.js` (1229 lines). The existing `kiro-oauth.js` social and Builder ID flows remain unchanged.
