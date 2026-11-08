# Moonshine Tiny refresh validation

The corrected English Tiny export passed the real sidecar protocol checks. On eight checked-in public English clips, word edits fell from 25 to 16 across 215 reference words. Six clips improved and two tied. This supports refreshing Tiny's catalog artifacts. It does not establish general accuracy or battery gains.

## Exact change and acquisition

`moonshine_tiny_streaming_en` keeps its stable ID, entry filename, seven-file layout, English-only capability, and CPU streaming adapter. Fresh installs use the official Moonshine asset mirror at revision `015f7269048251aff164cb60df02bfea76884c8f`, directory `model/tiny-streaming-en/quantized_26_07_30/`. The full model is **51,441,771 bytes**, 309,976 bytes (0.61%) above the incumbent. The five graph hashes change. Config and tokenizer hashes stay the same. See [exact artifacts and measurements](2026-11-08-moonshine-tiny-results.json).

The 51,441,771-byte model was downloaded once for comparison and once through the actual managed installer, totaling **102,883,542 bytes**. Each file matched its expected size; Hub LFS files also matched the published SHA-256. The two small non-LFS files were hashed after retrieval from the immutable revision. The managed installer then verified all seven catalog hashes. The incumbent already existed in the shared model store, and all seven files matched the old catalog hashes. Fixtures were already in the repository. Only public speech fixtures and generated silence were used.

The upstream MIT license explicitly covers English models. [Pinned license](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/LICENSE). This is a historical monolithic export, selected because the current split-frontend exports require adapter work. See [research and remaining candidates](../research/2026-11-asr-model-opportunities.md).

## Environment and method

- Apple M2 Pro, 16 GiB, macOS 27.2 arm64.
- Existing debug sidecar version `2026.10.1`; SHA-256 `03cdd038f11e27e355d1485beff04930665dbe064fa5bff13a0be47a0ee93a34`. Runtime probe reported Moonshine enabled, CPU-only ONNX, and Whisper Metal support. The binary came from the primary checkout; no inference code was changed for this comparison.
- Each case launched a fresh sidecar process. Files were in the warm OS cache. Models were not retained across cases. There was no forced cold-cache measurement.
- Both models used the same default ORT thread settings, patient VAD, no context, no diarization, 16 kHz mono PCM, 640-byte audio frames, and UUID session envelopes.
- A Python driver used the public framed stdin/stdout protocol, answered context requests, collected revision events, and required `session_stopped` plus clean shutdown. `/usr/bin/time -l` measured per-process maximum RSS.
- Quality pass: eight English fixtures, 75.555 seconds total per model, fast feed, plus two seconds of generated silence. Silence produced no transcript for either model.
- Live pass: three repetitions per model on `7021-79740-0000`, 11.125 seconds each, paced at one frame every 20 ms. Model order alternated. Trailing silence was fed without delay, as a drain stimulus; final-drain times are specific to that procedure.
- Normalization matches the repository scorer: lowercase Unicode letters/numbers, punctuation replaced by spaces, word-level Levenshtein distance. Concurrent desktop and maintenance activity was not controlled. Timing and memory results are descriptive.

## Results

| English fixture    | Reference words | Incumbent edits | Corrected edits |
| ------------------ | --------------: | --------------: | --------------: |
| `jfk`              |              22 |               3 |               1 |
| `3575-170457-0051` |              19 |               3 |               0 |
| `1580-141084-0047` |              22 |               2 |               2 |
| `5683-32866-0024`  |              31 |               5 |               4 |
| `3729-6852-0040`   |              26 |               0 |               0 |
| `7021-79740-0000`  |              26 |               3 |               2 |
| `4446-2271-0004`   |              36 |               8 |               7 |
| `4992-23283-0005`  |              33 |               1 |               0 |
| Total              |             215 | 25 (11.63% WER) |  16 (7.44% WER) |

| Paced live result, median of three       | Incumbent | Corrected |
| ---------------------------------------- | --------: | --------: |
| First nonempty partial after first audio |  947.8 ms |  935.1 ms |
| Final event after stop command           |  192.4 ms |  181.5 ms |
| Sum of reported inference time           |  1,340 ms |  1,384 ms |
| Peak process RSS                         | 406.3 MiB | 387.6 MiB |
| Final word edits                         |    3 / 26 |    2 / 26 |

Every paced case emitted 20–21 nonempty partials, increasing revisions, one final, and a clean stop. Each model's final text was stable across all repetitions and matched its fast-feed final. The candidate's fast-feed maximum RSS was 312.6 MiB versus 289.8 MiB for the incumbent; memory improvement is therefore not a general conclusion. No energy or battery measurement was taken.

The acceptance rule was useful fixture quality gain without a material live-latency or resource regression. These results meet that narrow rule: no clip worsened, live first-partial/final timing stayed similar, and memory stayed far below the 1 GiB investigation threshold. Native Obsidian UI QA remains pending.

## Checks and installation behavior

The new public catalog test failed on the old artifact set before the data change. After the change, the four relevant Vitest files passed (12 tests), and Biome passed for the catalog and test under Node `24.22.2`. That first focused run reused installed dependencies. It was followed by a clean `npm ci` with a worktree-specific temporary cache and the full frontend gate: both typechecks, Biome, Obsidian ESLint, 1,761 tests passed / 10 skipped, and the production bundle.

The native production build and full Rust gate passed: formatting, Clippy with warnings denied, and 407 tests / 23 opt-in tests ignored. The opt-in `streaming_quality_tiny_within_budget` test then passed on all eight corpus fixtures using the corrected assets and the existing VAD/worker/revision path. These native checks used the shared build cache sequentially. They establish macOS behavior; Windows and Linux were not exercised.

Existing installed Tiny models remain usable. A probe with the updated catalog resolved the preserved incumbent install as ready; its frontend still had the old SHA-256 `bbdf5edb120cb3df1adf9ebc07c35136539b007a7047fd148c6f2960fc56fcf1`. The model store reads each install's own artifact metadata and resolves the unchanged `frontend.ort` path. It does not silently replace installed files when the bundled catalog changes.

To refresh an existing Tiny installation after the updated sidecar/catalog is available:

1. Stop dictation, recording, and other speech work.
2. In Manage Models, select another installed speech-to-text model. If Tiny is the only installed model, install and select another speech model first. The UI prevents removal of the selected model.
3. Remove Moonshine Tiny, then install it again. Wait for installation to complete.
4. Select Moonshine Tiny and dictate a short sentence. Stop, then start again and confirm both transcripts appear once.

No automatic migration, fallback, new setting, or new language is introduced. [Removal guard and installed-manifest handling](../../src/models/model-install-manager.ts), [native model resolution](../../native/src/model_store.rs).

A newly built sidecar completed a fresh managed install in an isolated temporary model store. It emitted download, verification, probe, and completed states. The installed catalog selection probed ready and ran the paced fixture with 21 partial revisions and one final (two word edits, matching the comparison). A second silence session in the same process stayed empty and stopped cleanly. The process then shut down cleanly. See the managed-install entry in the measurement JSON.

Native Obsidian UI QA remains separate from these completed build, installer, and protocol checks. It must be recorded before merging.
