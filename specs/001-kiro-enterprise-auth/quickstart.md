# Quickstart: Kiro Enterprise Auth Validation Guide

**Phase 1** | **Date**: 2026-07-09 | **Spec**: [spec.md](./spec.md) | **Data Model**: [data-model.md](./data-model.md) | **Contract**: [contracts/kiro-enterprise-module.md](./contracts/kiro-enterprise-module.md)

## Prerequisites

- AIClient2API running locally on the developer machine
- A Microsoft 365 work/school account with access to a configured Azure AD app registration
- Browser access to `app.kiro.dev` (Kiro hosted sign-in portal)
- Node.js 18+ runtime

## Validation Scenarios

### Scenario 1: Enterprise SSO Login (End-to-End)

**Objective:** Verify that a Microsoft 365 user can authenticate through the enterprise SSO flow.

**Steps:**

1. Start AIClient2API:
   ```bash
   cd C:\Apps\AIClient2API
   npm start
   ```

2. Open the admin panel in a browser. Navigate to Kiro authentication section.

3. Select "Microsoft 365 / Enterprise SSO" from the Kiro login method selector.

4. Click the login button. Expected:
   - A browser window/tab opens to `app.kiro.dev/signin`
   - The Kiro portal displays the Microsoft 365 sign-in option

5. Enter a Microsoft 365 organization email address and authenticate (including MFA if required).

6. **Expected outcome:**
   - The browser redirects back to the local listener
   - Login completes within 5 minutes
   - A new credential file appears in `configs/kiro/<timestamp>_kiro-auth-token/`
   - The credential JSON contains `authMethod: "external_idp"` and `provider: "AzureAD"`
   - The account appears in the admin panel account list as "Enterprise SSO (Azure AD)"
   - The Kiro API becomes usable through AIClient2API

**To verify credential file:**
```bash
cat configs/kiro/*_kiro-auth-token/*.json | grep -l '"authMethod": "external_idp"'
```

**Expected file content structure:**
```json
{
  "authMethod": "external_idp",
  "provider": "AzureAD",
  "tokenEndpoint": "https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token",
  "issuerUrl": "https://login.microsoftonline.com/<tenant>/v2.0",
  "scopes": "openid profile email offline_access https://api.kiro.dev/.default",
  "clientId": "<guid>",
  "accessToken": "eyJ...",
  "refreshToken": "0.A...",
  "expiresAt": 1720608000000,
  "profileArn": "arn:aws:codewhisperer:us-east-1:012345678901:profile/user@company.com"
}
```

---

### Scenario 2: Token Refresh (Automatic)

**Objective:** Verify that enterprise account tokens refresh automatically without user intervention.

**Steps:**

1. Ensure an enterprise account is linked (from Scenario 1).

2. Wait for the access token to expire, or manually trigger a refresh:
   - Check the `expiresAt` field in the credential file
   - If the provider adapter (`claude-kiro.js`) detects an expired token, it will automatically refresh

3. **Expected outcome:**
   - The refresh request is sent to the Microsoft token endpoint (`login.microsoftonline.com`)
   - The credential file is updated with a new `accessToken`
   - If Microsoft rotates the refresh token, a new `refreshToken` is also stored
   - If Microsoft does not return a new refresh token, the existing one is retained
   - The account remains healthy and usable

**To verify refresh:**
```bash
# Check that the credential file was updated
cat configs/kiro/*_kiro-auth-token/*.json | python -c "import sys,json; d=json.load(sys.stdin); print('expiresAt:', d.get('expiresAt'))"
```

---

### Scenario 3: Credential Import (Paste JSON)

**Objective:** Verify that enterprise credentials can be imported by pasting JSON.

**Steps:**

1. Obtain an enterprise credential JSON from an existing Kiro-Go configuration or by examining a previously successful login artifact.

2. In the admin panel, navigate to the credential import dialog.

3. Paste the enterprise credential JSON. Example:
   ```json
   {
     "authMethod": "external_idp",
     "tokenEndpoint": "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token",
     "clientId": "550e8400-e29b-41d4-a716-446655440000",
     "scopes": "openid profile email offline_access https://api.kiro.dev/.default",
     "refreshToken": "0.ARoAQ4S6X-TxGzPq7Yz..."
   }
   ```

