import { expect, test } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { ClientSessionApi } from '../../../../cli/lib/client.ts';
import { SessionSubtreeController } from '../../../../cli/lib/session/subtree-controller.ts';
import { capturedPresenter } from './controller-doubles.ts';

test('G24 the actual CLI subtree controller consumes the safe daemon view in one call', async () => {
  const calls: unknown[] = [];
  const view = {
    root: { id: 'lead', name: 'lead' },
    at: '2026-11-06T09:00:00.000Z',
    endedWindowMs: 7200000,
    rows: [
      {
        id: 'kid',
        parent: 'lead',
        name: 'kid',
        depth: 1,
        state: 'running',
        ferretState: 'working',
        last: { at: '2026-11-06T08:59:00.000Z', kind: 'note', text: '[excerpt withheld]' },
      },
    ],
  };
  const client: PluginClient = {
    call: async <T>(key: string, init?: unknown): Promise<T> => {
      calls.push({ key, init });
      expect(key).toBe('GET /v1/ferrets/:ferretId/subtree');
      return view as T;
    },
    subscribe: () => () => {},
  };
  const { io, presenter } = capturedPresenter();
  const controller = new SessionSubtreeController(new ClientSessionApi(client), presenter, { callerSessionId: 'lead' });
  await controller.execute(undefined);
  expect(calls).toEqual([{ key: 'GET /v1/ferrets/:ferretId/subtree', init: { params: { ferretId: 'lead' } } }]);
  expect(io.out.join('\n')).toContain('[1m] [excerpt withheld]');
  const json = capturedPresenter();
  await new SessionSubtreeController(new ClientSessionApi(client), json.presenter, {}).execute('lead', { json: true });
  expect(JSON.parse(json.io.out[0]!)).toEqual(view);
});
