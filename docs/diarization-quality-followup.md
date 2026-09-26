# Batch speaker labeling quality

The current sidecar labels speakers online, one finalized VAD utterance at a time.
It uses the bundled pyannote segmentation model to find turns, WeSpeaker
embeddings to represent voices, and a running centroid registry to keep labels
stable. This supports live insertion, but the first short or noisy turns can
affect later assignments. The registry now labels short turns without learning
from them.

For recorded files, evaluate an offline pass before changing the user-facing
speaker toggle. Preserve the audio locally, collect speech turns across the
whole recording, group embeddings globally, then align transcript words or
short segments to the resulting speaker timeline. Treat overlapping speakers
as overlap instead of forcing all audio into a single identity. Keep the live
online path for microphone dictation, where a whole-recording pass is not
available.

Measure the proposed pass against the current implementation on real
conversations, including interruptions, short acknowledgements, background
music, stereo sources, and returning speakers. Record diarization error rate
(speaker confusion, missed speech, and false alarm), speaker-count error,
overlap performance, transcript word error rate, and processing time. Retain a
human review step for uncertain labels; do not present speaker identities as
verified names.

References:

- [NVIDIA NeMo diarization models](https://docs.nvidia.com/nemo-framework/user-guide/24.09/nemotoolkit/asr/speaker_diarization/models.html) describes the short-turn and time-resolution tradeoff in speaker embeddings.
- [WhisperX](https://github.com/m-bain/whisperX) combines transcription, word alignment, and speaker diarization for recorded audio.
- [pyannote diarization metrics](https://pyannote.github.io/pyannote-metrics/reference.html) defines the scoring components and overlap treatment.
