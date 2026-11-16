import { expect, test } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { ClientMoveGateway } from '../../../../cli/lib/move/gateway.ts';
import { sessionView } from '../session/session-fixtures.ts';
import { READY_PREVIEW } from './fixtures.ts';

type Init = Parameters<PluginClient['call']>[1];
interface Call {
  readonly route: string;
  readonly init: Init;
}

const recording = (answer: unknown): { readonly client: PluginClient; readonly calls: Call[] } => {
  const calls: Call[] = [];
  const client: PluginClient = {
    call: async <Answer>(route: string, init?: Init) => {
      calls.push({ route, init });
      return answer as Answer;
    },
    subscribe: () => () => undefined,
  };
  return { client, calls };
};

test('a move posts the parsed request with the ferret id and a minted request id header', async () => {
  const { client, calls } = recording(sessionView({ runtime: 'codex-secondary' }));
  const gateway = new ClientMoveGateway(client, () => 'minted-request');
  const moved = await gateway.move('ses-1', 'codex-secondary', 'gpt-5.6-sol');
  expect(moved.runtime).toBe('codex-secondary');
  expect(calls).toEqual([
    {
      route: 'POST /v1/ferrets/:ferretId/move',
      init: {
        params: { ferretId: 'ses-1' },
        body: { agent: 'codex-secondary', model: 'gpt-5.6-sol', allowContextDowngrade: false, forceInflight: false },
        headers: { 'x-fy-request-id': 'minted-request' },
      },
    },
  ]);
});

test('a move keeps the caller request id, the overrides and the conversation choice', async () => {
  const { client, calls } = recording(sessionView());
  const gateway = new ClientMoveGateway(client, () => 'unused');
  await gateway.move('ses-1', 'claude-alpha', undefined, true, 'caller-request', true, 'fresh');
  expect(calls[0]?.init).toMatchObject({
    body: { agent: 'claude-alpha', allowContextDowngrade: true, forceInflight: true, conversation: 'fresh' },
    headers: { 'x-fy-request-id': 'caller-request' },
  });
});

test('a move refuses an answer that is not a ferret summary', async () => {
  const { client } = recording({ nonsense: true });
  const gateway = new ClientMoveGateway(client, () => 'minted-request');
  await expect(gateway.move('ses-1', 'codex-secondary')).rejects.toThrow();
});

test('a conversion preview posts the agent and model and returns the parsed preview', async () => {
  const { client, calls } = recording(READY_PREVIEW);
  const gateway = new ClientMoveGateway(client, () => 'unused');
  expect(await gateway.conversionPreview('ses-1', 'codex-secondary', 'gpt-5.6-sol')).toEqual(READY_PREVIEW);
  expect(calls).toEqual([
    {
      route: 'POST /v1/ferrets/:ferretId/conversion-preview',
      init: { params: { ferretId: 'ses-1' }, body: { agent: 'codex-secondary', model: 'gpt-5.6-sol' } },
    },
  ]);
});

test('a conversion preview without a model sends only the agent', async () => {
  const { client, calls } = recording(READY_PREVIEW);
  await new ClientMoveGateway(client, () => 'unused').conversionPreview('ses-1', 'codex-secondary');
  expect(calls[0]?.init).toEqual({ params: { ferretId: 'ses-1' }, body: { agent: 'codex-secondary' } });
});
