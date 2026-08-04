import { describe, it } from 'bun:test';
import type { IFyHttpTransport, SessionView } from '@ferretry/protocol';
import should from 'should';
import { DaemonHttpTransport, daemonApiClient, PWA_PROTOCOL_VERSION } from '../../src/lib/api-client.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';

const health = {
  ok: true,
  bootstrapping: false,
  bootstrapState: 'complete' as const,
  bootstrapDegraded: false,
  version: '0.0.0',
  pid: 1,
  sessions: 0,
  running: 0,
  monitors: 0,
  unmonitoredRunning: 0,
  wardenLastSweepSeconds: null,
  wardenTimerArmed: false,
  eventLoopLagMs: 0,
  lastSelfCheckAt: null,
  wedgeCount: 0,
  scratchGcEnabled: false,
  scratchReclaimedSessions: 0,
  scratchReclaimedBytes: 0,
  bootstrapErrors: 0,
  time: '2026-07-31T00:00:00.000Z',
};

const migratedView = {
  config: {
    id: 'same-session',
    incarnation: 'incarnation-1',
    runtimeGeneration: 2,
    name: 'Same session',
    boardAccess: 'none',
    agent: 'codex-auto-atomi',
    harness: 'codex',
    modelHint: 'gpt-5.6-terra',
    mode: 'auto',
    remoteControl: false,
    harnessFlags: [],
    cwd: '/work/same-session',
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:01.000Z',
    turn: 1,
    intervalSeconds: 30,
    timeoutSeconds: 120,
    nudgeAfterSeconds: 180,
    killAfterSeconds: 300,
    directSendMaxChars: 4_096,
    resumeMenuChoice: 'full',
    maxSnapshots: 10,
    retry: {
      transientAttempts: 1,
      stalledAttempts: 0,
      waitForQuotaReset: true,
      allowAccountFailover: false,
    },
  },
  state: { id: 'same-session', status: 'running', turn: 1 },
  directory: '/state/same-session',
} satisfies SessionView;

class RecordingTransport implements IFyHttpTransport {
  readonly calls: Array<{ url: string; init: RequestInit }> = [];

  constructor(private readonly response: unknown = health) {}

  async send(url: string, init: RequestInit): Promise<Response> {
    this.calls.push({ url, init });
    return new Response(JSON.stringify(this.response), { headers: { 'content-type': 'application/json' } });
  }
}

const paired = (daemonId: string, baseUrl: string, deviceToken: string) =>
  daemonConnection({ daemonId, baseUrl, deviceToken });

describe('daemon API client', () => {
  it('should bind typed protocol calls to the paired daemon instead of the public page origin', async () => {
    // Arrange
    const transport = new RecordingTransport();
    const daemon = paired('daemon-a', 'https://daemon-a.example.test', 'token-a');
    const client = await daemonApiClient(daemon, { transport, requestId: () => 'request-a' });

    // Act
    await client.health();

    // Assert
    should(transport.calls).have.length(1);
    should(transport.calls[0]?.url).equal('https://daemon-a.example.test/v1/health');
    const headers = new Headers(transport.calls[0]?.init.headers);
    should(headers.get('authorization')).equal('Bearer token-a');
    should(headers.get('x-fy-version')).equal(PWA_PROTOCOL_VERSION);
    should(headers.get('x-fy-request-id')).equal('request-a');
  });

  it('should keep same-shaped requests and credentials isolated between paired daemons', async () => {
    // Arrange
    const firstTransport = new RecordingTransport();
    const secondTransport = new RecordingTransport();
    const first = await daemonApiClient(paired('daemon-a', 'https://daemon-a.example.test', 'token-a'), {
      transport: firstTransport,
      requestId: () => 'request-a',
    });
    const second = await daemonApiClient(paired('daemon-b', 'https://daemon-b.example.test', 'token-b'), {
      transport: secondTransport,
      requestId: () => 'request-b',
    });

    // Act
    await Promise.all([first.health(), second.health()]);

    // Assert
    should(firstTransport.calls[0]?.url).equal('https://daemon-a.example.test/v1/health');
    should(secondTransport.calls[0]?.url).equal('https://daemon-b.example.test/v1/health');
    should(new Headers(firstTransport.calls[0]?.init.headers).get('authorization')).equal('Bearer token-a');
    should(new Headers(secondTransport.calls[0]?.init.headers).get('authorization')).equal('Bearer token-b');
  });

  it('should isolate migration paths, bodies, and credentials for the same session id on two daemons', async () => {
    // Arrange
    const firstTransport = new RecordingTransport(migratedView);
    const secondTransport = new RecordingTransport(migratedView);
    const first = await daemonApiClient(paired('daemon-a', 'https://daemon-a.example.test', 'token-a'), {
      transport: firstTransport,
      requestId: () => 'migration-a',
    });
    const second = await daemonApiClient(paired('daemon-b', 'https://daemon-b.example.test', 'token-b'), {
      transport: secondTransport,
      requestId: () => 'migration-b',
    });

    // Act
    await Promise.all([
      first.migrate('same-session', 'codex-auto-atomi', 'gpt-5.6-terra', true),
      second.migrate('same-session', 'claude-auto-loge5'),
    ]);

    // Assert
    const firstCall = firstTransport.calls[0];
    const secondCall = secondTransport.calls[0];
    should(firstCall?.url).equal('https://daemon-a.example.test/v1/sessions/same-session/migrate');
    should(secondCall?.url).equal('https://daemon-b.example.test/v1/sessions/same-session/migrate');
    should(new Headers(firstCall?.init.headers).get('authorization')).equal('Bearer token-a');
    should(new Headers(secondCall?.init.headers).get('authorization')).equal('Bearer token-b');
    should(JSON.parse(String(firstCall?.init.body))).eql({
      agent: 'codex-auto-atomi',
      model: 'gpt-5.6-terra',
      allowContextDowngrade: true,
    });
    should(JSON.parse(String(secondCall?.init.body))).eql({
      agent: 'claude-auto-loge5',
      allowContextDowngrade: false,
    });
  });
});

