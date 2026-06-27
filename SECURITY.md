# Security Overview — Max Potential Learning

This document describes how the site is hardened and how to satisfy the three
requested controls (rate limiting, input validation, secure key handling),
mapped to the correct layer. It follows the
[OWASP Top 10](https://owasp.org/www-project-top-ten/) and the
[OWASP Secure Headers Project](https://owasp.org/www-project-secure-headers/).

## Architecture reality (read first)

The deployed site is a **100% static front end** — plain HTML/CSS/JS. A code
audit confirms it has:

- **No server endpoints / API** → nothing to receive requests.
- **No API keys or secrets** anywhere in the client (verified by scan; see below).
- **No user-input processing** — no forms, no `fetch`/XHR, no reading of
  `location.search`/`hash`, `localStorage`, or cookies.
- **No dangerous sinks** — no `innerHTML`, `eval`, `document.write`, or inline
  `<script>`/`on*=` handlers.

Because of this, **rate limiting** and **server-side input validation** apply to
a *backend layer that does not exist yet*. They are delivered here as:
(a) edge/host configuration you can switch on now, and (b) a ready-to-wire
reference API (`server/`) for the day you add a real endpoint (e.g. a contact
form). Nothing in `server/` runs as part of the static site, so existing
functionality is untouched.

Verify "no secrets in the client" yourself at any time:

```bash
grep -rniE "(api[_-]?key|secret|token|password|AKIA[0-9A-Z]{16}|bearer )" \
  --include=*.html --include=*.js --include=*.css .
# → no matches
```

---

## What was hardened on the static site (active now)

| Control | Implementation | OWASP |
| --- | --- | --- |
| **Content Security Policy** | `<meta http-equiv="Content-Security-Policy">` on every page **and** real headers in `_headers` / `.htaccess`. `script-src 'self'` with **no** `unsafe-inline` (possible because there are zero inline scripts) — blocks injected/3rd-party script execution. | A03 Injection / XSS |
| **Clickjacking protection** | `frame-ancestors 'none'` + `X-Frame-Options: DENY`. | A05 |
| **MIME sniffing** | `X-Content-Type-Options: nosniff`. | A05 |
| **Referrer privacy** | `Referrer-Policy: strict-origin-when-cross-origin` (meta + header). | A01 |
| **HTTPS enforcement** | `Strict-Transport-Security` (HSTS) + `upgrade-insecure-requests` + Apache HTTP→HTTPS redirect. | A02 |
| **Tabnabbing / referrer leak** | All 52 external links use `rel="noopener noreferrer"` with `target="_blank"`. | A01 |
| **Permissions hardening** | `Permissions-Policy` disables geolocation, mic, camera, payment, USB, FLoC. | A05 |
| **Cross-origin isolation** | `Cross-Origin-Opener-Policy` + `Cross-Origin-Resource-Policy: same-origin`. | A05 |
| **No info disclosure** | `Options -Indexes`, `Server`/`X-Powered-By` removed, sensitive files denied. | A05 |
| **Safe error UX** | Any link/button with no destination (empty, `#`, or `javascript:`) is intercepted and shows a graceful "Error — please try a different route." toast (rendered via `textContent`, so it can't inject markup). | A09 |
| **Secret hygiene** | `.gitignore` blocks `.env`, keys, and credentials from ever being committed; `.env.example` documents required vars. | A05 |

> **Note on `style-src 'unsafe-inline'`:** kept only because the design uses inline
> `style="…"` attributes. It does **not** weaken script protection. To remove it
> later, migrate inline styles to classes in `styles.css`.

### Deploying the headers
- **Netlify / Cloudflare Pages:** `_headers` is picked up automatically.
- **Apache:** `.htaccess` (needs `mod_headers`, `mod_rewrite`; optional `mod_evasive`).
- **Nginx:** add to your `server {}` block:
  ```nginx
  add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests" always;
  add_header X-Frame-Options "DENY" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Permissions-Policy "geolocation=(), microphone=(), camera=(), payment=()" always;
  add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
  ```

Validate after deploy with <https://securityheaders.com> and <https://csp-evaluator.withgoogle.com>.

---

## 1. Rate limiting on all public endpoints

**Static site today:** there are no endpoints to rate-limit, but you can throttle
abusive traffic at the edge right now:

- **Cloudflare:** Security → WAF → Rate limiting rules (e.g. 100 req / 10s / IP; challenge on exceed).
- **Nginx:** `limit_req_zone $binary_remote_addr zone=mpl:10m rate=10r/s;` then `limit_req zone=mpl burst=20 nodelay;`
- **Apache:** `mod_evasive` block included in `.htaccess`.

**When you add an API:** `server/app.js` applies
[`express-rate-limit`](https://express-rate-limit.mintlify.app/) to **every**
endpoint, keyed by **authenticated user when available, else (IPv6-safe) client IP**:

- General: **100 requests / 15 min** per client.
- Sensitive routes (contact, auth, reset): **5 / 15 min**.
- Graceful **HTTP 429** JSON with `Retry-After` + standard `RateLimit-*` headers.
- All limits overridable via env (`RATE_LIMIT_*`). Use a shared store (Redis) when
  running multiple instances.

## 2. Strict input validation & sanitization

**Static site today:** no user input is collected or processed, so there is no
input surface. (Client-side validation, if added, is **UX only** — never a
security boundary.)

**When you add an API:** `server/app.js` validates with **[zod](https://zod.dev)**
schemas that are:

- **Type-checked** (`string`, `email`, etc.).
- **Length-limited** (`.max(...)` on every field) to prevent oversized payloads.
- **`.strict()`** — unexpected/extra fields are **rejected**, not silently dropped.
- **Sanitized** (`.trim()`, `.toLowerCase()` for email) before use; parsed clean
  values replace `req.body`.
- **Honeypot** field + body size cap (`express.json({ limit: '10kb' })`).
- Failures return **400** with field-level messages and **no** stack traces.

Always pair with **output encoding** at render time and parameterized queries if a
database is added.

## 3. Secure API key handling

- **No keys exist client-side** (verified). Never put a secret in HTML/JS — it is
  world-readable.
- Keys live only in the **environment** (`process.env`), loaded from your host's
  secret manager or a git-ignored `.env` (see `.env.example`).
- **Rotation:** `server/app.js` reads `EMAIL_API_KEY` (current) **and**
  `EMAIL_API_KEY_PREVIOUS` so you can rotate with zero downtime — deploy the new
  key as current, keep the old as previous until traffic migrates, then drop it.
  Rotate on a schedule and immediately on suspected exposure.
- Keys are **never logged** and **never returned** in responses.
- `.gitignore` prevents `.env`/keys from being committed.

---

## Running the reference API (optional)

```bash
cd server
cp ../.env.example .env   # fill in real values
npm install
npm start                 # http://localhost:8080/healthz
```

It is independent of the static site — delete the `server/` folder if you do not
need a backend.

## Ongoing checklist
- [ ] Keep dependencies patched (`npm audit` on `server/`).
- [ ] Rotate secrets on a schedule; revoke on exposure.
- [ ] Re-run the secret scan before each release.
- [ ] Re-test headers at securityheaders.com after deploy.
- [ ] Add server-side validation + rate limiting **before** shipping any new endpoint.

_Report vulnerabilities to **max@maxpotentiallearning.com**._