4. **Expected outcome:**
   - Token endpoint validated against allow-list
   - A test refresh is performed against the Microsoft token endpoint
   - On success: credential saved to `configs/kiro/<timestamp>_kiro-auth-token/`
   - Account appears in the list as "Enterprise SSO (Azure AD)"

---

### Scenario 4: Import Rejection (Invalid Endpoint)

**Objective:** Verify that forged credential imports with invalid token endpoints are rejected.

**Steps:**

1. In the credential import dialog, paste a malicious credential:
   ```json
   {
     "authMethod": "external_idp",
     "tokenEndpoint": "https://evil-attacker.com/steal-tokens",
     "clientId": "fake",
     "refreshToken": "fake"
   }
   ```

2. **Expected outcome:**
   - Import is rejected with a clear error message (e.g., "Token endpoint rejected by allow-list")
   - No file is saved to `configs/kiro/`
   - The application continues to function normally

3. Repeat with non-HTTPS endpoint:
   ```json
   {
     "authMethod": "external_idp",
     "tokenEndpoint": "http://login.microsoftonline.com/contoso/oauth2/v2.0/token",
     "clientId": "fake",
     "refreshToken": "fake"
   }
   ```

4. **Expected outcome:** Rejected with "HTTPS required" error.

5. Repeat with IP literal:
   ```json
   {
     "authMethod": "external_idp",
     "tokenEndpoint": "https://13.107.6.183/contoso/oauth2/v2.0/token",
     "clientId": "fake",
     "refreshToken": "fake"
   }
   ```

6. **Expected outcome:** Rejected with "IP literal hosts not allowed" error.

---

### Scenario 5: Multiple Enterprise Accounts

**Objective:** Verify that multiple enterprise accounts from different tenants can co-exist.

**Steps:**

1. Link an enterprise account from Tenant A (e.g., `user@companyA.com`).

2. Repeat the login flow with a different account from Tenant B (e.g., `user@companyB.com`).

3. **Expected outcome:**
   - Two separate credential files exist in `configs/kiro/`
   - Both accounts appear in the admin panel account list
   - Each account has its own `tokenEndpoint` pointing to the correct tenant
   - Both accounts can be used independently

---

### Scenario 6: Login Timeout

**Objective:** Verify that the SSO session properly times out after 10 minutes of inactivity.

**Steps:**

1. Start the enterprise SSO login flow.

2. Do NOT complete the login. Wait for 10 minutes.

3. **Expected outcome:**
   - The loopback server shuts down automatically
   - No credential file is created
   - A new login attempt works without port conflicts

---

### Scenario 7: Login Abandonment

**Objective:** Verify that abandoning the login mid-flow does not leave partial state.

**Steps:**

1. Start the enterprise SSO login flow.

2. Close the browser before completing authentication.

3. **Expected outcome:**
   - No credential file is saved
   - No stale server process remains
   - A new login attempt starts fresh

---

## Verification Checklist

| # | Scenario | Expected Result | Pass/Fail |
|---|----------|----------------|-----------|
| 1 | Enterprise SSO login (end-to-end) | Credential file with `authMethod: external_idp` created | |
| 2 | Automatic token refresh | Credential updated with new tokens | |
| 3 | Credential import (valid) | Account appears in list | |
| 4 | Import rejection (bad endpoint) | Clear error, no file saved | |
| 5 | Import rejection (non-HTTPS) | "HTTPS required" error | |
| 6 | Import rejection (IP literal) | "IP literals not allowed" error | |
| 7 | Multiple tenants | Both accounts functional | |
| 8 | Login timeout (10 min) | Clean shutdown, no file | |
| 9 | Login abandonment | No partial state left | |

## Notes

- Enterprise SSO requires browser interaction -- it cannot be fully automated in a headless environment.
- Token refresh can be observed in application logs when the provider adapter detects an expired token.
- For testing token refresh without waiting, temporarily reduce the `expiresAt` value in the credential file to a past timestamp.
- The Microsoft token endpoint may return a 400 `invalid_grant` error if the refresh token has been revoked or expired (e.g., user changed password). This is expected and the account is disabled gracefully.
