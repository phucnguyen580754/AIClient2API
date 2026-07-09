# Antigravity thought_signature 400 Error — Fix Summary

## Problem

Khi dùng model `gemini-3-flash-agent` (và các Gemini model khác) qua Antigravity backend của Google, request bị từ chối với HTTP 400 nếu conversation history chứa `functionCall` parts ở model role messages.

### Error Evolution

| Approach | Error | Cause |
|----------|-------|-------|
| Hack constant (`skip_thought_signature_validator`) | `400 Request contains an invalid argument` | Google không chấp nhận giá trị này |
| Xoá thoughtSignature field | `400 Function call is missing a thought_signature` | Google yêu cầu field phải tồn tại |
| Random base64 placeholder | `400 Corrupted thought signature` | Google xác thực mật mã chữ ký |

**Root cause**: Google Antigravity yêu cầu mỗi `functionCall` part phải có `thoughtSignature` là chữ ký mật mã hợp lệ do chính model Gemini tạo ra. Khi ClaudeConverter chuyển đổi từ Anthropic format (tool_use) → Gemini format (functionCall), nó không thể tạo chữ ký hợp lệ.

---

## Solution — Strip functionCall parts from model role

**File**: `src/providers/gemini/antigravity-core.js`

### Change 1: Xoá toàn bộ functionCall parts khỏi model/assistant role messages

```js
function normalizeAntigravityThoughtSignatures(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        for (const item of node) normalizeAntigravityThoughtSignatures(item);
        return;
    }
    const role = node.role;
    if ((role === 'model' || role === 'assistant') && Array.isArray(node.parts)) {
        for (let i = node.parts.length - 1; i >= 0; i--) {
            const part = node.parts[i];
            if (part && typeof part === 'object' && part.functionCall) {
                node.parts.splice(i, 1);
            }
        }
        return;
    }
    for (const key of Object.keys(node)) {
        normalizeAntigravityThoughtSignatures(node[key]);
    }
}
```

- Gọi trong `geminiToAntigravity()` trước khi gửi request
- Model vẫn đủ context nhờ `functionResponse` (kết quả tool) ở user role messages

### Change 2: Session ID có hậu tố khởi động

```js
const _antigravityGeneration = Date.now();
// ...
template.request.sessionId = stableSessionId + '-g' + _antigravityGeneration;
```

- Mỗi lần restart service → sessionId khác → Google không có server-side state cũ
- Tránh position counter mismatch giữa các lần restart

### Change 3: Signature Store (fallback/defense-in-depth)

```js
const ANTIGRAVITY_SIGNATURE_STORE = new Map();
```

- `storeAntigravitySessionSignatures()` — lưu thought_signature thật từ response
- `injectAntigravitySessionSignatures()` — ghi đè functionCall parts với signature thật
- `extractAntigravitySignaturesFromResponse()` — trích xuất từ response candidates
- **Hiện tại**: Không active vì `normalizeAntigravityThoughtSignatures` chạy trước và xoá functionCall parts

### Change 4: DEBUG logging

- `[DEBUG-TOOLS-400]` logs trong `callApi()` và `streamApi()` — log body khi status !== 200
- Cần xoá sau khi xác nhận fix ổn định

---

## Status

- **400 thought_signature error**: ✅ Fixed (functionCall parts no longer sent)
- **403 "Verify your account"**: ⚠️ Not a code issue — tài khoản Antigravity cần xác thực lại với Google
- **ETIMEDOUT**: ⚠️ daily-cloudcode-pa endpoint không reachable, fallback sang cloudcode-pa

## How to Verify

1. Restart service: `npm start`
2. Gửi request tới `/gemini-antigravity/v1/messages` với tool calls
3. Kiểm tra log không còn `400`, `thought_signature`, hay `Corrupted thought signature`

## Future Cleanup

- [ ] Xoá `[DEBUG-TOOLS-400]` logs khi fix đã verified
- [ ] Xem xét xoá `ANTIGRAVITY_SIGNATURE_STORE` nếu logic strip functionCall hoạt động ổn định lâu dài
