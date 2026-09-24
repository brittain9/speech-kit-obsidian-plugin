---
status: accepted
---

# Keep media acquisition behind a provider-neutral lease boundary

Media acquisition is exposed through `MediaSource.acquire(...)`. The current
local-file adapter opens the native picker once for an interactive acquisition,
binds the chosen `File` to an opaque token, and returns a typed acquisition
plan followed by a `LocalMediaLease`. A public referenced acquisition must use
that exact inspected token; it never reopens the picker or silently creates a
new token. This leaves a small, provider-neutral seam for a future referenced
provider adapter without adding remote retrieval, `yt-dlp`, or provider-specific
fields to this change.

The lease is a temporary capability over opaque bytes. It exposes a real
`ReadableStream` and an idempotent release promise. Decoding consumes the
stream with the existing local decode budgets; the lease is released as soon as
native decode/VAD/ASR transcript work is complete, before any optional media LLM
preview or provider request. A pending workflow remains non-idle through
post-completion cleanup.

The post-completion media LLM boundary receives only raw transcript text and
bounded note context, never a lease, path, URL, provenance, or media metadata.
It is explicitly opt-in, preflight-checked, disclosed, preview-confirmed, and
re-reads settings before provider work and application. Local Ollama is
identified as local-only; OpenRouter and custom OpenAI-compatible endpoints are
identified as network providers. The local-first decode/VAD/ASR path remains
independent from the optional text transformation.
