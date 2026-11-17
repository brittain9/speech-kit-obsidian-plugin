# Shared sidecar wire corpus

`sidecar-wire-contract.json` is consumed by `test/sidecar-wire-contract.test.ts`
and `native/tests/shared_wire_contract.rs`. Edit this corpus when changing an
intentional contract, then run both suites. JSON key order is irrelevant.
Binary fixtures are authored byte expectations rather than serializer snapshots.

- `commands`: accepted/rejected server inputs and canonical decoded defaults.
  The TypeScript tests compare real command constructors against the named
  health/session/translation wire shapes. Legacy omitted fields are server
  compatibility inputs; the typed client emits explicit session defaults.
- `events`: server serialization shapes and client acceptance. Unknown event
  fields survive client parsing and are ignored by Rust serde; canonical output
  records the server shape. Negative cases cover unknown events and invalid
  translation output. Rust serde accepts some shapes that the client rejects
  semantically (empty IDs and progress beyond total); those asymmetries are
  explicit fixtures, not claims that the server emits them.
- `frames`: exact JSON/audio envelope bytes, UUID version, little-endian
  synthesis IDs/sequences, odd PCM, unknown kinds, truncated input, the exact
  16 MiB cap, and oversized headers. Streaming TypeScript buffers incomplete
  frames; Rust's blocking reader errors on EOF mid-frame. Rust rejects incoming
  synthesis frames because they only travel from server to client.
  Rust validates UUIDv4 on incoming microphone frames. The TypeScript decoder
  accepts raw 16-byte IDs, while its outgoing encoder requires UUIDv4; the
  connection does not consume inbound microphone frames.

The client tests exercise every split point of coalesced frames. Rust exercises
fragmented reads at several chunk sizes and consecutive frames in one stream.
All assertions use fixture expectations; no shared generated schema is required.

Run `npm run test -- test/sidecar-wire-contract.test.ts` and
`cargo test --manifest-path native/Cargo.toml --test shared_wire_contract`.
Both are part of the ordinary frontend/native test suites. No models are needed.
ADR 0007 and `scripts/verify-sidecar-compatibility.mjs` remain the release-policy
authority; these tests add evidence without changing compatibility policy.

Desktop configuration/status commands and registration/action events share the same framed JSON stream. `generation` rejects events from replaced configurations, and `actionId` rejects duplicate activations. Desktop status never carries transcript contents.
