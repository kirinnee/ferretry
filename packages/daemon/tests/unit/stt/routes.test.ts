import { describe, it } from 'bun:test';
import should from 'should';
import {
  allowedMethods,
  declaredBodyRefusal,
  matchesIfNoneMatch,
  matchSttRoute,
  methodNotAllowed,
  modelFileEtag,
  parseByteRange,
  requestedContainer,
  SttEnhancementError,
  SttError,
  sttErrorStatus,
  sttErrorView,
  sttFailureResponse,
} from '../../../src/lib/index.ts';

describe('route matching', () => {
  it('should resolve every route the surface owns', () => {
    // Act
    const actual = {
      status: matchSttRoute('/v1/stt/status'),
      models: matchSttRoute('/v1/stt/models'),
      model: matchSttRoute('/v1/stt/models/parakeet-v2'),
      install: matchSttRoute('/v1/stt/models/parakeet-v2/install'),
      transcribe: matchSttRoute('/v1/stt/transcribe'),
      enhance: matchSttRoute('/v1/stt/enhance'),
      file: matchSttRoute('/stt-models/parakeet-v2/vocab.txt'),
      encoded: matchSttRoute('/stt-models/parakeet-v2/vocab%2Etxt'),
    };

    // Assert
    should(actual.status).deepEqual({ kind: 'status' });
    should(actual.models).deepEqual({ kind: 'models' });
    should(actual.model).deepEqual({ kind: 'model', modelId: 'parakeet-v2' });
    should(actual.install).deepEqual({ kind: 'install', modelId: 'parakeet-v2' });
    should(actual.transcribe).deepEqual({ kind: 'transcribe' });
    should(actual.enhance).deepEqual({ kind: 'enhance' });
    should(actual.file).deepEqual({ kind: 'public-file', modelId: 'parakeet-v2', fileName: 'vocab.txt' });
    should(actual.encoded).deepEqual({ kind: 'public-file', modelId: 'parakeet-v2', fileName: 'vocab.txt' });
  });

  it('should refuse a path whose components smuggle a separator or a terminator', () => {
    // Act
    const actual = [
      matchSttRoute('/stt-models/parakeet/nested%2Fvocab.txt'),
      matchSttRoute('/stt-models/parakeet/vocab%00.txt'),
      matchSttRoute('/stt-models/parakeet/%2e%2e%2fetc%2fpasswd'),
      matchSttRoute('/stt-models/parakeet/bad%zz'),
      matchSttRoute('/v1/stt/models/%2e%2e%2fvictim/install'),
      matchSttRoute('/v1/stt/models/bad%zz'),
      matchSttRoute('/stt-models/parakeet'),
      matchSttRoute('/stt-models/a/b/c'),
      matchSttRoute('/stt-models//vocab.txt'),
      matchSttRoute('/v1/stt/unknown'),
      matchSttRoute('/'),
    ];

    // Assert
    should(actual.every(route => route === undefined)).be.true();
  });

  it('should state the methods each route accepts', () => {
    // Act
    const actual = {
      status: allowedMethods({ kind: 'status' }),
      models: allowedMethods({ kind: 'models' }),
      model: allowedMethods({ kind: 'model', modelId: 'm' }),
      install: allowedMethods({ kind: 'install', modelId: 'm' }),
      transcribe: allowedMethods({ kind: 'transcribe' }),
      enhance: allowedMethods({ kind: 'enhance' }),
      file: allowedMethods({ kind: 'public-file', modelId: 'm', fileName: 'f' }),
    };

    // Assert
    should(actual).deepEqual({
      status: ['GET'],
      models: ['GET'],
      model: ['GET'],
      install: ['GET', 'POST'],
      transcribe: ['POST'],
      enhance: ['POST'],
      file: ['GET', 'HEAD'],
    });
    should(methodNotAllowed({ kind: 'install', modelId: 'm' }).message).equal('method not allowed; expected GET, POST');
  });
});

