import { describe, it } from 'bun:test';
import should from 'should';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import {
  daemonSttStatus,
  daemonTranscribe,
  type FetchLike,
  parseDaemonSttStatus,
  parseDaemonTranscript,
  requestDaemonModelInstall,
  STT_STATUS_PATH,
  STT_TRANSCRIBE_PATH,
  sttErrorForStatus,
  SttRequestError,
  sttModelInstallPath,
} from '../../../src/lib/stt/daemon-engine.ts';

const alpha = daemonConnection({
  daemonId: 'daemon-alpha',
  baseUrl: 'https://alpha.example.test',
  deviceToken: 'token-alpha',
});
const beta = daemonConnection({
  daemonId: 'daemon-beta',
  baseUrl: 'https://beta.example.test',
  deviceToken: 'token-beta',
});

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** Records what was sent so the daemon binding can be asserted, not assumed. */
const recorder = (
  respond: (call: Call) => Response | Promise<Response>,
): { readonly calls: Call[]; readonly fetchImpl: FetchLike } => {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init = {}) => {
    calls.push({ url, init });
    return respond({ url, init });
  };
  return { calls, fetchImpl };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const unreadable = (status = 200): Response => new Response('<html>', { status });

const unreachable = (message: string): never => {
  throw new Error(message);
};

const authOf = (call: Call): string | null => new Headers(call.init.headers).get('authorization');

describe('sttErrorForStatus', () => {
  it('lets the daemon’s own body code win over the status', () => {
    should(sttErrorForStatus(500, 'busy')).equal('busy');
    should(sttErrorForStatus(500, 'too_long')).equal('too-long');
    should(sttErrorForStatus(500, 'bad_audio')).equal('bad-audio');
    should(sttErrorForStatus(500, 'model_missing')).equal('unavailable');
    should(sttErrorForStatus(500, 'worker_unavailable')).equal('unavailable');
  });

  it('falls back to the status when the body says nothing', () => {
    should(sttErrorForStatus(401)).equal('unauthorized');
    should(sttErrorForStatus(403)).equal('unauthorized');
    should(sttErrorForStatus(404)).equal('unavailable');
    should(sttErrorForStatus(503)).equal('unavailable');
    should(sttErrorForStatus(409)).equal('busy');
    should(sttErrorForStatus(413)).equal('too-long');
    should(sttErrorForStatus(400)).equal('bad-audio');
    should(sttErrorForStatus(500)).equal('unknown');
  });
});

describe('sttModelInstallPath', () => {
  it('escapes a model id rather than letting it shape the path', () => {
    should(sttModelInstallPath('a/b?c')).equal('/v1/stt/models/a%2Fb%3Fc/install');
  });
});

describe('parseDaemonSttStatus', () => {
  it('reads a complete status', () => {
    const status = parseDaemonSttStatus({
      available: true,
      streaming: false,
      worker: { phase: 'ready', modelId: 'parakeet', lastError: { code: 'x', message: 'y', at: 'z' } },
      languages: ['en', 7],
      models: {
        daemon: {
          id: 'd',
          kind: 'daemon',
          label: 'Daemon model',
          state: 'ready',
          languages: ['en'],
          costs: { downloadBytes: 1, diskBytes: 2, ramBytesApprox: 3, summary: '640 MB' },
          installedAt: 'now',
          install: { phase: 'ready', receivedBytes: 4, totalBytes: 5, message: 'm', code: 'c' },
        },
        browser: { id: 'b' },
      },
      limits: { maxDurationSeconds: 120, maxPcmBytes: 10, sampleRate: 16_000 },
    });

    should(status.available).be.true();
    should(status.worker.phase).equal('ready');
    should(status.languages).deepEqual(['en']);
    should(status.daemonModel?.costs.summary).equal('640 MB');
    should(status.browserModel?.kind).equal('browser');
    should(status.browserModel?.state).equal('not-installed');
    should(status.limits?.sampleRate).equal(16_000);
  });

  it('treats every unknown as unknown rather than guessing', () => {
    const status = parseDaemonSttStatus({ worker: { phase: 'sideways' }, models: {} });

    should(status.available).be.false();
    should(status.streaming).be.false();
    should(status.worker.phase).equal('closed');
    should(status.worker.lastError).be.undefined();
    should(status.daemonModel).be.undefined();
    should(status.limits).be.undefined();
  });

  it('says so when the body is not an object at all', () => {
    should(parseDaemonSttStatus(null).unavailableReason).equal('The daemon sent an unreadable status.');
    should(parseDaemonSttStatus([]).available).be.false();
  });

  it('defaults an install phase and its byte counters', () => {
    const status = parseDaemonSttStatus({ models: { daemon: { install: { phase: 'sideways' } } } });
    should(status.daemonModel?.install).deepEqual({
      phase: 'idle',
      receivedBytes: 0,
      totalBytes: 0,
      message: undefined,
      code: undefined,
    });
  });
});

