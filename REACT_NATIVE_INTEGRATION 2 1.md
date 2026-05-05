# React Native app — integration with Inventarybolt (Laravel)

This document is for the **mobile team** building the React Native app. It describes API usage, **Firebase Cloud Messaging (FCM)**, and how inventory push behaviour ties to **server-side settings** you do not control from the app.

**Base URL:** use your deployed API root, e.g. `https://your-domain.com`  
**API prefix:** all routes below are under **`/api`** (Laravel’s `api` prefix).

**Web admin UI** (Metronic): same origin, **session cookie** + **CSRF** (no Bearer). Used when the app wraps **`https://your-domain.com/admin/...`** in a WebView.

---

## Laravel ↔ RN quick reference (implemented on server)

| Topic | Doc section | What Laravel does |
|-------|-------------|-------------------|
| REST login + API token | §1 | `POST /api/login` — Sanctum Bearer in JSON |
| Save FCM token | §2 | `POST /api/fcm/save-token` (or legacy path) — **requires Bearer** |
| Inventory push rules | §3 | Env + Settings + Profile toggles |
| After **web** admin login | §5 | One-shot flash → **`LOGIN_SUCCESS`** via `postMessage` |
| **Estimate** PDF / print in WebView | §7 | Optional signed URL JSON + **`inventarybolt_estimate_pdf`** `postMessage` |
| Dashboard → Inventory hint | §8 | Links add **`?flow=in`** / **`?flow=out`** |

---

## 1. Authentication (Laravel Sanctum)

### Login

`POST /api/login`  
`Content-Type: application/json`

```json
{
  "email": "user@example.com",
  "password": "••••••••"
}
```

**Success (200):** response includes a **Bearer token** (plain text) the app must store securely, e.g.:

```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "user": { "id": 1, "first_name": "…", "email": "…", "user_type": "…" },
    "token": "1|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
```

Use that value as:  
`Authorization: Bearer <token>` on every **authenticated** request.

### Logout

`POST /api/logout`  
Headers: `Authorization: Bearer <token>`, `Accept: application/json`

The server clears the user’s **FCM token** and **device_platform** and revokes the current Sanctum token. The app should delete its local copy of the Bearer token and stop using the old FCM token for this user.

### Current user (optional)

`GET /api/user` — same `Authorization` header.

---

## 2. FCM token registration (required for inventory pushes)

The server **only sends inventory FCM** to users who have a **non-empty `fcm_token`** stored on their user record. Your app must register the token **after** a successful login (and refresh it when Firebase rotates it).

### Endpoints (identical behaviour — pick one)

| Method | Path | Notes |
|--------|------|--------|
| `POST` | `/api/device/fcm-token` | Legacy body field `fcm_token` |
| `POST` | `/api/fcm/save-token` | RN-friendly body: `token` + optional `platform` |

**Headers**

- `Authorization: Bearer <sanctum_token>`
- `Accept: application/json`
- `Content-Type: application/json`

**Body (recommended)**

```json
{
  "token": "<FCM registration token from Firebase>",
  "platform": "android"
}
```

`platform` is optional (`ios`, `android`, …); stored as `device_platform` on the server.

**Legacy body (also supported)**

```json
{ "fcm_token": "<same token string>" }
```

**Success:** `{ "success": true, "message": "FCM token saved." }`  
If the body omits both `token` and `fcm_token` keys entirely, the server returns `{ "success": true }` and **does not** change the stored token.

### When to call

1. Immediately after **login succeeds** and you have the Sanctum Bearer token.
2. On **`onTokenRefresh`** (or equivalent) from `@react-native-firebase/messaging`, post the new token again with the same headers.
3. Optionally on **app foreground** if you want to self-heal after long idle periods.

### Permissions (your responsibility)

- **Android 13+:** request the runtime notification permission before expecting tokens/taps to work as users expect.
- **iOS:** enable Push Notifications capability, upload APNs key to Firebase, and request permission via Firebase / your UX flow.

If the user denies notifications, you may still get an FCM token in some cases, but delivery UX is poor—treat permission as part of your onboarding checklist.

---

## 3. When does the server send inventory FCM?

The Laravel app sends **inventory** FCM only if **all** of the following are true (backend config; the RN app cannot override this):

