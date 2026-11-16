/**
 * The machine's seen mark Agenda hands whoever closes the alert lines: Agenda's own route, over Agenda's own client.
 */

import { describe, expect, it } from 'bun:test';
import { seenMarkOf } from '../../../app/lib/agenda-seen.ts';

type Init = { body?: unknown; headers?: Record<string, string> };

const clientOf = (answer: unknown) => {
  const calls: { route: string; init: Init }[] = [];
  return {
    calls,
    client: {
      call: async (route: string, init: Init = {}) => {
        calls.push({ route, init });
        return answer;
      },
    } as never,
  };
};

describe('seenMarkOf', () => {
  it('posts the ask once, with a request id, and answers the tags the machine names', async () => {
    const { calls, client } = clientOf({ cleared: true, tags: ['attention-f1'] });
    expect(await seenMarkOf(client, 'f1', 'A3')()).toEqual({ cleared: true, tags: ['attention-f1'] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.route).toBe('POST /v1/push/seen');
    expect(calls[0]?.init.body).toEqual({ sessionId: 'f1', agendaId: 'A3' });
    expect(calls[0]?.init.headers?.['x-fy-request-id']).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('sends nothing until it is made, and refuses an ask that is not one', async () => {
    const { calls, client } = clientOf({ cleared: false, tags: [] });
    const mark = seenMarkOf(client, 'f1', 'not-an-ask');
    expect(calls).toHaveLength(0);
    await expect(mark()).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('rejects an answer that is not a seen answer', async () => {
    const { client } = clientOf({ cleared: 'maybe' });
    await expect(seenMarkOf(client, 'f1', 'A3')()).rejects.toThrow();
  });
});
