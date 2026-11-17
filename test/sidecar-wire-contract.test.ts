import { deepStrictEqual, equal } from 'node:assert/strict';
import { describe, expect, it } from 'vitest';

import {
  AUDIO_FRAME_KIND,
  createHealthCommand,
  createStartSessionCommand,
  createStartTranslationCommand,
  encodeAudioFrame,
  encodeJsonFrame,
  FRAME_HEADER_LENGTH,
  FramedMessageParser,
  JSON_FRAME_KIND,
  parseEventFrame,
  SYNTHESIS_AUDIO_FRAME_KIND,
} from '../src/sidecar/protocol';
import corpus from './fixtures/sidecar-wire-contract.json';

const SESSION_ID = '12345678-1234-4234-9234-123456789abc';
const clientCommands = {
  health: createHealthCommand(),
  session: createStartSessionCommand({
    accelerationPreference: 'auto',
    detailedTimestampsEnabled: false,
    diarizationEnabled: false,
    diarizationMaxSpeakers: null,
    includeSystemAudio: false,
    language: 'en',
    mode: 'always_on',
    modelSelection: {
      kind: 'catalog_model',
      runtimeId: 'whisper_cpp',
      familyId: 'whisper',
      modelId: 'fixture-model',
    },
    sessionStartUnixMs: 0,
    sessionId: SESSION_ID,
    speakingStyle: 'balanced',
  }),
  translation: createStartTranslationCommand({
    accelerationPreference: 'cpu_only',
    modelSelection: {
      kind: 'catalog_model',
      runtimeId: 'llama_cpp',
      familyId: 'tencent_hy_mt',
      modelId: 'fixture-translation',
    },
    sourceLanguage: 'en',
    targetLanguage: 'es',
    texts: ['Public fixture.'],
    translationId: 'translation-fixture',
  }),
};

function bytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

describe('shared sidecar wire contract', () => {
  it('uses the supported corpus revision', () => {
    expect(corpus.version).toBe(1);
  });

  for (const [id, command] of Object.entries(clientCommands)) {
    it(`serializes the ${id} client command to the shared JSON shape`, () => {
      const fixture = corpus.commands.find((candidate) => candidate.id === id);
      if (!fixture) throw new Error(`Missing command fixture: ${id}`);
      const encoded = encodeJsonFrame(command);
      expect(encoded[0]).toBe(JSON_FRAME_KIND);
      expect(new DataView(encoded.buffer).getUint32(1, true)).toBe(
        encoded.byteLength - FRAME_HEADER_LENGTH,
      );
      expect(JSON.parse(new TextDecoder().decode(encoded.slice(FRAME_HEADER_LENGTH)))).toEqual(
        fixture.wire,
      );
    });
  }

  it.each(corpus.events)('validates server event $id', (fixture) => {
    const parse = () => parseEventFrame(JSON.stringify(fixture.wire));
    if (fixture.tsAccepted) expect(parse()).toEqual(fixture.wire);
    else expect(parse).toThrow();
  });

  it.each(corpus.frames)('parses byte-level fixture $id', (fixture) => {
    const parser = new FramedMessageParser<unknown>((text) => JSON.parse(text));
    const parsed = parser.pushChunk(bytes(fixture.hex));
    if (fixture.ts === 'fatal') {
      expect(parsed.fatal).toBeInstanceOf(Error);
      expect(parsed.frames).toEqual([]);
      return;
    }
    expect(parsed.fatal).toBeUndefined();
    if (fixture.ts === 'incomplete') {
      expect(parsed.frames).toEqual([]);
      return;
    }
    expect(parsed.frames).toHaveLength(1);
    const frame = parsed.frames[0];
    if (!frame) throw new Error('Missing decoded frame');
    if (frame.kind === JSON_FRAME_KIND) expect(frame.envelope).toEqual(fixture.json);
    else if (frame.kind === AUDIO_FRAME_KIND) {
      if (fixture.pcmLength === undefined || fixture.pcmByte === undefined)
        throw new Error(`Missing PCM expectation for ${fixture.id}`);
      expect(frame.sessionId).toBe(fixture.sessionId);
      expect(frame.frameBytes).toEqual(new Uint8Array(fixture.pcmLength).fill(fixture.pcmByte));
    } else {
      expect(frame.kind).toBe(SYNTHESIS_AUDIO_FRAME_KIND);
      expect(frame.synthesisId).toBe(fixture.synthesisId);
      expect(frame.seq).toBe(fixture.sequence);
      expect(frame.pcm16le).toEqual(bytes(fixture.pcmHex ?? ''));
    }
  });

  it('matches the independent microphone envelope bytes', () => {
    const fixture = corpus.frames.find((candidate) => candidate.id === 'microphone-audio');
    if (!fixture) throw new Error('Missing microphone frame fixture');
    expect(encodeAudioFrame(SESSION_ID, new Uint8Array(640).fill(7))).toEqual(bytes(fixture.hex));
  });

  it('rejects the invalid UUID fixture when encoding outgoing microphone audio', () => {
    const fixture = corpus.frames.find((candidate) => candidate.id === 'wrong-audio-uuid-version');
    if (!fixture?.sessionId) throw new Error('Missing invalid microphone UUID fixture');
    expect(() => encodeAudioFrame(fixture.sessionId, new Uint8Array(640).fill(7))).toThrow(
      'UUID v4',
    );
  });

  it('handles every split point and coalesced frames in the shared corpus', () => {
    const complete = corpus.frames.filter((fixture) => fixture.ts === 'accepted');
    const joined = new Uint8Array(Buffer.concat(complete.map((fixture) => bytes(fixture.hex))));
    const expected = complete.map((fixture) => {
      if (fixture.json !== undefined) return { kind: JSON_FRAME_KIND, envelope: fixture.json };
      if (fixture.sessionId !== undefined) {
        if (fixture.pcmLength === undefined || fixture.pcmByte === undefined)
          throw new Error('Missing microphone PCM expectation');
        return {
          kind: AUDIO_FRAME_KIND,
          sessionId: fixture.sessionId,
          frameBytes: new Uint8Array(fixture.pcmLength).fill(fixture.pcmByte),
        };
      }
      return {
        kind: SYNTHESIS_AUDIO_FRAME_KIND,
        synthesisId: fixture.synthesisId,
        seq: fixture.sequence,
        pcm16le: bytes(fixture.pcmHex ?? ''),
      };
    });
    for (let split = 0; split <= joined.byteLength; split += 1) {
      const parser = new FramedMessageParser<unknown>((text) => JSON.parse(text));
      const first = parser.pushChunk(joined.slice(0, split));
      const second = parser.pushChunk(joined.slice(split));
      equal(first.fatal, undefined, `split ${split}`);
      equal(second.fatal, undefined, `split ${split}`);
      deepStrictEqual([...first.frames, ...second.frames], expected, `split ${split}`);
    }
  });
});
