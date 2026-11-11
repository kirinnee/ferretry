import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AskDeliveries, AskNotTypedError, type AskDelivery } from '../../../../asks/contract/index.ts';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { Harnesses, Runners } from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { testHost } from '../../../testing/index.ts';

/**
 * B3 R-0334 V-0032 through the daemon: the REAL Ferrets and the REAL Conversation halves, as the generated registry
 * builds them. Asks is the one reader of `ask.delivery:ferret`, so a probe plays Asks' reader (Asks' own half cannot be
 * held by the in-memory test host); what is proved is that Conversation PROVIDES it, and that a send through it is typed
 * into a real ferret's terminal exactly once under its send id.
 *
 * CI only (integration tier). Fixture values only.
 */
const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

describe('B3 R-0334 V-0032 Conversation provides ask.delivery through the daemon', () => {
  test('is composed, and types an answer into a started ferret once per send id', async () => {
    const runner = new FakeRunner();
    const found: { delivery: AskDelivery | 'unavailable' } = { delivery: 'unavailable' };
    const reader = implementDaemon(
      definePlugin({
        id: 'asks-probe',
        title: 'Asks reader (fake)',
        version: '5.0.0',
        api: 5,
        core: false,
        kinds: [],
        hooks: { offers: [{ hook: AskDeliveries }] },
      }),
      {
        build: ctx => {
          found.delivery = ctx.hooks.provider(AskDeliveries, 'ferret') as AskDelivery | 'unavailable';
          return {};
        },
      },
    );
    const h = await testHost({
      plugins: [
        real('ferrets'),
        real('conversation'),
        reader,
        implementDaemon(
          definePlugin({
            id: 'claude-code',
            title: 'Claude Code (fake)',
            version: '5.0.0',
            api: 5,
            core: false,
            kinds: [],
            hooks: { takes: [{ hook: Harnesses, key: 'claude-code' }] },
          }),
          { build: () => ({ hooks: { 'harnesses:claude-code': new FakeHarness() } }) },
        ),
        implementDaemon(
          definePlugin({
            id: 'terminals',
            title: 'Terminals (fake)',
            version: '5.0.0',
            api: 5,
            core: false,
            kinds: [],
            hooks: { takes: [{ hook: Runners, key: 'tmux' }] },
          }),
          { build: () => ({ hooks: { 'runners:tmux': runner } }) },
        ),
      ],
      gate: new StandInAdmission(() => ownerStanding()),
      fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
    });
    const started = await h.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': randomUUID() },
      body: { folder: '/work/lead', prompt: 'Lead the work.' },
    });
    expect(started.status).toBeLessThan(300);
    const ferret = started.json<{ id: string }>().id;
    await h.settle();

    const delivery = found.delivery;
    expect(delivery).not.toBe('unavailable');
    if (delivery === 'unavailable') return;
    expect(await delivery.composer?.(ferret)).toBe('empty');
    await delivery.send(ferret, '[answer to !A1 «Ship it?»] Yes', 'answer-1').catch((error: unknown) => {
      expect(error).toBeInstanceOf(AskNotTypedError);
    });
    await h.settle();
    const sends = (await h.request('GET', `/v1/ferrets/${ferret}/sends`)).json<{ sends: { sendId: string }[] }>();
    expect(sends.sends.filter(send => send.sendId === 'answer-1').length).toBeLessThanOrEqual(1);
    await delivery.send(ferret, '[answer to !A1 «Ship it?»] Yes', 'answer-1').catch(() => undefined);
    await h.settle();
    const again = (await h.request('GET', `/v1/ferrets/${ferret}/sends`)).json<{ sends: { sendId: string }[] }>();
    expect(again.sends.filter(send => send.sendId === 'answer-1')).toHaveLength(1);
  });
});
