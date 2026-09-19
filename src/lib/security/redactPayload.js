/**
 * Payload redaction for stored request/response details.
 *
 * The dashboard stores full request bodies (user prompts, tool calls) and
 * provider responses in `requestDetails`. Blanking those fields wholesale hides
 * every conversation, which makes the usage tab useless for debugging. Instead
 * we keep the payload structure intact and mask only credentials, so operators
 * can still read prompts, model output and upstream error messages.
 *
 * Two defences, applied to values and to object keys respectively:
 *   1. `BEARER_RE` — inline `Bearer <token>` occurrences inside any string.
 *   2. `SENSITIVE_KEY_RE` — a whole value whose *key* names a credential.
 *
 * A field is only treated as a credential when its key matches exactly (after
 * normalising case and separators), so lookalikes such as `apiKeyCount` or
 * `keys` pass through untouched.
 */

/** Inline `Bearer <token>` inside arbitrary strings. */
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * Credential-bearing key names, compared after lowercasing and dropping
 * `-`/`_`. Kept as an explicit allowlist rather than a `/(key|token)/` pattern
 * so ordinary fields like `keys`, `api_key_id` or `token_count` are not masked.
 */
const SENSITIVE_KEYS = new Set([
  "authorization",
  "apikey",
  "apikeys",
  "xapikey",
  "apisecret",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "bearertoken",
  "cookie",
  "setcookie",
  "credential",
  "credentials",
  "privatekey",
]);

const REDACTED = "[redacted]";

/**
 * Normalise a key for credential comparison: lowercase, strip `-`/`_`.
 * @param {string} key
 * @returns {string}
 */
function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[-_]/g, "");
}

/**
 * True when an object key names a credential whose value must be masked.
 * @param {string} key
 * @returns {boolean}
 */
function isSensitiveKey(key) {
  return SENSITIVE_KEYS.has(normalizeKey(key));
}

/**
 * Mask inline `Bearer <token>` occurrences inside a string.
 * @param {string} value
 * @returns {string}
 */
function maskBearer(value) {
  return value.replace(BEARER_RE, "Bearer " + REDACTED);
}

/**
 * Deep-copy a payload, masking credentials while preserving structure.
 *
 * Handles plain objects, arrays and primitives. Non-plain objects (Date, etc.)
 * are reduced to their JSON-safe form rather than being walked, so a stray
 * class instance cannot smuggle credential fields through untouched.
 *
 * @param {*} value
 * @param {number} [depth] - recursion guard
 * @returns {*} redacted copy; the input is never mutated
 */
export function redactPayload(value, depth = 0) {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return maskBearer(value);
  if (typeof value !== "object") return value;
  if (depth > 32) return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactPayload(item, depth + 1));
  }

  // Only walk plain objects. Anything else (Date, Map, class instance) is
  // converted through JSON so we neither lose it nor trust its own walker.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    try {
      return redactPayload(JSON.parse(JSON.stringify(value)), depth + 1);
    } catch {
      return undefined;
    }
  }

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (val === undefined) continue;
    if (isSensitiveKey(key)) {
      // Preserve the scheme prefix where one is present, so logs stay readable
      // ("Bearer [redacted]") without ever exposing the token itself.
      if (typeof val === "string" && /^Bearer\s/i.test(val)) {
        out[key] = "Bearer " + REDACTED;
      } else {
        out[key] = REDACTED;
      }
      continue;
    }
    out[key] = redactPayload(val, depth + 1);
  }
  return out;
}

/** Payload fields stored on each request-details row that may carry credentials. */
const PAYLOAD_KEYS = ["request", "providerRequest", "providerResponse", "response"];

/**
 * Redact a list of request-details rows for API output.
 *
 * Metadata (model, tokens, latency, status) is preserved verbatim; the stored
 * conversation payloads are returned with credentials masked instead of blanked,
 * so dashboards can render prompts, completions and upstream errors.
 *
 * @param {Array<object>|null|undefined} details
 * @returns {Array<object>}
 */
export function redactDetails(details) {
  return (details || []).map((row) => {
    const out = { ...row };
    for (const key of PAYLOAD_KEYS) {
      if (out[key] !== undefined) {
        out[key] = redactPayload(out[key]);
      }
    }
    return out;
  });
}
