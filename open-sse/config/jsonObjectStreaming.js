// Decide whether a non-streaming request should be sent upstream as a stream.
//
// Why: a client asking for `response_format: {type:"json_object"}` must receive
// one complete JSON document, so it sends `stream:false`. The upstream then
// builds the WHOLE completion before returning any response headers, which means
// our header timer measures prefill + full generation — on a slow free-tier
// model that legitimately takes 90-180s. Retrying cannot help (the next attempt
// needs the same time again), so those requests were killed at the header
// timeout even though the upstream was healthy.
//
// Streaming upstream sidesteps this: headers arrive as soon as the first chunk
// is produced, so the header timer stops measuring generation time and we get a
// real TTFT plus the stall guard. The gateway then re-assembles the SSE into the
// single JSON document the client asked for (handleForcedSSEToJson), so the
// client contract is unchanged.
//
// Scope is deliberately narrow — json_object only:
//   - It is the one shape we have verified end-to-end against a real upstream
//     (nvidia accepts stream + json_object + stream_options.include_usage and
//     returns a parseable document plus usage).
//   - Other non-streaming requests keep today's behaviour until each is
//     verified, so this cannot silently change unrelated traffic.
//   - Image generation is excluded: it is required to be non-streaming and does
//     not go through this chat path anyway.

/** Providers whose SSE support for json_object has been verified. */
const VERIFIED_JSON_OBJECT_STREAM_PROVIDERS = new Set([
  // Verified live: accepts stream + json_object + stream_options.include_usage,
  // returns a parseable document and a trailing usage chunk.
  "nvidia",
  // Treated as supported by the operator (verified out-of-band).
  "openrouter",
]);
// NOTE: `opencode` needs no entry here. It already declares
// transport.forceStream = true, so `stream` is true before this check runs and
// its json_object responses already go through handleForcedSSEToJson.

/**
 * True when the request is a custom/dynamic upstream that speaks the OpenAI
 * chat protocol (`openai-compatible-*`). These are absent from the static
 * PROVIDERS registry, so capability checks must use the id prefix instead.
 * @param {string} provider
 * @returns {boolean}
 */
export function isDynamicOpenAICompatible(provider) {
  return typeof provider === "string" && provider.startsWith("openai-compatible-");
}

/**
 * True when the body asks for a single JSON object response.
 * @param {object} body
 * @returns {boolean}
 */
export function wantsJsonObject(body) {
  return body?.response_format?.type === "json_object";
}

/**
 * Should this request be promoted from non-streaming to streaming upstream?
 *
 * @param {object} options
 * @param {object} options.body - request body (post-translation is fine; the
 *   field survives translation because translators read it from the source body)
 * @param {boolean} options.stream - the stream flag already resolved for this request
 * @param {string} options.provider
 * @param {boolean} [options.isImageGenModel] - true for image-generation models
 * @returns {boolean}
 */
export function shouldStreamJsonObjectRequest({ body, stream, provider, isImageGenModel = false }) {
  // Only promotes requests that would otherwise be non-streaming. A client that
  // already asked for SSE keeps its own semantics (including any response_format
  // it sent) — we must not add stream_options on someone else's stream.
  if (stream !== false) return false;
  if (isImageGenModel) return false;
  if (!wantsJsonObject(body)) return false;
  return isDynamicOpenAICompatible(provider) || VERIFIED_JSON_OBJECT_STREAM_PROVIDERS.has(provider);
}

/**
 * Ensure a promoted request carries the fields streaming needs.
 *
 * `include_usage` is NOT optional: nvidia only emits the usage object when it is
 * requested (verified — without it the final chunk is a bare [DONE]), so token
 * accounting would silently drop to zero for every promoted request.
 *
 * @param {object} body
 * @returns {object} a copy with stream/stream_options applied
 */
export function applyStreamingForJsonObject(body) {
  const existing = body?.stream_options;
  return {
    ...body,
    stream: true,
    stream_options: {
      ...(existing && typeof existing === "object" ? existing : {}),
      include_usage: true,
    },
  };
}
