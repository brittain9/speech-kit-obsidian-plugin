# Hardware context for model evaluations

Capture the execution host once per evaluation run, alongside the fixture and
model evidence. The collector uses Node's OS APIs and read-only Git commands;
it does not load a model, initialize a GPU, enumerate remote machines, or record
hostnames, serial numbers, usernames, network details, or filesystem paths.

```sh
node scripts/evaluation-environment.mjs \
  --requested-acceleration cpu \
  --model-state cold-process \
  --output /tmp/evaluation-environment.json
```

`collectEvaluationEnvironment(options)` is also exported from
`scripts/lib/evaluation-environment.mjs` for runners to capture the same object.
A runner should attach the object once per run, rather than creating a different
hardware snapshot for every case. The standalone CLI writes JSON to stdout when
`--output` is omitted. No package installation or native build is required beyond
the project's existing Node toolchain.

The object separates OS observations (`host`), checkout/tool metadata
(`software`), and caller declarations (`execution`). A requested backend is not
an observed backend: effective acceleration remains `unknown`/`unobserved`.
A model name, CPU label, compiled Metal/CUDA feature or configured preference
cannot establish that inference used that device. Runtime offload evidence must
be recorded separately by the evaluation harness. An optional
`--inference-threads N` declares a positive configured thread count; omit it when
the adapter or runtime chooses its own policy. Logical CPU count and available
parallelism describe host capacity, not inference threads or physical cores.

`cold-process` means a newly started process, `warm-model` means the harness
intends to reuse loaded model weights, and `mixed` describes a run containing
both. These are explicit harness declarations. None means that OS file caches
were flushed. Filesystem cache state remains `uncontrolled`; load averages and
OS free memory are snapshots, not proof of exclusive resources or available
model capacity. Windows load average is `null`, since Node's Windows zero values
do not measure idle load. Missing CPU descriptors produce an unknown logical
count instead of inventing zero cores. `osRelease` is the kernel/OS release
reported by Node, not a normalized product version.

Git commit and tracked worktree state describe the collector's checkout. They do
not prove which source built an installed binary, include untracked inputs, or
identify model weights. Record the actual executable/build profile and artifact
hashes with the run's evidence. Keep fixture inputs, normalization, model
artifacts, configured backend/threads, load inclusion, and model reuse comparable
before drawing timing or quality conclusions. Alternating order and repeated
runs help expose cache and concurrent-work effects; this snapshot alone is not a
controlled benchmark.

## Coverage established by this project

The existing [CI matrix](../../.github/workflows/ci.yml) builds and checks portable
Linux x64, macOS Metal, Windows x64/ARM64 and Linux ARM64. These are native build,
protocol and model-free correctness lanes. They do not establish microphone,
real-model GPU inference, or comparative performance on each platform.

Project [model validation](2026-11-16-qwen-asr-prototype.md) and
[Whisper measurements](2026-11-16-compact-multilingual-whisper.md) establish bounded
real-model runs on an Apple M2 Pro with 16 GiB. A fresh collector invocation on
17 November observed macOS/Darwin arm64, 12 logical CPUs, 12 available logical
processors and 17,179,869,184 OS-visible memory bytes. It ran no inference and
reported effective acceleration as unknown. Existing project documents/config
identify no additional user-controlled machine that can be used autonomously
for real-model testing; the CI runner labels are not a remote machine inventory.

For another authorized host, run the same collector and pinned fixture suite
there, retaining the exact model/binary identities and run conditions. Compare
CPU and GPU requests separately, verify actual device use independently, and
keep process startup, model load and resident-model timing distinct. Do not turn
a successful cross-platform build into a claim of measured hardware coverage.
