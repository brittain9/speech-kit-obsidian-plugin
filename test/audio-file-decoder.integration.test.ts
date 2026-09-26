import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FfmpegAudioFileDecoder,
  type FfmpegProcessRunner,
  pumpDecodedAudioFrames,
} from '../src/audio/audio-file-decoder';
import { runManagedProcess } from '../src/media/process-runner';
import { PCM_BYTES_PER_FRAME } from '../src/shared/pcm-format';

const ffmpegPath = process.env.SPEECHKIT_FFMPEG_TEST_BIN;
const ffprobePath = process.env.SPEECHKIT_FFPROBE_TEST_BIN;
const fixtureFfmpegPath = process.env.SPEECHKIT_FFMPEG_FIXTURE_BIN ?? ffmpegPath;
const canRunFfmpegIntegration = ffmpegPath !== undefined && ffprobePath !== undefined;

const fixtures = [
  { extension: 'mp3', audioCodec: 'libmp3lame' },
  { extension: 'wav', audioCodec: 'pcm_s16le' },
  { extension: 'm4a', audioCodec: 'aac' },
  { extension: 'flac', audioCodec: 'flac' },
  { extension: 'ogg', audioCodec: 'vorbis' },
  { extension: 'mp4', audioCodec: 'aac', videoCodec: 'mpeg4' },
  { extension: 'mov', audioCodec: 'aac', videoCodec: 'mpeg4' },
  { extension: 'mkv', audioCodec: 'flac', videoCodec: 'ffv1' },
  { extension: 'webm', audioCodec: 'vorbis', videoCodec: 'libvpx' },
] as const;

describe.skipIf(!canRunFfmpegIntegration)('FFmpeg media decoding integration', () => {
  it.each(fixtures)(
    'streams stereo $extension into mono PCM and removes staged media',
    async (fixture) => {
      if (ffmpegPath === undefined || ffprobePath === undefined) {
        throw new Error('FFmpeg test paths missing.');
      }
      const directory = await mkdtemp(join(tmpdir(), 'speech-kit-ffmpeg-test-'));
      const inputPath = join(directory, `media.${fixture.extension}`);
      let stagedInputPath = '';
      const processRunner: FfmpegProcessRunner = async (command, args, spawnOptions, limits) => {
        if (command === ffprobePath) stagedInputPath = args[args.indexOf('-i') + 1] ?? '';
        return await runManagedProcess(command, args, spawnOptions, limits);
      };
      try {
        const videoArgs =
          'videoCodec' in fixture
            ? ['-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=1:d=1', '-c:v', fixture.videoCodec]
            : [];
        const generated = await runManagedProcess(
          fixtureFfmpegPath ?? ffmpegPath,
          [
            '-nostdin',
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'aevalsrc=0.4*sin(2*PI*440*t)|0.2*sin(2*PI*880*t):s=48000:d=1',
            ...videoArgs,
            '-c:a',
            fixture.audioCodec,
            '-strict',
            '-2',
            '-ac',
            '2',
            '-y',
            inputPath,
          ],
          { shell: false, stdio: 'ignore' },
          { maxOutputBytes: 1, stderrLimitBytes: 1_000, timeoutMs: 30_000 },
        );
        expect(generated.exitCode, generated.stderr).toBe(0);
        const bytes = await readFile(inputPath);
        const file = new File([bytes], `media.${fixture.extension}`);
        const decoder = new FfmpegAudioFileDecoder({
          getExecutables: () => ({ ffmpegPath, ffprobePath }),
          runProcess: processRunner,
        });
        const decoded = await decoder.decode(file, new AbortController().signal);
        let frameCount = 0;
        await pumpDecodedAudioFrames(decoded, {
          signal: new AbortController().signal,
          waitForBackpressure: async () => {},
          writeFrame: async (frame) => {
            expect(frame.byteLength).toBe(PCM_BYTES_PER_FRAME);
            frameCount += 1;
          },
        });

        expect(decoded.numberOfChannels).toBe(1);
        expect(decoded.sampleRate).toBe(16_000);
        expect(frameCount).toBeGreaterThan(40);
        await expect(readFile(stagedInputPath)).rejects.toThrow();
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
  );

  it('rejects a video without audio and a corrupt file, then removes staged media', async () => {
    if (ffmpegPath === undefined || ffprobePath === undefined) {
      throw new Error('FFmpeg test paths missing.');
    }
    const directory = await mkdtemp(join(tmpdir(), 'speech-kit-ffmpeg-negative-test-'));
    const videoPath = join(directory, 'silent.mp4');
    const corruptPath = join(directory, 'corrupt.mp3');
    const stagedPaths: string[] = [];
    const processRunner: FfmpegProcessRunner = async (command, args, spawnOptions, limits) => {
      if (command === ffprobePath) stagedPaths.push(args[args.indexOf('-i') + 1] ?? '');
      return await runManagedProcess(command, args, spawnOptions, limits);
    };
    try {
      const generated = await runManagedProcess(
        fixtureFfmpegPath ?? ffmpegPath,
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=black:s=32x32:r=1:d=1',
          '-an',
          '-c:v',
          'mpeg4',
          '-y',
          videoPath,
        ],
        { shell: false, stdio: 'ignore' },
        { maxOutputBytes: 1, stderrLimitBytes: 1_000, timeoutMs: 30_000 },
      );
      expect(generated.exitCode, generated.stderr).toBe(0);
      await writeFile(corruptPath, 'not a media file');
      const decoder = new FfmpegAudioFileDecoder({
        getExecutables: () => ({ ffmpegPath, ffprobePath }),
        runProcess: processRunner,
      });
      const silentFile = new File([await readFile(videoPath)], 'silent.mp4');
      await expect(decoder.decode(silentFile, new AbortController().signal)).rejects.toThrow(
        'no audio track',
      );
      const corruptFile = new File([await readFile(corruptPath)], 'corrupt.mp3');
      await expect(decoder.decode(corruptFile, new AbortController().signal)).rejects.toThrow();
      expect(stagedPaths).toHaveLength(2);
      for (const stagedPath of stagedPaths) {
        await expect(readFile(stagedPath)).rejects.toThrow();
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