1. **`FCM_ENABLED`** (and Firebase credentials) are valid on the server.
2. **Settings → “Mobile push (FCM)”** is on (`inventory_push_to_devices_enabled`).
3. **My Profile (catalog admin only) → “Send mobile push for inventory changes”** is on (`inventory_push_notify_all_users`).  
   When this is **off**, **no inventory FCM** is sent to anyone (database/in-app notifications on the web still work).

If pushes “never arrive,” verify the above with the **web/backend team** before debugging the client.

---

## 4. FCM payload shape (inventory)

When a push is sent, **all `data` values are strings** (FCM requirement).

| Key | Example | Meaning |
|-----|---------|---------|
| `screen` | `inventory_history_edit` | Logical screen name for your router |
| `history_id` | `"42"` | `inventory_histories.id` |
| `edit_url` | `https://…/admin/inventory/history/42/edit` | Full HTTPS URL to the **web** entry screen (admins can edit; others see read-only in browser) |
| `url` | `https://…/admin/inventory/history` | Full URL to inventory **history list** (good default for WebView home) |
| `click_action` | `OPEN_INVENTORY_HISTORY_EDIT` | Useful on Android legacy handlers |
| `deep_link` | `scheme://inventory/history/42/edit` | Only if the server sets `INVENTORY_ANDROID_DEEP_LINK_SCHEME` |

**Android notification channel id** (server default): `inventory_alerts` — create the same channel id in the app (Android 8+).

### Suggested tap handling (React Native)

1. **Foreground:** `messaging().onMessage` — show a local notification (e.g. Notifee) including `data`, or in-app UI.
2. **Background / quit:** `onNotificationOpenedApp` and `getInitialNotification()` — read `remoteMessage.data`.
3. **Navigate:**
   - Prefer **`edit_url`** if you open a **WebView** and the user’s **web session** is already valid inside that WebView (cookies), **or** you pass auth in a way your WebView supports.
   - Or use **`history_id`** / **`deep_link`** to open a **native** screen that calls the API (`GET`/`PUT` inventory APIs as applicable).

If you append `?is_mobile=1` (or similar) for analytics, append query params carefully so you do not break signed URLs.

---

## 5. WebView + React Native bridge (Laravel implementation)

Use this when the app loads the **Laravel admin** (`/admin/...`) inside **`react-native-webview`**. The bridge is **`window.ReactNativeWebView.postMessage(string)`** — the native app must parse JSON from `onMessage` / `event.nativeEvent.data`.

### 5.1 `LOGIN_SUCCESS` (after web admin login)

**When:** Immediately after a successful **`POST /login`** (Fortify/Breeze web guard). The next full page load of any screen that uses the **Metronic admin layout** runs the bridge once.

**Laravel pieces**

| Piece | Location |
|-------|----------|
| Flash flag | `AuthenticatedSessionController::store` — `session()->flash('rn_login_success_bridge', true)` after `session()->regenerate()` |
| Script | `resources/views/layouts/app-metronic.blade.php` — `@auth` + `@if(session('rn_login_success_bridge'))` inline `<script>` before `@stack('scripts')` |

**Message payload** (always stringify before `postMessage`):

```json
{
  "type": "LOGIN_SUCCESS",
  "user": {
    "id": 42,
    "email": "user@example.com",
    "name": "First Last"
  }
}
```

- **No** `token` / Bearer string is sent (web auth is the **session cookie** inside the WebView only).
- If you need **`POST /api/fcm/save-token`**, you still need a **Bearer** from **`POST /api/login`** (native login) **or** a future Laravel endpoint that mints a short-lived API token from the web session (not implemented today).

### 5.2 `inventarybolt_estimate_pdf` (Estimate screen)

Sent from **`/admin/estimate`** in-app JS when generating a PDF or print flow using a **signed download URL**. See **§7** for server fields and RN handling.

### 5.3 Recommended native `onMessage` shape

```javascript
import { Linking } from 'react-native';

function handleWebViewMessage(event) {
  let data;
  try {
    data = JSON.parse(event.nativeEvent.data);
  } catch {
    return;
  }
  if (!data || !data.type) return;

  switch (data.type) {
    case 'LOGIN_SUCCESS':
      // e.g. mark app “logged in”, sync user cache; call API login separately if you need Bearer + FCM
      break;
    case 'inventarybolt_estimate_pdf':
      if (data.download_url) {
        Linking.openURL(data.download_url);
      }
      break;
    default:
      break;
  }
}
```