describe('daemon HTTP transport', () => {
  it('should invoke a receiver-sensitive fetcher without the transport as its receiver', async () => {
    // This is deliberately a non-arrow function: on main, `this.#fetch(...)`
    // makes `this` the transport and real Window.fetch rejects that receiver.
    let receiver: unknown = Symbol('not called');
    const transport = new DaemonHttpTransport(paired('daemon-a', 'https://daemon-a.example.test', 'token-a'), function (
      this: unknown,
    ): Promise<Response> {
      receiver = this;
      return Promise.resolve(new Response());
    });

    // Act
    await transport.send('https://daemon-a.example.test/v1/health', {});

    // Assert — ES modules are strict, so an unbound call has no receiver.
    should(receiver).be.undefined();
    should(receiver).not.equal(transport);
  });

  it('should include credentials only for the paired daemon origin', async () => {
    // Arrange
    let captured: { input: string | URL | Request; init?: RequestInit } | undefined;
    const transport = new DaemonHttpTransport(
      paired('daemon-a', 'https://daemon-a.example.test', 'token-a'),
      async (input, init) => {
        captured = { input, init };
        return new Response();
      },
    );

    // Act
    await transport.send('https://daemon-a.example.test/v1/health', { headers: { accept: 'application/json' } });
    const crossDaemon = (): unknown =>
      transport.send('https://daemon-b.example.test/v1/health', { headers: { accept: 'application/json' } });

    // Assert
    should(String(captured?.input)).equal('https://daemon-a.example.test/v1/health');
    should(captured?.init?.credentials).equal('include');
    should(crossDaemon).throw('API client request must remain on the paired daemon');
  });
});

/**
 * A migration is destructive and this client retries a POST on transport failure, so the request id
 * is what makes a retry sequence ONE migration to the daemon rather than several.
 */
describe('the typed client migrate call', () => {
  /** Fails in transport the first `failures` times, then answers, recording every attempt. */
  class FlakyTransport implements IFyHttpTransport {
    readonly calls: Array<{ url: string; init: RequestInit }> = [];
    constructor(private readonly failures: number) {}
    async send(url: string, init: RequestInit): Promise<Response> {
      this.calls.push({ url, init });
      if (this.calls.length <= this.failures) throw new Error('connection reset');
      return new Response(JSON.stringify(sessionResponse), { headers: { 'content-type': 'application/json' } });
    }
  }

  const sessionResponse = {
    ...migratedView,
    config: { ...migratedView.config, agent: 'codex-auto-atomi' },
  } satisfies SessionView;

  const daemon = paired('daemon-a', 'https://daemon-a.example.test', 'token-a');

  it('should send the caller request id, so the daemon can recognise a replay', async () => {
    // Arrange
    const transport = new RecordingTransport(sessionResponse);
    const client = await daemonApiClient(daemon, { transport, requestId: () => 'minted' });

    // Act
    await client.migrate('same-session', 'codex-auto-atomi', 'gpt-5.6-sol', true, 'caller-supplied');

    // Assert
    should(transport.calls).have.length(1);
    should(transport.calls[0]?.url).equal('https://daemon-a.example.test/v1/sessions/same-session/migrate');
    should(new Headers(transport.calls[0]?.init.headers).get('x-fy-request-id')).equal('caller-supplied');
  });

  it('should hold ONE request id across every automatic transport retry', async () => {
    // This is the whole point: three attempts carrying three ids would be three migrations, and the
    // second and third would each relaunch a session the first had already relaunched.
    // Arrange
    const transport = new FlakyTransport(2);
    const client = await daemonApiClient(daemon, { transport, requestId: () => 'minted' });

    // Act
    const view = await client.migrate('same-session', 'codex-auto-atomi', undefined, false, 'one-migration');

    // Assert
    should(view.config.agent).equal('codex-auto-atomi');
    should(transport.calls).have.length(3);
    const ids = transport.calls.map(call => new Headers(call.init.headers).get('x-fy-request-id'));
    should(ids).deepEqual(['one-migration', 'one-migration', 'one-migration']);
  });

  it('should mint a request id when the caller supplies none, so the header is never absent', async () => {
    // The daemon refuses a migration with no request id, so an omitted one must still produce a
    // usable header rather than falling through to the route's 400.
    // Arrange
    const transport = new RecordingTransport(sessionResponse);
    const client = await daemonApiClient(daemon, { transport, requestId: () => 'minted' });

    // Act
    await client.migrate('same-session', 'codex-auto-atomi');

    // Assert
    should(new Headers(transport.calls[0]?.init.headers).get('x-fy-request-id')).equal('minted');
  });
});
