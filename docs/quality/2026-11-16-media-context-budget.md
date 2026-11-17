# Media duration and model utterance limits

A public audio-file controller regression reproduced a 40-second recording being rejected before starting the native session when the selected batch model advertised a 35-second inference context. The file fits every media safety budget. Native VAD already splits continuous speech at 1,500 twenty-millisecond frames (30 seconds), including a bounded carryover when splitting at a recent silence boundary.

The media controller now checks the existing global decoded audio budget without applying a model's per-utterance context limit to the whole recording. Model adapters retain their inference limits; native segmentation remains unchanged. The separate decoder budget API still supports a model-duration limit for callers that pass an entire recording directly to an engine.

The regression feeds all 2,000 PCM frames through the public controller with actual frame pumping and sidecar consumption acknowledgements, then accepts the final transcript and disposes decoded audio. It failed before the change because the native file session never started; it passes after the change. This controller test verifies routing and lifecycle, rather than simulating model inference or claiming native recognition quality.

Global file acquisition limits, four-hour media duration, in-memory decoded PCM limits, streaming PCM byte limits, backpressure, and native 30-second utterance segmentation remain enforced. A second controller regression checks that oversized streaming media is rejected before starting or pumping audio. Existing decoder tests continue to cover the optional direct-inference model-duration budget.

Validation: 58 controller/decoder tests passed; the full frontend gate passed (type checking, lint, 1,932 tests with ten skipped, and production build). Native segmentation behavior is covered by the existing `session` tests; no native behavior changed in this slice. Interactive long-media verification remains a separate combined-build check.
