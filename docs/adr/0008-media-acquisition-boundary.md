---
status: accepted
---

# Keep media acquisition behind a provider-neutral lease boundary

Media acquisition is exposed through `MediaSource.acquire(...)`. The current
local-file adapter opens the native picker once for an interactive acquisition
and returns a typed acquisition plan followed by a `MediaLease`; it does not
retain an abandoned `File` or expose a local reference/token API. The request
carries the shared encoded-byte and duration budgets so a future temporary-file
provider can return another lease implementation without broad type changes.
Referenced-source and YouTube support arrive in the next stacked PR; this
change adds no remote retrieval, `yt-dlp`, or provider-specific fields.

The lease is a temporary capability over opaque bytes. It exposes a real
`ReadableStream` and an idempotent release promise. Decoding consumes the
stream with the existing local decode budgets; the lease is released as soon as
native decode/VAD/ASR transcript work is complete, before any optional media LLM
preview or provider request. A pending workflow remains non-idle through
post-completion cleanup.

The post-completion media LLM boundary receives only raw transcript text and
bounded note context, never a lease, path, URL, provenance, or media metadata.
It is explicitly opt-in, preflight-checked, disclosed with a structured
provider/model/egress/payload description, preview-confirmed, and re-reads
settings before provider work and application. Local Ollama and loopback custom
endpoints are identified as local; OpenRouter and non-loopback custom endpoints
are identified as network providers. The local-first decode/VAD/ASR path remains
independent from the optional text transformation. Custom OpenAI-compatible
chat uses a CORS-free Node HTTP(S) transport with bounded streaming reads,
early size rejection, timeouts, and abort propagation.
