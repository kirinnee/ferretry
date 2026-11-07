import { describe, expect, test } from 'bun:test';
import { MOVE_ROUTE, moveFerretWith } from '../../../app/lib/move-ferret.ts';
import type { RuntimesClient } from '../../../app/lib/client.ts';

interface Seen {
  readonly route: string;
  readonly init: Parameters<RuntimesClient['call']>[1];
}

const recording = (answer: unknown = {}): { client: RuntimesClient; seen: Seen[] } => {
  const seen: Seen[] = [];
  return {
    seen,
    client: {
      call: async <A = unknown>(route: string, init?: Parameters<RuntimesClient['call']>[1]): Promise<A> => {
        seen.push({ route, init });
        if (answer instanceof Error) throw answer;
        return answer as A;
      },
    },
  };
};

describe('the move a remove dialog sends to Ferrets', () => {
  test('R-0355 posts the ferret’s move on the parameter name Ferrets declares, with its own request id', async () => {
    const { client, seen } = recording();
    const ids = ['req-1', 'req-2'];
    const move = moveFerretWith(client, () => ids.shift() ?? 'none');

    await move('f-1', 'codex-default', 'convert');
    await move('f-2', 'claude-review', 'resume');

    expect(MOVE_ROUTE).toBe('POST /v1/ferrets/:ferretId/move');
    expect(seen).toEqual([
      {
        route: MOVE_ROUTE,
        init: {
          params: { ferretId: 'f-1' },
          body: { agent: 'codex-default', allowContextDowngrade: false, forceInflight: false, conversation: 'convert' },
          headers: { 'x-fy-request-id': 'req-1' },
        },
      },
      {
        route: MOVE_ROUTE,
        init: {
          params: { ferretId: 'f-2' },
          body: { agent: 'claude-review', allowContextDowngrade: false, forceInflight: false, conversation: 'resume' },
          headers: { 'x-fy-request-id': 'req-2' },
        },
      },
    ]);
  });

  test('R-0355 never forces past the in-flight inventory: a busy ferret stays where it is', async () => {
    const { client, seen } = recording();
    await moveFerretWith(client)('f-1', 'codex-default', 'convert');
    expect(seen[0]?.init?.body).toMatchObject({ forceInflight: false });
  });

  test('R-0355 throws a refusal as the client threw it, for the dialog to word', async () => {
    const refusal = Object.assign(new Error('x'), { status: 409, code: 'move_refused' });
    const { client } = recording(refusal);
    await expect(moveFerretWith(client)('f-1', 'codex-default', 'convert')).rejects.toBe(refusal);
  });

  test('R-0355 mints a fresh request id for every move when none is injected', async () => {
    const { client, seen } = recording();
    const move = moveFerretWith(client);
    await move('f-1', 'a', 'resume');
    await move('f-1', 'a', 'resume');
    const [first, second] = seen.map(entry => entry.init?.headers?.['x-fy-request-id']);
    expect(first).toBeString();
    expect(first).not.toBe(second);
  });
});
