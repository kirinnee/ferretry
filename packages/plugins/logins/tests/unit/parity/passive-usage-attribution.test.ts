import { FakeGate } from '@ferretry/core-gate/contract/testing';
import { expect, test } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import daemon, { CODEX_PASSIVE_USAGE_JOB } from '../../../daemon/index.ts';
import { LoginListSchema } from '../../../contract/index.ts';
import { CREDENTIAL_LIST_FRESH_MS } from '../../../daemon/lib/credentials/credentials-service.ts';
import { emptyVault } from '../../support/fake-vault.ts';

const event = (used: number, timestamp?: string) =>
  JSON.stringify({
    ...(timestamp === undefined ? {} : { timestamp }),
    type: 'event_msg',
    payload: { type: 'token_count', rate_limits: { primary: { used_percent: used } } },
  }) + '\n';

async function rig(text: string, login: string, stateAt: string, mtimeMs: number) {
  const ferrets = new FakeFerrets();
  const id = ferretId('review-only');
  const record = (login: string, stateAt: string) =>
    ferrets.add({
      id,
      harness: 'codex',
      runtime: 'work',
      login,
      state: 'idle',
      stateAt,
    } as never);
  record(login, stateAt);
  const rollout = { text, mtimeMs, onOpen: () => {} };
  Object.assign(ferrets, {
    harness: async () => ({
      transcriptBytes: async () => {
        rollout.onOpen();
        const bytes = new TextEncoder().encode(rollout.text);
        return {
          file: 'synthetic-rollout',
          size: bytes.length,
          mtimeMs: rollout.mtimeMs,
          read: async (offset: number, length: number) => bytes.slice(offset, offset + length),
          close: async () => undefined,
        };
      },
    }),
  });
  const host = await testHost({
    plugins: [daemon],
    fakes: { gate: new FakeGate(), vault: emptyVault() },
    uses: { ferrets },
    config: { logins: { a: { harness: 'codex', store: 'ferretry' }, b: { harness: 'codex', store: 'ferretry' } } },
    fetch: async () => {
      throw new Error('offline review');
    },
  });
  await host.settle();
  return {
    host,
    rollout,
    record,
    pass: () => host.runJob(CODEX_PASSIVE_USAGE_JOB),
    usage: async (login: string) => {
      await host.clock.advance(CREDENTIAL_LIST_FRESH_MS + 1);
      const list = LoginListSchema.parse((await host.request('GET', '/v1/logins')).json());
      return list.logins.find(item => item.id === login)?.usage?.fiveHour?.usedPercent;
    },
  };
}

test('review: a pre-switch token_count without a timestamp must not become B usage after a later append', async () => {
  const taskStarted =
    JSON.stringify({ timestamp: '2026-10-13T08:31:00Z', type: 'event_msg', payload: { type: 'task_started' } }) + '\n';
  const r = await rig(event(99) + taskStarted, 'b', '2026-10-13T08:30:00Z', Date.parse('2026-10-13T08:31:00Z'));
  try {
    await r.pass();
    expect(await r.usage('b')).toBeUndefined();
  } finally {
    await r.host.stop();
  }
});

test('review: short completed turns must eventually publish the final quota on the unchanged login', async () => {
  const r = await rig(event(1, '2026-10-13T08:01:00Z'), 'a', '2026-10-13T08:00:00Z', 1);
  try {
    await r.pass();
    expect(await r.usage('a')).toBe(1);
    for (const [minute, used] of [
      [2, 20],
      [3, 50],
      [4, 99],
    ]) {
      r.rollout.text += event(used!, `2026-10-13T08:0${minute}:00Z`);
      // turnObserved writes idle AFTER the final token_count; the job next runs after that.
      r.record('a', `2026-10-13T08:0${minute}:00.001Z`);
      await r.pass();
    }
    for (let pass = 0; pass < 10; pass++) await r.pass();
    expect(await r.usage('a')).toBe(99);
  } finally {
    await r.host.stop();
  }
});

test('review: a move between the Ferrets list snapshot and opening the transcript must not put B quota on A', async () => {
  const r = await rig(event(3, '2026-10-13T08:31:00Z'), 'a', '2026-10-13T08:00:00Z', 1);
  try {
    r.rollout.onOpen = () => {
      r.record('b', '2026-10-13T08:30:00Z');
    };
    await r.pass();
    expect(await r.usage('a')).toBeUndefined();
  } finally {
    await r.host.stop();
  }
});
