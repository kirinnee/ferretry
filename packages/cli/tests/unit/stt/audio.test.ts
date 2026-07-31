import { describe, it } from 'bun:test';
import { STT_MAX_PCM_BYTES } from '@ferretry/protocol';
import should from 'should';
import {
  assertWithinLimits,
  byteLimitFor,
  contentTypeFor,
  encodingOf,
  PCM_CONTENT_TYPE,
  pcmSeconds,
  WAV_CONTAINER_OVERHEAD_LIMIT,
  WAV_CONTENT_TYPE,
} from '../../../src/lib/stt/audio';

describe('audio encoding detection', () => {
  it('should read the encoding off the extension, case and directory notwithstanding', () => {
    // Act + Assert
    should(encodingOf('clip.wav')).equal('wav');
    should(encodingOf('/tmp/a b/CLIP.WAVE')).equal('wav');
    should(encodingOf('./notes.pcm')).equal('pcm');
    should(encodingOf('C:\\audio\\notes.RAW')).equal('pcm');
    should(encodingOf('samples.l16')).equal('pcm');
  });

  it('should refuse an encoding it cannot name rather than letting the daemon reject the upload', () => {
    // Act + Assert
    should(() => encodingOf('clip.mp3')).throw(/cannot tell how "clip.mp3" is encoded/u);
    should(() => encodingOf('clip')).throw(/cannot tell how/u);
    should(() => encodingOf('.hidden')).throw(/cannot tell how/u);
  });

  it('should send each encoding as the content type the daemon expects', () => {
    // Act + Assert
    should(contentTypeFor('wav')).equal(WAV_CONTENT_TYPE);
    should(contentTypeFor('pcm')).equal(PCM_CONTENT_TYPE);
    should(PCM_CONTENT_TYPE).equal('audio/L16; rate=16000; channels=1');
  });

  it('should allow a wav container the header room the daemon allows it', () => {
    // Act + Assert
    should(byteLimitFor('pcm')).equal(STT_MAX_PCM_BYTES);
    should(byteLimitFor('wav')).equal(STT_MAX_PCM_BYTES + WAV_CONTAINER_OVERHEAD_LIMIT);
  });
});

describe('audio limits', () => {
  it('should convert a byte count into the seconds of audio it holds', () => {
    // Act + Assert — 16 kHz mono 16-bit is 32000 bytes per second
    should(pcmSeconds(32_000)).equal(1);
    should(pcmSeconds(STT_MAX_PCM_BYTES)).equal(120);
  });

  it('should accept a clip inside the limit', () => {
    // Act + Assert
    should(() => assertWithinLimits('clip.wav', 'wav', 32_000)).not.throw();
    should(() => assertWithinLimits('clip.pcm', 'pcm', STT_MAX_PCM_BYTES)).not.throw();
  });

  it('should refuse an empty file rather than posting a zero-length body', () => {
    // Act + Assert
    should(() => assertWithinLimits('clip.wav', 'wav', 0)).throw('"clip.wav" is empty');
  });

  it('should name how long the clip is and how long it may be', () => {
    // Act + Assert
    should(() => assertWithinLimits('long.pcm', 'pcm', STT_MAX_PCM_BYTES + 32_000)).throw(
      '"long.pcm" holds about 121s of audio; the daemon transcribes at most 120s',
    );
  });

  it('should refuse a wav file past even the container allowance', () => {
    // Act + Assert
    should(() => assertWithinLimits('long.wav', 'wav', STT_MAX_PCM_BYTES + WAV_CONTAINER_OVERHEAD_LIMIT + 1)).throw(
      /the daemon transcribes at most 120s/u,
    );
  });
});
