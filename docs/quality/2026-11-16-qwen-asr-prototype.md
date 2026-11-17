# Qwen ASR draft prototype: preserved at wrap-up

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
performed separately. Actual in-flight request cancellation/retry remains pending.

The reviewed packaging slice passed 55 focused frontend/script/installer tests and
its full frontend gate (2,032 passed, 15 skipped) before integration. It includes the
third helper in new builds/dev installs and preserves compatibility with released
two-binary archives. New helper and model notices are retained. Full combined
branch gates, all-engine coexistence, platform/native UI checks, and a production
managed pair-install/probe/remove run remain incomplete.

Work stopped at the user's request: no 1.7B download, matched-Turbo run, progressive
partial transcription, frontend family-ID/import/catalog integration, or catalog
adoption. Streaming capability remains false; there is no cached stateful
streaming claim. The branch is a reviewable draft, not ready for daily-use
installation. Existing defaults and releases remain unchanged. See
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
separate integration steps.
