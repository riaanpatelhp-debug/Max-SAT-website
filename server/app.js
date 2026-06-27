// ============================================================================
// Max Potential Learning — reference API layer
// ----------------------------------------------------------------------------
// Implements the three hardening requirements for server-side endpoints:
//   1. Rate limiting on all public endpoints (IP + user based, graceful 429s)
//   2. Strict, schema-based input validation & sanitization
//   3. Secure API-key handling (env vars only, rotation, never client-side)
//
// The static website (index.html etc.) has NO endpoints and ships NO keys, so
// none of this runs in production yet. Add routes here the moment you introduce
// a real backend (contact form, booking, etc.). OWASP references are inline.
// ============================================================================

import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";

const isProd = process.env.NODE_ENV === "production";

// ----------------------------------------------------------------------------
// 3) SECURE KEY HANDLING — load secrets from the environment, never hard-code.
//    Fail fast in production if a required secret is missing (no silent insecure
//    fallback). Support CURRENT + PREVIOUS keys so you can rotate with zero
//    downtime: deploy new key as CURRENT, keep old as PREVIOUS until callers
//    have migrated, then remove PREVIOUS.  (OWASP ASVS V2.10 / Secrets Mgmt)
// ----------------------------------------------------------------------------
function requireEnv(name) {
  const v = process.env[name];
  if (!v && isProd) throw new Error(`Missing required environment variable: ${name}`);
  return v || "";
}
const secrets = {
  // Read once at boot. NEVER log these and NEVER send them to the client.
  emailApiKeys: [process.env.EMAIL_API_KEY, process.env.EMAIL_API_KEY_PREVIOUS].filter(Boolean),
  sessionSecret: requireEnv("SESSION_SECRET"),
};
if (isProd && secrets.emailApiKeys.length === 0) {
  throw new Error("Missing required environment variable: EMAIL_API_KEY");
}
/** Returns the active key for outbound calls (current = first). */
function activeEmailKey() {
  return secrets.emailApiKeys[0];
}

const app = express();

// Behind a load balancer / CDN, trust the first proxy so req.ip is the real
// client IP (critical for correct rate-limit keying). Set precisely to your infra.
app.set("trust proxy", 1);
app.disable("x-powered-by"); // don't advertise the stack (info disclosure)

// ----------------------------------------------------------------------------
// Secure response headers (mirrors _headers / .htaccess for the static site).
// ----------------------------------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com"],
        "img-src": ["'self'", "data:"],
        "object-src": ["'none'"],
        "frame-ancestors": ["'none'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"],
      },
    },
    hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
  })
);

// ----------------------------------------------------------------------------
// CORS allow-list (never reflect arbitrary origins). Configured via env.
// ----------------------------------------------------------------------------
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin(origin, cb) {
      // Allow same-origin / server-to-server (no Origin header) and listed origins.
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Origin not allowed by CORS"));
    },
    methods: ["GET", "POST"],
    maxAge: 600,
  })
);

// Body parser with a strict size limit (mitigates large-payload DoS). OWASP A05.
app.use(express.json({ limit: "10kb" }));

// ----------------------------------------------------------------------------
// 1) RATE LIMITING — IP + user based, sensible defaults, graceful JSON 429s.
//    OWASP A04 (Insecure Design) / API4:2023 (Unrestricted Resource Consumption)
// ----------------------------------------------------------------------------
const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000; // 15 min
const GENERAL_MAX = Number(process.env.RATE_LIMIT_MAX) || 100;
const SENSITIVE_MAX = Number(process.env.RATE_LIMIT_SENSITIVE_MAX) || 5;

// Key by authenticated user when available, otherwise by (IPv6-safe) client IP.
// This prevents one logged-in user from cycling IPs, and one IP from abusing
// anonymous endpoints. `ipKeyGenerator` normalizes IPv6 to avoid bypass.
function clientKey(req) {
  const userId = req.user?.id; // set this in your real auth middleware
  return userId ? `u:${userId}` : ipKeyGenerator(req.ip);
}

// Standard, polite 429 response — includes Retry-After, no internal details.
function tooMany(req, res) {
  res.status(429).json({
    error: "rate_limited",
    message: "Too many requests. Please slow down and try again shortly.",
    retryAfterSeconds: Math.ceil(WINDOW_MS / 1000),
  });
}

const generalLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: GENERAL_MAX,
  standardHeaders: "draft-7", // RateLimit-* headers so clients can back off
  legacyHeaders: false,
  keyGenerator: clientKey,
  handler: tooMany,
});

// Stricter limiter for abuse-prone actions (auth, contact, password reset, ...).
const sensitiveLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: SENSITIVE_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: clientKey,
  handler: tooMany,
});

// Apply the general limiter to EVERY public endpoint.
app.use(generalLimiter);

// ----------------------------------------------------------------------------
// 2) INPUT VALIDATION & SANITIZATION — schema-based, type-checked, length-
//    limited, and STRICT (unexpected fields are rejected, not ignored).
//    OWASP A03 (Injection) — always validate server-side; client checks are UX.
// ----------------------------------------------------------------------------
const trimmed = (max) => z.string().trim().min(1).max(max);

const contactSchema = z
  .object({
    name: trimmed(80),
    email: z.string().trim().toLowerCase().email().max(254),
    phone: z
      .string()
      .trim()
      .max(20)
      .regex(/^[0-9+()\-.\s]*$/, "Invalid phone number")
      .optional(),
    message: trimmed(2000),
    // Honeypot: bots fill hidden fields. Must be empty if present.
    company: z.string().max(0).optional(),
  })
  .strict(); // <- reject any field not declared above

// Reusable validation middleware. On success it REPLACES req.body with the
// parsed (typed + trimmed) data, so downstream code only sees clean values.
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      // Return field-level messages only — never echo internals or stack traces.
      return res.status(400).json({
        error: "invalid_input",
        message: "Some fields were missing or invalid.",
        fields: result.error.issues.map((i) => ({
          field: i.path.join(".") || "(body)",
          message: i.message,
        })),
      });
    }
    req.body = result.data;
    next();
  };
}

// ----------------------------------------------------------------------------
// Example endpoint — a contact form submission.
//   - sensitiveLimiter (tight rate limit)
//   - validate(contactSchema) (strict input validation)
//   - uses activeEmailKey() (secret from env, never exposed)
// ----------------------------------------------------------------------------
app.post("/api/contact", sensitiveLimiter, validate(contactSchema), async (req, res) => {
  const { name, email, message } = req.body; // already clean & typed
  if (req.body.company) return res.status(204).end(); // silently drop bots

  try {
    // await sendEmail({ apiKey: activeEmailKey(), to: "max@maxpotentiallearning.com",
    //                   replyTo: email, subject: `New inquiry from ${name}`, text: message });
    void activeEmailKey(); // demo: key used here, never returned to the client
    return res.status(200).json({ ok: true, message: "Thanks — we'll be in touch soon." });
  } catch (err) {
    console.error("contact_send_failed", err?.message); // log message, not the key
    return res.status(502).json({ error: "send_failed", message: "Could not send right now. Please email us directly." });
  }
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

// 404 + centralized error handler (no stack/info leak in production). OWASP A09.
app.use((req, res) => res.status(404).json({ error: "not_found" }));
app.use((err, req, res, _next) => {
  console.error("unhandled_error", err?.message);
  res.status(500).json({ error: "server_error", message: "Something went wrong." });
});

const port = Number(process.env.PORT) || 8080;
app.listen(port, () => console.log(`API reference listening on :${port}`));
