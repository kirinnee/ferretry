import { describe, it } from 'bun:test';
import should from 'should';
import type { z } from 'zod';
import { agendaModePath, ProtocolNotifyGateway } from '../../../src/lib/notify/gateway';
import type { NotifyApiClient } from '../../../src/lib/notify/ports';
import { composeNoticeRequest } from '../../../src/lib/notify/request';
import { snapshot } from '../agenda/fixtures';
import { sessionView } from '../session/session-fixtures';
import { SESSION } from './fixtures';

interface Call {
  path: string;
  init: RequestInit | undefined;
}

function fakeClient(payload: unknown, calls: Call[] = []): NotifyApiClient {
  return {
    request: <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      return Promise.resolve(schema.parse(payload));
    },
  };
}

describe('notify routes', () => {
  it('should escape a session id that would otherwise break the route', () => {
    // Act + Assert
    should(agendaModePath('a/b')).equal('/v1/sessions/a%2Fb/agenda-mode');
  });
});

describe('protocol notify gateway', () => {
  it('should post the notice to the board route, attributed to the calling ferret', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolNotifyGateway(fakeClient(snapshot([]), calls), SESSION);
    const request = composeNoticeRequest(['PR', 'ready'], { ping: true });

    // Act
    await gateway.raise(SESSION, request);

    // Assert
    should(calls[0]?.path).equal(`/v1/sessions/${SESSION}/agenda`);
    should(calls[0]?.init?.method).equal('POST');
    should(calls[0]?.init?.headers).deepEqual({
      'content-type': 'application/json',
      'x-ferretry-client': 'cli',
      'x-ferretry-session-id': SESSION,
    });
    should(JSON.parse(String(calls[0]?.init?.body))).deepEqual({
      action: 'add',
      source: 'agent-raised',
      sourceRef: null,
      subject: 'PR ready',
      title: 'PR ready',
      kind: 'info',
      why: 'PR ready',
      context: null,
      howToResolve: 'Read it in the Inbox; opening it clears it.',
      surface: true,
      notice: true,
      ping: true,
    });
  });

  it('should read and patch the agenda mode', async () => {
    // Arrange
    const calls: Call[] = [];
    const mode = { enabled: true, restartRequired: true, note: 'Next launch.' };
    const result = { view: sessionView({ agenda: true }), restartRequired: true, note: 'Next launch.' };
    const reader = new ProtocolNotifyGateway(fakeClient(mode, calls));
    const writer = new ProtocolNotifyGateway(fakeClient(result, calls));

    // Act
    const read = await reader.agendaMode(SESSION);
    const patched = await writer.setAgendaMode(SESSION, true);

    // Assert
    should(read).deepEqual(mode);
    should(patched).deepEqual(mode);
    should(calls[0]?.path).equal(`/v1/sessions/${SESSION}/agenda-mode`);
    should(calls[0]?.init).deepEqual({ headers: { 'x-ferretry-client': 'cli' } });
    should(calls[1]?.init?.method).equal('PATCH');
    should(JSON.parse(String(calls[1]?.init?.body))).deepEqual({ enabled: true });
  });

  it('should refuse a daemon reply that is not the agenda-mode shape', async () => {
    // Arrange
    const gateway = new ProtocolNotifyGateway(fakeClient({ enabled: 'yes' }));

    // Act + Assert
    await should(gateway.agendaMode(SESSION)).be.rejected();
  });
});
