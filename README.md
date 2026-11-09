<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/brittain9/speech-kit-obsidian-plugin/main/docs/media/hero-dark.png">
  <img src="https://raw.githubusercontent.com/brittain9/speech-kit-obsidian-plugin/main/docs/media/hero-light.png" alt="Speech Kit — Speech and language toolkit for Obsidian" width="100%">
</picture>

Dictate live. Transcribe audio and video files. Bring YouTube captions into your notes. Translate text. Listen to notes. One plugin inside the editor where your notes already live.

> **Local Dictation is now Speech Kit.** It is the same plugin with the same local-first foundation, now with a name that fits what it has become. Existing installs, settings, and hotkeys carry over automatically.

[Install Speech Kit from Obsidian Community Plugins](https://obsidian.md/plugins?id=local-dictation)

## What it does

- **Dictate:** Capture long sessions with live text and a choice of speech models.
- **Transcribe files:** Drop in audio or video and turn its audio into a local transcript.
- **Import YouTube captions:** Paste a link and bring available captions into your note without downloading the video.
- **Translate and listen:** Translate notes locally and hear them read aloud with natural voices.
- **Refine with AI:** Run a custom preset on a complete transcript or note using a local model or your chosen provider.

<p align="center">
  <img src="https://raw.githubusercontent.com/brittain9/speech-kit-obsidian-plugin/main/docs/media/speech-kit-translation-demo.gif" alt="Speech Kit translating an Obsidian note from English to Spanish and replacing the original text" width="560">
</p>

## Choose the models that fit your workflow

Install the models you need in **Settings → Speech Kit → Manage models**. Available languages and performance depend on the model and your computer.

| You want | Models to consider |
| --- | --- |
| English live dictation | Moonshine, English Nemotron, or Parakeet Unified |
| Multilingual live dictation | Nemotron 3.5 ASR |
| File transcription or batch dictation | Whisper or Cohere Transcribe |
| Local voices | Pocket TTS or Supertonic 3 |
| Local translation | Firefox Translations or Tencent HY-MT 2 |

The setup wizard helps you install the native engine and your first speech model. Review each model’s download size and license before installing it. NVIDIA streaming models run on CPU; performance and delay depend on your computer.

## Dictate, transcribe, translate, listen, and refine

**Dictate.** Streaming words appear and revise in place while you speak. Finished text lands as Markdown at your cursor. Batch models show results after speech is processed.

To keep microphone audio, enable **Save microphone recording** in Speech Kit settings. It is off by default and does not include system audio. When you stop dictation, Speech Kit saves the recording in Obsidian’s attachment location and adds an audio player to the note. Cancelling dictation discards the unfinished recording. Speech Kit also saves the audio if the sidecar stops the session because of an error or backlog. If the player cannot be added, Speech Kit keeps the recording and shows its link. If the recording itself cannot be completed, Speech Kit removes the incomplete file and shows a warning.

**Transcribe files.** Run **Transcribe local audio file** to turn an audio or video recording into text in the current note. Speech Kit extracts the audio with its media decoder and transcribes it with an installed batch speech model. Choose a language, model, timestamps, speaker labels, and paragraph style for that job. Your media stays on your computer.

**Import YouTube captions.** Run **Transcribe YouTube video**, paste a video link, and add its available captions to the current note. Choose the caption language and optional linked timestamps. This command needs an internet connection, but no speech model or video download. Videos without usable captions leave the note unchanged.

Both commands can optionally run one of your AI presets on the complete transcript. AI is separate from transcription; if you choose a remote provider, transcript text is sent to that provider. See the [media transcription guide](docs/guides/media-transcription.md) for setup and options.

**Translate.** Translate a selection or a whole note. Firefox Translations supports 96 English-anchored directions. Tencent HY-MT 2 supports direct translation among its 38 catalog languages. Preview the result before replacing your text, inserting it into the note, or copying it.

**Listen.** Read any note aloud with natural local voices. Control the voice, speed, and playback without leaving Obsidian.

**Refine.** Optional LLM tools can clean up, summarize, restructure, or transform text with your own prompts.

## One toolkit across platforms

Speech Kit supports desktop Obsidian on macOS, Windows, and Linux. Acceleration and system-audio support depend on the platform and model.

| Platform | Architecture                                                | Acceleration                       | System audio           |
| -------- | ----------------------------------------------------------- | ---------------------------------- | ---------------------- |
| macOS    | Apple silicon                                               | Metal for Whisper                  | macOS 14.2 or later    |
| Windows  | x86-64, ARM64 (Snapdragon 8cx or newer)                     | Optional NVIDIA CUDA (x86-64 only) | Supported              |
| Linux    | x86-64, ARM64 glibc (ARMv8.2 or newer, e.g. Raspberry Pi 5) | Optional NVIDIA CUDA (x86-64 only) | PulseAudio or PipeWire |

For Linux and CUDA requirements, see the [Linux guide](docs/guides/linux-support.md) and [CUDA guide](docs/guides/cuda-setup.md). Mobile Obsidian is not supported.

## Getting started

1. Install **Speech Kit** from [Community Plugins](https://obsidian.md/plugins?id=local-dictation).
2. Follow the setup wizard to install the native engine and a speech model.
3. Select **Try dictation now**, or start from the ribbon, command palette, or a hotkey.

Dictation, local file transcription, translation, and read aloud require no account, API key, usage credits, or cloud service. Once their models are installed, they continue working offline. YouTube caption import requires a connection to YouTube.

Optional AI text tools are separate. In **Settings → Speech Kit**, enable **LLM features**, then choose a provider and model under **Provider and model**. Use the sidebar for daily transform controls. See [provider setup](docs/guides/media-transcription.md#configure-an-ai-provider).

## Language support

Each feature is served by a different model, so coverage is tracked per feature rather than as a single list.

| Language                                                               | Transcription | Live dictation | Read aloud | Translation | Interface |
| ---------------------------------------------------------------------- | :-----------: | :------------: | :--------: | :---------: | :-------: |
| English, Spanish, German, French, Portuguese, Italian, Dutch, Japanese |      ✅       |       ✅       |     ✅     |     ✅      |    ✅     |
| Croatian                                                               |      ✅       |       ✅       |     ✅     |      —      |    ✅     |
| Serbian                                                                |      ✅       |       —        |     —      |      —      |     —     |

✅ supported · — not yet available

Coverage depends on the selected model: Whisper Large V3 Turbo covers the transcription languages above, while English models support English only. Multilingual live models do not currently cover Serbian. Translation coverage depends on the selected model. Firefox Translations covers English-anchored directions; Tencent HY-MT 2 supports all-to-all translation among 38 languages, including languages outside the table above.

## Local-first, private by default

Speech Kit works without accounts, subscriptions, or required cloud services.

- **Your media stays on your machine.** Dictation, local file transcription, read aloud, and translation run locally and continue working offline once their models are installed. YouTube caption import retrieves text from YouTube without downloading the video.
- **Local features need no account or API key.** Optional remote providers may require an account, API key, or usage fees.
- **LLM tools are optional.** Add flexible language processing to your workflow using a local model or a remote provider you choose. Text leaves your device only when you explicitly use a remote provider, and audio is never uploaded.
- **Choose what works for you.** Install high-quality models suited to your language, hardware, and workflow.
- **Transparent and open.** Downloads are explicit, third-party licenses are documented, and Speech Kit is open source.

## Support development

If Speech Kit is useful to you, please support development:

<a href="https://buymeacoffee.com/alexbrittaq"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me a Coffee" width="217"></a>

## Development and project links

Speech Kit pairs a TypeScript plugin with a Rust native sidecar. See [CONTRIBUTING.md](CONTRIBUTING.md) for its architecture, setup, and development workflow.

[Community Plugin](https://obsidian.md/plugins?id=local-dictation) · [Latest release](https://github.com/brittain9/speech-kit-obsidian-plugin/releases/latest)

[Issues](https://github.com/brittain9/speech-kit-obsidian-plugin/issues) · [License](LICENSE)

Third-party component and model licenses are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Model details link to each license; some models require you to review terms before installation.
