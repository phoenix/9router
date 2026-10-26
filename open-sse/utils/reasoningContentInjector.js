// Some thinking-mode providers (DeepSeek, Kimi, MiniMax, ...) require reasoning_content
// to be echoed back on assistant messages. Clients in OpenAI format don't send it,
// so we inject a non-empty placeholder to satisfy upstream validation.
import { PROVIDERS } from "../config/providers.js";

const PLACEHOLDER = " ";

// Provider-level rules derive from registry transport.reasoningInject (single source)
const providerRuleFor = (provider) => PROVIDERS[provider]?.reasoningInject;

// Model-level rules: matched by predicate against model id
const MODEL_RULES = [
  { match: m => /^kimi-/i.test(m || ""), scope: "toolCalls" },
  { match: m => /deepseek/i.test(m || ""), scope: "all" }
];

const DEEPSEEK_V4_PRO = "deepseek-v4-pro";
const DEEPSEEK_V4_PRO_ALIASES = {
  [`${DEEPSEEK_V4_PRO}-max`]: {
    thinkingType: "enabled",
    reasoningEffort: "max"
  },
  [`${DEEPSEEK_V4_PRO}-none`]: {
    thinkingType: "disabled",
    reasoningEffort: null
  }
};

function shouldInject(message, scope) {
  if (message?.role !== "assistant") return false;
  const rc = message.reasoning_content;
  if (typeof rc === "string" && rc.length > 0) return false;
  if (scope === "toolCalls") return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  return true;
}

// Vendor alias carrying the same reasoning text under a different key. When one is
// present, echo IT back as reasoning_content instead of adding a placeholder next to
// it: two keys that mean the same field are a duplicate-key 400 on strict serde
// upstreams (NVIDIA: "duplicate field `reasoning_content`"), and on any provider they
// would double the replayed reasoning tokens.
function aliasReasoningText(message) {
  if (typeof message?.reasoning === "string" && message.reasoning) return message.reasoning;
  if (Array.isArray(message?.reasoning_details)) {
    const text = message.reasoning_details
      .map((d) => (typeof d === "string" ? d : d?.text || d?.content || "")).join("");
    if (text) return text;
  }
  return "";
}

function applyRule(body, rule) {
  if (!rule || !body?.messages) return body;
  const messages = body.messages.map(m => {
    if (!shouldInject(m, rule.scope)) return m;
    const alias = aliasReasoningText(m);
    if (alias) {
      const { reasoning, reasoning_details, ...rest } = m;
      return { ...rest, reasoning_content: alias };
    }
    return { ...m, reasoning_content: PLACEHOLDER };
  });
  return { ...body, messages };
}

function applyDeepSeekV4ProAlias({ provider, model, body }) {
  const alias = DEEPSEEK_V4_PRO_ALIASES[model];
  if (provider !== "deepseek" || !alias || !body) return body;

  const nextBody = {
    ...body,
    model: DEEPSEEK_V4_PRO,
    extra_body: {
      ...(body.extra_body || {}),
      thinking: {
        ...(body.extra_body?.thinking || {}),
        type: alias.thinkingType
      }
    }
  };

  if (alias.reasoningEffort) {
    nextBody.reasoning_effort = alias.reasoningEffort;
  } else {
    delete nextBody.reasoning_effort;
  }

  return nextBody;
}

export function injectReasoningContent({ provider, model, body }) {
  const providerRule = providerRuleFor(provider);
  const modelRule = MODEL_RULES.find(r => r.match(model));
  const rule = providerRule || modelRule;
  const nextBody = applyDeepSeekV4ProAlias({ provider, model, body });
  return applyRule(nextBody, rule);
}
