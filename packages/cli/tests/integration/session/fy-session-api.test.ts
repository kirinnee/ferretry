import { describe, it } from 'bun:test';
import type {
  AttachmentView,
  IFyApiClient,
  SendResult,
  SessionView,
  SignalKind,
  SignalOptions,
} from '@ferretry/protocol';
import { FyApiClient } from '@ferretry/protocol/client';
import should from 'should';
import { createFyClientConnector } from '../../../src/adapters/session/client-connector.ts';
import { FySessionApi } from '../../../src/adapters/session/fy-session-api.ts';
import { SystemClock } from '../../../src/adapters/session/system-clock.ts';
import { SessionCommandError } from '../../../src/lib/session/errors.ts';

const view = { config: { id: 'ses-1' }, state: { id: 'ses-1' }, directory: '/d' } as unknown as SessionView;
const sendResult = { ...view, disposition: 'delivered' } as SendResult;
const attachment = { id: 'att-1' } as AttachmentView;

/** Records what the protocol client was asked to do; no socket is ever opened. */
class SpyClient {
  readonly calls: Array<{ method: string; args: readonly unknown[] }> = [];

  private record<T>(method: string, args: readonly unknown[], value: T): Promise<T> {
    this.calls.push({ method, args });
    return Promise.resolve(value);
  }

  list(): Promise<SessionView[]> {
    return this.record('list', [], [view]);
  }

  get(id: string): Promise<SessionView> {
    return this.record('get', [id], view);
  }

  suggestNames(count?: number): Promise<string[]> {
    return this.record('suggestNames', [count], ['Hayden']);
  }

  start(...args: unknown[]): Promise<SessionView> {
    return this.record('start', args, view);
  }

  send(...args: unknown[]): Promise<SendResult> {
    return this.record('send', args, sendResult);
  }

  answer(...args: unknown[]): Promise<SessionView> {
    return this.record('answer', args, view);
  }

  interrupt(id: string): Promise<SessionView> {
    return this.record('interrupt', [id], view);
  }

  resume(id: string, message?: string): Promise<SessionView> {
    return this.record('resume', [id, message], view);
  }

  signal(id: string, kind: SignalKind, message?: string, options?: SignalOptions): Promise<SessionView> {
    return this.record('signal', [id, kind, message, options], view);
  }

  upload(id: string, file: string | Blob): Promise<AttachmentView> {
    return this.record('upload', [id, file], attachment);
  }
}

describe('FySessionApi', () => {
  it('should delegate every session operation to the protocol client', async () => {
    // Arrange
    const client = new SpyClient();
    const subject = new FySessionApi(() => Promise.resolve(client as unknown as IFyApiClient));

    // Act
    const results = [
      await subject.list(),
      await subject.get('ses-1'),
      await subject.suggestNames(3),
      await subject.start({ mode: 'auto', prompt: 'go', agent: 'a' }, 'req-1', 'cap-1'),
      await subject.send('ses-1', { message: 'hi' }),
      await subject.answer('ses-1', 'tool-1', ['yes'], 'other', ['yes']),
      await subject.interrupt('ses-1'),
      await subject.resume('ses-1', 'carry on'),
      await subject.signal('ses-1', 'waiting', undefined, { peer: 'ses-2' }),
      await subject.upload('ses-1', 'shot.png'),
    ];

    // Assert
    should(client.calls.map(call => call.method)).deepEqual([
      'list',
      'get',
      'suggestNames',
      'start',
      'send',
      'answer',
      'interrupt',
      'resume',
      'signal',
      'upload',
    ]);
    should(client.calls[2]?.args).deepEqual([3]);
    should(client.calls[3]?.args).deepEqual([{ mode: 'auto', prompt: 'go', agent: 'a' }, 'req-1', 'cap-1']);
    should(client.calls[5]?.args).deepEqual(['ses-1', 'tool-1', ['yes'], 'other', ['yes']]);
    should(client.calls[8]?.args).deepEqual(['ses-1', 'waiting', undefined, { peer: 'ses-2' }]);
    should(results[0]).deepEqual([view]);
    should(results[9]).deepEqual(attachment);
  });

  it('should open one connection however many calls a command makes', async () => {
    // Arrange
    let connections = 0;
    const client = new SpyClient();
    const subject = new FySessionApi(() => {
      connections += 1;
      return Promise.resolve(client as unknown as IFyApiClient);
    });

    // Act
    await subject.list();
    await subject.get('ses-1');
    await subject.list();

    // Assert
    should(connections).equal(1);
  });

  it('should not connect at all until a command needs the daemon', () => {
    // Arrange
    let connections = 0;

    // Act
    new FySessionApi(() => {
      connections += 1;
      return Promise.resolve(new SpyClient() as unknown as IFyApiClient);
    });

    // Assert
    should(connections).equal(0);
  });
});

describe('createFyClientConnector', () => {
  it('should build a client that identifies the CLI and its calling pane', async () => {
    // Arrange
    const connector = createFyClientConnector({
      url: 'http://127.0.0.1:9720',
      token: 'secret',
      sessionId: 'ses-9',
      version: '1.2.3',
    });

    // Act
    const client = await connector();

    // Assert
    // The client is constructed, not connected: no request has been made and no port was bound.
    should(client).be.instanceof(FyApiClient);
    should(client.list).be.a.Function();
  });

  it('should build a client against the local daemon when no address was exported', async () => {
    // Arrange
    const connector = createFyClientConnector({ token: 'secret', version: '1.2.3' });

    // Act
    const client = await connector();

    // Assert
    should(client).be.instanceof(FyApiClient);
  });

  it('should resolve the local daemon token lazily when FY_TOKEN is absent', async () => {
    // Arrange
    let tokenReads = 0;
    const connector = createFyClientConnector({
      version: '1.2.3',
      resolveLocalToken: async () => {
        tokenReads += 1;
        return 'local-secret';
      },
    });

    // Act
    const client = await connector();

    // Assert
    should(client).be.instanceof(FyApiClient);
    should(tokenReads).equal(1);
  });

  it('should refuse to build a client with no token configured', async () => {
    // Arrange
    const connector = createFyClientConnector({ url: 'http://127.0.0.1:7337', version: '1.2.3' });

    // Act
    const failure = await connector().catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceof(SessionCommandError);
    should((failure as SessionCommandError).message).match(/FY_TOKEN is not set/);
  });

  it('should reject a base URL the protocol client will not accept', async () => {
    // Arrange
    const connector = createFyClientConnector({ url: 'ftp://nope', token: 'secret', version: '1.2.3' });

    // Act
    const failure = await connector().catch((error: unknown) => error);

    // Assert
    should((failure as Error).message).match(/http or https/);
  });
});

describe('SystemClock', () => {
  it('should report the host clock in milliseconds', () => {
    // Arrange
    const before = Date.now();

    // Act
    const actual = new SystemClock().nowMs();

    // Assert
    should(actual).be.aboveOrEqual(before);
    should(actual).be.belowOrEqual(Date.now());
  });
});
