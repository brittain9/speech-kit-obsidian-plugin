# Compact multilingual Whisper Small

Validated as an optional compact multilingual batch choice, with measured
accuracy tradeoffs. [Measurements and native QA status](../quality/2026-11-16-compact-multilingual-whisper.md).

## Candidate and validation budget

After German streaming Tiny failed the unsegmented long-utterance quality floor,
validate Whisper Small Q5_1 as a smaller multilingual batch option. It reuses the
existing Whisper adapter, tokenizer embedded in GGML, CPU/Metal support, and
managed-install path. This is a download/resource tier alongside Turbo, not a
new language or streaming claim.

Before download: one new 190,085,487-byte model, at most 200 MB of weight transfer
plus a bounded fresh managed-install verification; reuse installed Turbo for
comparison. The parent later raised the combined model-work envelope to 2 GB
transfers and 6 GB extra disk. No queue of more model families or paid
resources. Test English and German public fixtures, silence, cancellation,
managed install/probe/removal, and matched quality/latency/memory against Turbo.

The exact [official model snapshot](https://huggingface.co/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1)
contains `ggml-small-q5_1.bin`, size 190,085,487, SHA-256
`ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb`.
The existing pinned Turbo Q8_0 file is 874,188,075 bytes. Model files use the
existing MIT-licensed Whisper/whisper.cpp route; existing notices remain applicable.

Actual Small transfers: one unique 190,085,487-byte artifact plus a fresh managed
installer download of those same bytes. Final installer revalidation replayed
the verified file locally instead of downloading it again. Two small public
German WAV fixtures were also added with source attribution and hashes.

The ten short language fixtures and two natural longer German clips passed
their existing quality floors; measured error rates differ by language and
favor Turbo on several samples. This is not a general accuracy leaderboard.
Native Obsidian, Metal, Windows, Linux, and CUDA behavior remain unverified until
exercised.
