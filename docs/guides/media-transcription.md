# Transcribe files and YouTube videos

Speech Kit has two commands for adding a transcript to the active Obsidian note. Open either command from the command palette or assign it a hotkey in Obsidian settings.

## Audio or video file

1. Install a compatible batch speech model. If the **Media decoder** is missing, the file dialog offers **Install decoder**; you can also install it from **Settings → Speech Kit → Advanced**. This is a one-time download.
2. Run **Speech Kit: Transcribe local audio file**. Drop an audio or video file into the dialog, or choose **Browse files**.
3. Open **Transcript options** if you want to change the language, batch model, timestamps, speaker labels, or paragraph formatting for this job. These choices do not change your saved dictation settings.
4. Optionally choose an AI preset, then select **Get transcript**. The complete transcript is added to the active note after processing finishes.

The decoder reads the audio track from common containers such as MP3, WAV, M4A, FLAC, Ogg, MP4, MOV, MKV, and WebM. Support depends on the codec inside the file. A missing audio track, unsupported codec, or damaged file produces an error without inserting an incomplete result. Decoded audio is streamed to the local speech engine rather than loaded in full into Obsidian memory. Long recordings can take a while; the dialog shows progress and allows cancellation. If a partial transcript is recoverable, the dialog offers explicit copy and insert actions marked as incomplete.

## YouTube captions

1. Run **Speech Kit: Transcribe YouTube video** and paste a link to a single video.
2. Choose **Original language** or a specific available caption language. Enable **Linked timestamps** if you want passage links back to the video; you can also choose roughly how often passages begin.
3. Optionally choose an AI preset, then select **Get transcript**.

Speech Kit retrieves the video's existing creator captions when available, otherwise its automatic captions. It does not translate captions into an unavailable language. The complete caption result is formatted and inserted once. This command needs an internet connection, but it does not download video or audio, run a speech model, or require the media decoder. If captions are missing, restricted, or cannot be read, the note is left unchanged.

## AI presets and note safety

Choose **Transcript only** to add the raw transcript without AI processing. If you choose a preset, Speech Kit applies that preset to the complete transcript after insertion. A local AI provider keeps transcript text on your computer; a remote provider receives transcript text. The audio or video file itself is never sent to an AI provider. If AI processing fails, the raw transcript remains in the note.

Both commands check that the intended note is still a safe insertion target before writing. You can cancel an active job from its dialog.
