# API Frontend–Backend Audit

**Date:** March 4, 2026  
**Frontend:** WP-Alt-text-plugin (BeepBeep AI)  
**Backend:** oppti-backend (alttext-ai-backend.onrender.com)

**Status:** Fixes applied March 4, 2026. See "Fixes Applied" section below.

---

## Summary

| Status | Count |
|--------|-------|
| ✅ Working | 12 |
| ~~⚠️ Path/format mismatches~~ | Fixed |
| ~~❌ Missing backend endpoint~~ | Implemented |

---

## ✅ Endpoints That Match

| Frontend Call | Backend Route | Notes |
|---------------|---------------|-------|
| `GET /api/usage` | `GET /api/usage` | Quota status |
| `GET /api/usage/users` | `GET /api/usage/users` | Per-user breakdown |
| `POST /api/contact` | `POST /api/contact` | Contact form |
| `POST /api/alt-text` | `POST /api/alt-text` | Alt text generation |
| `GET /auth/me` | `GET /auth/me` | User info |
| `POST /auth/login` | `POST /auth/login` | Login |
| `POST /auth/register` | `POST /auth/register` | Register |
| `GET /billing/plans` | `GET /billing/plans` | Pricing plans |

---

## ⚠️ Path Mismatches

### 1. License activate

| | Frontend | Backend |
|--|----------|---------|
| Path | `POST /api/license/activate` | `POST /license/activate` |
| Issue | Frontend uses `/api/` prefix; backend does not |

**Fix:** Either mount backend license router at `/api/license`, or change frontend to `/license/activate`.

### 2. License sites (list)

| | Frontend | Backend |
|--|----------|---------|
| Path | `GET /api/licenses/sites` | `GET /license/sites` |
| Issue | Frontend uses `/api/licenses/` (plural); backend uses `/license/` (singular) |

### 3. License activate – request body

| | Frontend sends | Backend expects |
|--|----------------|-----------------|
| Keys | `licenseKey`, `siteHash`, `siteUrl`, `installId` | `license_key`, `site_id`, `site_url`, `site_name`, `fingerprint` |

Backend reads snake_case; frontend sends camelCase. `site_id` vs `siteHash`/`installId` may cause activation to fail.

### 4. License activate – response shape

| | Frontend expects | Backend returns |
|--|------------------|-----------------|
| Keys | `organization`, `site` | `license`, `site` |

Frontend stores `response['organization']`; backend returns `license`. Frontend may get `null` for organization.

---

## ❌ Missing Backend Endpoints

### 1. `GET /billing/info`

- **Frontend:** `get_billing_info()` calls `GET /billing/info`
- **Backend:** No `/billing/info` route (only `/plans`, `/checkout`, `/portal`, `/subscription`)
- **Impact:** Billing info calls will 404

### 2. `DELETE /api/licenses/sites/:id` (disconnect site)

- **Frontend:** `disconnect_license_site($site_id)` calls `DELETE /api/licenses/sites/{id}`
- **Backend:** No DELETE route for sites; only `GET /license/sites` and `POST /license/sites/:site_id/quota`
- **Impact:** “Disconnect site” in the plugin will 404

---

## Fixes Applied (March 4, 2026)

1. **License paths:** License router now mounted at `/license`, `/api/license`, and `/api/licenses`. Frontend paths `/api/license/activate`, `/api/licenses/sites` now work.
2. **Request body normalization:** Activate and deactivate handlers accept both camelCase (`licenseKey`, `siteHash`, `installId`) and snake_case (`license_key`, `site_id`).
3. **Activate response:** Added `organization` and `data: { organization, site }` to activate response for frontend compatibility.
4. **GET /billing/info:** Implemented. Returns `{ success, data: { billing: { plan, status, billingCycle, nextBillingDate, ... } } }`.
5. **DELETE /license/sites/:site_id:** Implemented. Deactivates site (sets `status: 'deactivated'`). Available at `/api/license/sites/:id` and `/api/licenses/sites/:id`.
6. **Auth middleware:** Added public paths for `/api/license/*` and `/api/licenses/*` activate/validate/deactivate/transfer.