### 5.4 Login modes (choose one or combine)

| Mode | How | FCM token on server |
|------|-----|---------------------|
| **Native only** | `POST /api/login` → store Bearer | Call **`POST /api/fcm/save-token`** with Bearer (§2) |
| **WebView only** | `POST /login` in WebView → cookies | **`LOGIN_SUCCESS`** fires; Bearer **not** issued unless you add a token handoff API |
| **Hybrid** | WebView for UI + native `POST /api/login` once for token | Use Bearer from API login for FCM + inventory APIs |

---

## 6. Related API routes (inventory)

All require `Authorization: Bearer <token>` unless noted.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/inventory/get-labels` | Labels for a `type_id` |
| `POST` | `/api/inventory/get-stock` | Stock for a cell |
| `POST` | `/api/inventory/update` | Apply stock in/out (creates history + notifications server-side) |
| `GET` | `/api/inventory/history` | Paginated history (filters as supported by API) |
| `PUT` | `/api/inventory/history/{id}` | Update a history row (permission rules on server) |
| `DELETE` | `/api/inventory/history/{id}` | Delete a history row (permission rules on server) |

Inventory **push** for web `/admin/inventory` is triggered server-side when history is created/updated there; your app does **not** call a separate “send push” endpoint.

---

## 7. Admin → Estimate (WebView): PDF download & print

**URL:** `GET /admin/estimate` (web session; user must be in **catalog admin** allow-list on the server).

Inside a **WebView**, blob downloads and `window.print()` are unreliable. Laravel supports:

1. **Signed one-time PDF URL** — `POST /admin/estimate/pdf` with form field **`return_signed_url=1`** returns **`application/json`** instead of raw PDF.
2. **`postMessage`** to RN with the URL so **`Linking.openURL`** can open the system viewer / Downloads.

### 7.1 Laravel routes & controller

| Item | Value |
|------|--------|
| Generate PDF (POST) | `POST /admin/estimate/pdf` — name `estimate.pdf` |
| Signed download (GET) | `GET /admin/estimate/pdf-download/{uuid}` — name `estimate.pdf.signed`, middleware **`signed`** (no session cookie required) |
| Controller | `App\Http\Controllers\EstimateController` — `pdf()`, `pdfSignedDownload()` |
| Signed URL TTL | **15 minutes**; file is deleted after **one** successful download |

### 7.2 `POST /admin/estimate/pdf` (WebView / form)

**Headers:** `X-Requested-With: XMLHttpRequest`, **`Accept: application/json`** when requesting a signed URL; **`Accept: application/pdf`** for direct binary (desktop browser).

**Body:** `multipart/form-data` or `application/x-www-form-urlencoded` compatible:

| Field | Required | Notes |
|-------|----------|--------|
| `_token` | Yes | CSRF from `<meta name="csrf-token">` on the page |
| `payload` | Yes | JSON string: `customer_name`, `rows[]` (`type_id`, `length`, `diameter`, `quantity`, `unit_price`, optional `discount_percent`) |
| `return_signed_url` | No | `1` / `true` → JSON response `{ "download_url", "filename" }` |
| `signed_disposition` | No | `attachment` (default) or **`inline`** (used for “Print” flow) |

**JSON success (200):**

```json
{
  "download_url": "https://your-domain.com/admin/estimate/pdf-download/…?disposition=…&expires=…&signature=…",
  "filename": "estimate-2026-04-21-120000.pdf"
}
```

**Important:** `APP_URL` in `.env` must match the **public HTTPS** origin the device uses, or signed URLs will fail validation.

### 7.3 When the web app uses signed URL + `postMessage`

The Blade/JS on **`resources/views/estimates/index.blade.php`** sets **`return_signed_url=1`** when:

- `window.ReactNativeWebView.postMessage` exists (**React Native WebView**), or  
- User agent looks like **Android System WebView** (`; wv)` / `wv` + Chrome), or  
- Injected flag: `window.INVENTARYBOLT_ESTIMATE_SIGNED_PDF = true`

Then it **`postMessage`** JSON:

| Field | Meaning |
|--------|--------|
| `type` | **`inventarybolt_estimate_pdf`** |
| `download_url` | Absolute signed URL (open with `Linking.openURL`) |
| `filename` | Suggested filename |
| `action` | **`save`** — Generate PDF; **`print`** — Print flow (`inline` disposition) |

### 7.4 Minimal native handling

```javascript
const data = JSON.parse(event.nativeEvent.data);
if (data.type === 'inventarybolt_estimate_pdf' && data.download_url) {
  Linking.openURL(data.download_url);
}
```

### 7.5 Optional: force signed-URL from any browser

Inject before the estimate page runs:

`window.INVENTARYBOLT_ESTIMATE_SIGNED_PDF = true;`

---

## 8. Admin dashboard → inventory (`?flow=in` / `?flow=out`)

**Laravel / web only:** the admin **Dashboard** quick actions link to:

- **Stock IN:** `GET /admin/inventory?flow=in`
- **Stock OUT:** `GET /admin/inventory?flow=out`

**Implementation:** `resources/views/dashboard.blade.php` → `resources/views/types/inventory.blade.php` reads `flow`, highlights the matching button once, strips the query from the address bar (`history.replaceState`), and remembers **`flow=out`** so **Enter** in the quantity field submits **stock out** when appropriate.

RN does **not** need to handle this unless you open those URLs yourself; it is for UX when users tap dashboard buttons inside the WebView.

---

## 9. Checklist for the RN team

- [ ] Add `@react-native-firebase/app` and `@react-native-firebase/messaging` (and iOS setup: APNs in Firebase).
- [ ] Request notification permission where appropriate.
- [ ] After **every successful login**, call **`POST /api/fcm/save-token`** (or `/api/device/fcm-token`) with Bearer auth.
- [ ] Listen for **token refresh** and re-post to the same endpoint.
- [ ] On **logout**, call **`POST /api/logout`** (clears server-side FCM mapping).
- [ ] Handle **notification tap** using `edit_url`, `url`, or `history_id` / `deep_link` as agreed with UX.
- [ ] Create Android **notification channel** `inventory_alerts` (or match `FCM_ANDROID_CHANNEL_ID` from server env).
- [ ] Confirm with backend that **both** server toggles (§3) are **on** before expecting inventory FCM in QA/production.
- [ ] If using **WebView login**, implement **`onMessage`** for **`LOGIN_SUCCESS`** (§5.1) and **`inventarybolt_estimate_pdf`** (§7); plan FCM (§5.4).

---

## 10. Further reading in this repo

- `mobile/android/FCM_DEEP_LINK.md` — Android-oriented notes; payload table overlaps with this document.
- Server env examples: `.env.example` — `FIREBASE_CREDENTIALS`, `FCM_ENABLED`, `FCM_ANDROID_CHANNEL_ID`, `INVENTORY_ANDROID_DEEP_LINK_SCHEME`.

---

## 11. Support / questions

Coordinate with the **Laravel/backend** team for: **`APP_URL`** (FCM `edit_url` / `url`, **signed estimate PDF links**, `LOGIN_SUCCESS` redirect target), Firebase service account on the server, and the two **inventory push** toggles in Settings and Profile.

---

## Appendix A — Laravel files (WebView / RN–related)

Use this when tracing behaviour in the repo.

| Area | File(s) |
|------|---------|
| Web login + flash for `LOGIN_SUCCESS` | `app/Http/Controllers/Auth/AuthenticatedSessionController.php` |
| Admin layout + `LOGIN_SUCCESS` `postMessage` | `resources/views/layouts/app-metronic.blade.php` |
| Brochure modal close (Bootstrap 5) | `resources/views/frontTheame/script.blade.php` — `hideDownloadBrochureModal()` |
| Estimate UI + signed PDF / `postMessage` | `resources/views/estimates/index.blade.php` |
| Estimate PDF + signed download | `app/Http/Controllers/EstimateController.php` |
| Routes (`estimate.pdf`, `estimate.pdf.signed`, brochure POST) | `routes/web.php` |
| Dashboard Stock IN/OUT links | `resources/views/dashboard.blade.php` |
| Inventory `?flow=` handling | `resources/views/types/inventory.blade.php` |
| API login / FCM / inventory | `routes/api.php`, `app/Http/Controllers/Api/` (see existing API controllers) |