describe('daemonSttStatus', () => {
  it('reads the status from the paired daemon, with that daemon’s token', async () => {
    const { calls, fetchImpl } = recorder(() => json({ available: true, worker: { phase: 'ready' } }));
    const status = await daemonSttStatus(alpha, { fetchImpl });

    should(status.available).be.true();
    should(calls[0]?.url).equal(`https://alpha.example.test${STT_STATUS_PATH}`);
    should(authOf(calls[0] as Call)).equal('Bearer token-alpha');
  });

  it('never sends one daemon’s token to another daemon', async () => {
    const { calls, fetchImpl } = recorder(() => json({ available: true }));
    await daemonSttStatus(alpha, { fetchImpl });
    await daemonSttStatus(beta, { fetchImpl });

    should(calls[0]?.url).startWith('https://alpha.example.test');
    should(calls[1]?.url).startWith('https://beta.example.test');
    should(authOf(calls[1] as Call)).equal('Bearer token-beta');
  });

  it('reads a daemon built before this feature as unavailable, not broken', async () => {
    const { fetchImpl } = recorder(() => json({}, 404));
    should((await daemonSttStatus(alpha, { fetchImpl })).unavailableReason).equal(
      'This box has no dictation support yet.',
    );
  });

  it('reports any other refusal by its status', async () => {
    const { fetchImpl } = recorder(() => json({}, 500));
    should((await daemonSttStatus(alpha, { fetchImpl })).unavailableReason).equal('The daemon answered HTTP 500.');
  });

  it('reports an unreachable daemon without throwing', async () => {
    const status = await daemonSttStatus(alpha, {
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    should(status.unavailableReason).equal('The daemon could not be reached.');
  });

  it('reports an unreadable body without throwing', async () => {
    const { fetchImpl } = recorder(() => unreadable());
    should((await daemonSttStatus(alpha, { fetchImpl })).unavailableReason).equal(
      'The daemon sent an unreadable status.',
    );
  });
});

describe('requestDaemonModelInstall', () => {
  it('posts to the paired daemon and reports the start', async () => {
    const { calls, fetchImpl } = recorder(() => json({}));
    should(await requestDaemonModelInstall(alpha, 'parakeet', { fetchImpl })).deepEqual({ started: true });
    should(calls[0]?.url).equal('https://alpha.example.test/v1/stt/models/parakeet/install');
    should(calls[0]?.init.method).equal('POST');
  });

  it('explains that an older box cannot be driven from the browser', async () => {
    for (const status of [404, 405]) {
      const { fetchImpl } = recorder(() => json({}, status));
      const outcome = await requestDaemonModelInstall(alpha, 'parakeet', { fetchImpl });
      should(outcome.started).be.false();
      should(outcome.message).match(/Install it on the box instead/u);
    }
  });

  it('passes the daemon’s own refusal through', async () => {
    const { fetchImpl } = recorder(() => json({ error: 'disk full' }, 507));
    should(await requestDaemonModelInstall(alpha, 'parakeet', { fetchImpl })).deepEqual({
      started: false,
      message: 'disk full',
    });
  });

  it('has something to say when the refusal is not readable', async () => {
    const { fetchImpl } = recorder(() => unreadable(500));
    should((await requestDaemonModelInstall(alpha, 'parakeet', { fetchImpl })).message).equal(
      'The daemon refused the install (HTTP 500).',
    );
  });

  it('reports an unreachable daemon', async () => {
    const outcome = await requestDaemonModelInstall(alpha, 'parakeet', {
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    should(outcome).deepEqual({ started: false, message: 'The daemon could not be reached.' });
  });
});

describe('daemonTranscribe', () => {
  const samples = new Float32Array([0.1, -0.1, 0.2]);

  it('posts WAV audio to the paired daemon and returns the transcript', async () => {
    const { calls, fetchImpl } = recorder(() => json({ text: 'hello there', audioMs: 1, decodeMs: 2, rtf: 0.5 }));
    const transcript = await daemonTranscribe(alpha, { samples, fetchImpl });

    should(transcript.text).equal('hello there');
    should(transcript.rtf).equal(0.5);
    const call = calls[0] as Call;
    should(call.url).equal(`https://alpha.example.test${STT_TRANSCRIBE_PATH}?language=en`);
    should(new Headers(call.init.headers).get('content-type')).equal('audio/wav');
    should(authOf(call)).equal('Bearer token-alpha');
  });

  it('posts raw L16 when asked, at the target rate', async () => {
    const { calls, fetchImpl } = recorder(() => json({ text: 'x' }));
    await daemonTranscribe(alpha, { samples, encoding: 'raw', fetchImpl });
    should(new Headers((calls[0] as Call).init.headers).get('content-type')).equal('audio/L16; rate=16000; channels=1');
  });

  it('tags the utterance with the session it belongs to', async () => {
    const { calls, fetchImpl } = recorder(() => json({ text: 'x' }));
    await daemonTranscribe(alpha, { samples, scope: daemonSessionScope(alpha, 'session-1'), fetchImpl });
    should(calls[0]?.url).endWith('?language=en&sessionId=session-1');
  });

  it('REFUSES a session scope belonging to another daemon', async () => {
    const { calls, fetchImpl } = recorder(() => json({ text: 'x' }));
    await daemonTranscribe(alpha, { samples, scope: daemonSessionScope(beta, 'session-1'), fetchImpl }).then(
      () => unreachable('audio was posted across daemons'),
      (error: unknown) => {
        should(error).be.instanceof(SttRequestError);
        should((error as SttRequestError).message).equal('That session belongs to a different daemon.');
      },
    );
    should(calls).have.length(0);
  });

  it('refuses an empty capture before opening a request', async () => {
    const { calls, fetchImpl } = recorder(() => json({ text: 'x' }));
    await daemonTranscribe(alpha, { samples: new Float32Array(0), fetchImpl }).then(
      () => unreachable('an empty capture was posted'),
      (error: unknown) => should((error as SttRequestError).code).equal('bad-audio'),
    );
    should(calls).have.length(0);
  });

  it('reports a cancelled request as aborted, not as a failure', async () => {
    await daemonTranscribe(alpha, {
      samples,
      fetchImpl: async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    }).then(
      () => unreachable('the abort was swallowed'),
      (error: unknown) => should((error as SttRequestError).code).equal('aborted'),
    );
  });

  it('reports an unreachable daemon as a network failure', async () => {
    await daemonTranscribe(alpha, {
      samples,
      fetchImpl: async () => {
        throw new Error('offline');
      },
    }).then(
      () => unreachable('the failure was swallowed'),
      (error: unknown) => should((error as SttRequestError).code).equal('network'),
    );
  });

  it('lets the daemon name its own refusal', async () => {
    const { fetchImpl } = recorder(() => json({ code: 'busy', error: 'A transcript is already running.' }, 500));
    await daemonTranscribe(alpha, { samples, fetchImpl }).then(
      () => unreachable('the refusal was swallowed'),
      (error: unknown) => {
        should((error as SttRequestError).code).equal('busy');
        should((error as SttRequestError).message).equal('A transcript is already running.');
        should((error as SttRequestError).status).equal(500);
      },
    );
  });

  it('still refuses when the error body is not readable', async () => {
    const { fetchImpl } = recorder(() => unreadable(413));
    await daemonTranscribe(alpha, { samples, fetchImpl }).then(
      () => unreachable('the refusal was swallowed'),
      (error: unknown) => {
        should((error as SttRequestError).code).equal('too-long');
        should((error as SttRequestError).message).equal('The daemon refused the recording (HTTP 413).');
      },
    );
  });

  it('refuses an unreadable success body rather than committing nothing', async () => {
    const { fetchImpl } = recorder(() => unreadable(200));
    await daemonTranscribe(alpha, { samples, fetchImpl }).then(
      () => unreachable('the unreadable body was accepted'),
      (error: unknown) => should((error as SttRequestError).code).equal('unknown'),
    );
  });
});

describe('parseDaemonTranscript', () => {
  it('reads only the raw text, never the daemon’s own enhanced field', () => {
    const transcript = parseDaemonTranscript({ text: 'raw words', enhanced: 'polished words', modelId: 'm' });
    should(transcript.text).equal('raw words');
    should(transcript.modelId).equal('m');
  });

  it('answers an empty transcript for a body it cannot read', () => {
    should(parseDaemonTranscript(null)).deepEqual({ text: '' });
    should(parseDaemonTranscript('text')).deepEqual({ text: '' });
    should(parseDaemonTranscript({}).text).equal('');
  });
});