describe('failure views', () => {
  it('should map a domain code to its status and a body-free view', () => {
    // Act
    const actual = {
      busy: sttErrorStatus('busy'),
      tooLong: sttErrorStatus('too_long'),
      notFound: sttErrorStatus('model_not_found'),
      closed: sttErrorStatus('service_closed'),
      view: sttErrorView(new SttError('bad_audio', 'audio is empty')),
    };

    // Assert
    should(actual.busy).equal(409);
    should(actual.tooLong).equal(413);
    should(actual.notFound).equal(404);
    should(actual.closed).equal(503);
    should(actual.view).deepEqual({ error: 'audio is empty', code: 'bad_audio' });
  });

  it('should answer each failure family with its own status', () => {
    // Act
    const actual = {
      domain: sttFailureResponse(new SttError('busy', 'the batch transcriber is busy')),
      enhancement: sttFailureResponse(new SttEnhancementError('rate_limited', 'slow down')),
      unknown: sttFailureResponse(new TypeError('undefined is not a function')),
    };

    // Assert
    should(actual.domain).deepEqual({ status: 409, body: { error: 'the batch transcriber is busy', code: 'busy' } });
    should(actual.enhancement).deepEqual({ status: 429, body: { error: 'slow down', code: 'rate_limited' } });
    should(actual.unknown.status).equal(500);
    should(actual.unknown.body).deepEqual({ error: 'speech-to-text request failed', code: 'decode_failed' });
  });
});

describe('request framing', () => {
  it('should recognize the containers the transcriber accepts', () => {
    // Act
    const actual = {
      wav: requestedContainer('audio/wav'),
      xWav: requestedContainer('Audio/X-WAV; charset=binary'),
      l16: requestedContainer('audio/L16; rate=16000'),
      pcm: requestedContainer('audio/pcm'),
      other: requestedContainer('application/json'),
      absent: requestedContainer(null),
    };

    // Assert
    should(actual).deepEqual({
      wav: 'wav',
      xWav: 'wav',
      l16: 'pcm16le',
      pcm: 'pcm16le',
      other: undefined,
      absent: undefined,
    });
  });

  it('should refuse a declared body over the limit before anything is read', () => {
    // Act
    const actual = {
      absent: declaredBodyRefusal(null, 100),
      under: declaredBodyRefusal('100', 100),
      over: declaredBodyRefusal('101', 100),
      junk: declaredBodyRefusal('lots', 100),
      negative: declaredBodyRefusal('-1', 100),
    };

    // Assert
    should(actual.absent).be.undefined();
    should(actual.under).be.undefined();
    should(actual.over?.code).equal('too_long');
    should(actual.junk?.code).equal('bad_request');
    should(actual.negative?.code).equal('bad_request');
  });
});

describe('conditional and ranged model files', () => {
  it('should tag a file by its pinned digest and honour if-none-match', () => {
    // Arrange
    const etag = modelFileEtag('a'.repeat(64));

    // Act
    const actual = {
      etag,
      exact: matchesIfNoneMatch(etag, etag),
      weak: matchesIfNoneMatch(`W/${etag}`, etag),
      wildcard: matchesIfNoneMatch('*', etag),
      list: matchesIfNoneMatch(`"other", ${etag}`, etag),
      miss: matchesIfNoneMatch('"other"', etag),
      absent: matchesIfNoneMatch(null, etag),
    };

    // Assert
    should(actual.etag).equal(`"sha256-${'a'.repeat(64)}"`);
    should([actual.exact, actual.weak, actual.wildcard, actual.list]).deepEqual([true, true, true, true]);
    should([actual.miss, actual.absent]).deepEqual([false, false]);
  });

  it('should parse the ranges it can serve and reject the rest', () => {
    // Act
    const actual = {
      absent: parseByteRange(null, 100),
      closed: parseByteRange('bytes=0-9', 100),
      open: parseByteRange('bytes=90-', 100),
      suffix: parseByteRange('bytes=-10', 100),
      clamped: parseByteRange('bytes=95-200', 100),
      whole: parseByteRange('bytes=0-99', 100),
      pastEnd: parseByteRange('bytes=100-', 100),
      inverted: parseByteRange('bytes=50-10', 100),
      emptySuffix: parseByteRange('bytes=-0', 100),
      blank: parseByteRange('bytes=-', 100),
      multiple: parseByteRange('bytes=0-1,5-6', 100),
      junk: parseByteRange('items=0-1', 100),
      hugeSuffix: parseByteRange('bytes=-500', 100),
    };

    // Assert
    should(actual.absent).be.undefined();
    should(actual.closed).deepEqual({ start: 0, end: 9 });
    should(actual.open).deepEqual({ start: 90, end: 99 });
    should(actual.suffix).deepEqual({ start: 90, end: 99 });
    should(actual.clamped).deepEqual({ start: 95, end: 99 });
    should(actual.whole).deepEqual({ start: 0, end: 99 });
    should(actual.hugeSuffix).deepEqual({ start: 0, end: 99 });
    should([actual.pastEnd, actual.inverted, actual.emptySuffix, actual.blank, actual.multiple, actual.junk]).deepEqual(
      [null, null, null, null, null, null],
    );
  });
});
