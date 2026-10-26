import { getCapabilitiesForModel } from "../../providers/capabilities.js";

// Strip request params a given provider/model rejects upstream (e.g. HTTP 400).
// Config-driven: add a rule instead of scattering `delete body.x` across executors.

// Each rule: optional provider, regex match on model, list of params to drop.
// A param is removed only when it is present (!== undefined).
const STRIP_RULES = [
  // All Claude models: temperature deprecated/rejected upstream (Anthropic 400). #1748
  { match: /claude/i, drop: ["temperature"] },
  // GitHub Copilot gpt-5.4: temperature unsupported.
  { provider: "github", match: /gpt-5\.4/i, drop: ["temperature"] },
  // GitHub Copilot Claude (except opus/sonnet 4.6): thinking + reasoning_effort rejected. #713
  { provider: "github", match: (m) => /claude/i.test(m) && !/claude.*(opus|sonnet).*4\.6/i.test(m), drop: ["thinking", "reasoning_effort"] },
  // Cloudflare Workers AI: content must be plain string, rejects OpenAI content-part array (#1926)
  { provider: "cloudflare-ai", flattenContent: true },
  { provider: "volcengine-ark", match: /glm-5/i, clampToModelMaxOutput: true },
  // VolcEngine Ark caps the Kimi family at max_tokens <= 32768, but the model's
  // advertised ceiling is far higher (Kimi-K2.7-Code resolves to maxOutput 262144),
  // so clampToModelMaxOutput alone leaves it uncapped and the request 400s with
  // "integer above maximum value, expected <= 32768". Pin an explicit endpoint cap;
  // min() with the model ceiling still applies if a variant's own limit is lower.
  { provider: "volcengine-ark", match: /kimi/i, maxOutputCap: 32768, clampToModelMaxOutput: true },
  // Strict OpenAI-compatible validators reject unknown assistant-message fields.
  // Clients that talk to reasoning models (e.g. Hermes) echo the prior turn's
  // reasoning back on every assistant message; Groq answers 400 and Mistral 422
  // ("extra_forbidden") on it, which knocks these providers out of every
  // multi-turn combo. Providers that *require* the field (DeepSeek, Kimi) are
  // handled by reasoningContentInjector and are not listed here.
  { provider: "groq", dropMessageFields: ["reasoning_content", "reasoning", "reasoning_details"] },
  { provider: "mistral", dropMessageFields: ["reasoning_content", "reasoning", "reasoning_details"] },
  { provider: "cerebras", dropMessageFields: ["reasoning_content", "reasoning", "reasoning_details"] },
  // OpenCode Go's relay rejects `response_format` for its deepseek family with HTTP
  // 400 — both json_schema and json_object — while glm / kimi / mimo / minimax /
  // qwen / grok / gpt on the same relay accept it. The rejection body is either a
  // bare model echo (`{"model":"deepseek-v4.1-flash"}`, which names neither the
  // field nor the reason) or "This response_format type is unavailable now", so a
  // client cannot classify it and keeps re-sending the field. Measured 2026-10-13
  // against /zen/go/v1/chat/completions with one key: 12/12 structured calls 400,
  // 4/4 identical calls without the field 200.
  { provider: "opencode-go", match: /^deepseek/i, drop: ["response_format"] },
  // Current OpenAI models (gpt-5.x / gpt-6.x) reject `max_tokens` with HTTP 400
  // ("Use 'max_completion_tokens' instead"). Clients send `max_tokens`, so rename it.
  { provider: "openai", renameParams: { max_tokens: "max_completion_tokens" } },
  // NVIDIA NIM deserializes the request into a Rust struct where `reasoning`,
  // `reasoning_content` and `reasoning_details` are serde aliases of ONE field, so
  // an assistant turn replaying both keys fails to deserialize:
  //   "duplicate field `reasoning_content` at line 1 column 218817" (HTTP 400).
  // Agent clients (Hermes etc.) echo both, with identical text. Collapse them to
  // the canonical key — keeping reasoning_content (NVIDIA's reasoning models
  // require the pass-back) and never losing a lone alias.
  { provider: "nvidia", dedupeReasoningAliases: true },
];

// One assistant turn → at most one reasoning key. Prefers reasoning_content, then
// the `reasoning` alias, then `reasoning_details[]`; drops the aliases NVIDIA's
// strict serde would collide on. Leaves the turn untouched when it carries none.
function collapseReasoningAliases(msg) {
  const canonical = typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
  const alias = typeof msg.reasoning === "string" ? msg.reasoning : "";
  const details = Array.isArray(msg.reasoning_details)
    ? msg.reasoning_details.map(d => (typeof d === "string" ? d : d?.text || d?.content || "")).join("")
    : "";
  const text = canonical || alias || details;
  if (text) msg.reasoning_content = text;
  else if ("reasoning_content" in msg) delete msg.reasoning_content;
  delete msg.reasoning;
  delete msg.reasoning_details;
}

// Test a rule's match (regex or predicate) against the model id.
function matches(rule, model) {
  if (!rule.match) return true;
  return typeof rule.match === "function" ? rule.match(model) : rule.match.test(model);
}

function clampNumber(body, key, ceiling) {
  if (typeof body[key] === "number" && Number.isFinite(body[key]) && body[key] > ceiling) {
    body[key] = ceiling;
  }
}

// Remove unsupported params from body in place; returns body.
export function stripUnsupportedParams(provider, model, body) {
  if (!model || !body || typeof body !== "object") return body;
  for (const rule of STRIP_RULES) {
    if (rule.provider && rule.provider !== provider) continue;
    if (!matches(rule, model)) continue;
    // Rename params (keeps an explicit target value if the client already sent one).
    for (const [from, to] of Object.entries(rule.renameParams || {})) {
      if (body[from] === undefined) continue;
      if (body[to] === undefined) body[to] = body[from];
      delete body[from];
    }
    for (const key of rule.drop || []) {
      if (body[key] !== undefined) delete body[key];
    }
    // Per-message field drop (assistant turns only — that is where clients replay reasoning).
    if (Array.isArray(rule.dropMessageFields) && Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (!msg || msg.role !== "assistant") continue;
        for (const key of rule.dropMessageFields) {
          if (msg[key] !== undefined) delete msg[key];
        }
      }
    }
    // Per-message reasoning alias collapse (assistant turns only — that is where
    // clients replay reasoning, and where a duplicate key collides upstream).
    if (rule.dedupeReasoningAliases && Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (msg && msg.role === "assistant") collapseReasoningAliases(msg);
      }
    }
    // CF Workers AI oneOf root schema only accepts content as plain string (#1926)
    if (rule.flattenContent && Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (msg && Array.isArray(msg.content)) {
          msg.content = msg.content
            .map(b => (b?.type === "text" && typeof b.text === "string") ? b.text : "")
            .join("");
        }
      }
    }
    if (rule.clampToModelMaxOutput || Number.isFinite(rule.maxOutputCap)) {
      const modelCeiling = getCapabilitiesForModel(provider, model).maxOutput;
      const candidates = [];
      if (rule.clampToModelMaxOutput && Number.isFinite(modelCeiling) && modelCeiling > 0) {
        candidates.push(modelCeiling);
      }
      if (Number.isFinite(rule.maxOutputCap) && rule.maxOutputCap > 0) {
        candidates.push(rule.maxOutputCap);
      }
      if (candidates.length > 0) {
        const ceiling = Math.min(...candidates);
        clampNumber(body, "max_tokens", ceiling);
        clampNumber(body, "max_completion_tokens", ceiling);
        clampNumber(body, "max_output_tokens", ceiling);
      }
    }
  }
  return body;
}
