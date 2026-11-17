// Use one ordered feature list for build, lint and test, including Metal on
// macOS, so each step checks the same native dependency graph.
const ALL_ENGINES =
  'engine-whisper,engine-cohere-transcribe,engine-hy-mt,engine-qwen-asr,engine-moonshine,engine-nemotron-asr,engine-parakeet-unified,engine-pocket-tts,engine-supertonic';

export function sidecarFeatures(platform = process.platform) {
  return platform === 'darwin' ? `${ALL_ENGINES},gpu-metal` : ALL_ENGINES;
}
