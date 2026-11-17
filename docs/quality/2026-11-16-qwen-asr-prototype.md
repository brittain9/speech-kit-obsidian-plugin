# Qwen ASR integration evidence

The separate native ASR helper and the public registry/adapter path transcribed
the pinned German clip correctly with manual language selection and automatic
`de` detection. Output control tokens were removed and no model-derived word
timestamps were claimed. The initial public tests failed before family support;
all three selected registry/real-German tests passed after implementation.

The 0.6B Q8 pair passed eight short language screens and produced 18.5% / 7.7% WER
on the two natural German readings. A new 23.44-second English FLEURS recording
scored 25.7% raw WER, with name errors and numeral-format differences. The 20%
English screen is provisional, not a user requirement or sole adoption veto.
The raw metric remains unchanged. A matched existing-model comparison and exact
error alignment are unfinished. [Observations](2026-11-16-qwen-asr-observations.json)
retain the public-fixture outputs; the new fixture retains reference, provenance,
license and derived WAV hash.

Fresh source review found two lifecycle issues. The public FIFO-companion probe
regression failed by timeout, then passed in 0.01 s after both pair members were
checked as regular files before opening. The helper's stdin reader now watches
owner loss independently of synchronous inference. Its busy subprocess fixture
closes stdin, requires exit within two seconds, and reaps the child; it passed
in 0.03 s. This exercises the real EOF reader with a blocked-operation fixture,
not another real model/GPU run. The reviewer inspected the fixes; execution was
performed separately. Actual in-flight request cancellation/retry subsequently
passed as described below.

The reviewed packaging slice passed 55 focused frontend/script/installer tests and
its full frontend gate (2,032 passed, 15 skipped) before integration. It includes the
third helper in new builds/dev installs and preserves compatibility with released
two-binary archives. New helper and model notices are retained. Combined
validation then proceeded as described below; platform and native UI checks are
tracked separately.

The initial draft was preserved when work stopped on 16 November. Work resumed
on 17 November: the frontend now recognizes and persists `qwen3_asr`, and the
catalog offers an optional 0.6B pair with both artifacts required. Existing
defaults remain unchanged. The focused frontend/catalog suite and full frontend
gate passed (2,056 passed, 16 skipped). This model supports bounded batch input;
streaming capability remains false, with no cached encoder-state or progressive
partial-output claim. The 1.7B candidate and matched-Turbo comparison remain
unexecuted. No release was made. See
[research and pinned artifacts](../research/2026-11-16-qwen-asr-native.md) and
[ADR 0013](../adr/0013-use-native-llama-cpp-for-qwen-asr.md).

## Resumed validation, 17 November

The real public `LoadedModel` cancellation/retry slice passed after the safety
fixes. It first transcribes the German fixture with a resident helper, cancels a
23.1-second request after 150 ms, and requires the canceled helper PID to be absent
when cancellation returns. It then transcribes a different English JFK recording
through the same loaded-model interface, verifies a fresh helper PID and no
canceled German text, and requires model disposal to reap that replacement too.
The complete test passed in 3.90 s; cancellation itself has a three-second bound.
These are lifecycle observations, not a matched inference-speed benchmark.
The full sidecar command cancellation and managed-install/UI checks remain
separate integration steps. The rebuilt production-client metadata/catalog/probe
suite subsequently passed all six cases, as reported by the integrating reviewer.

The combined all-engine Metal debug build passed from `75459ec5`. Three selected
real-model tests then passed serially in 9.53 s: German manual/automatic output,
cancellation/reap/fresh retry, and Qwen/Whisper coexistence. The coexistence test
keeps Qwen's actual helper resident while the parent loads Whisper Base.en and
transcribes the same English recording, then transcribes again through Qwen.
This verifies the process-isolation boundary with both native GGML builds; it is
not a concurrent throughput benchmark. Inference in these tests requested CPU,
even though the binaries also contain Metal support. Native managed-install/UI,
full branch gates and platform checks are tracked separately while the draft is
reviewed.
