import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import type {
  DeliveryOutcome,
  FerretHarness,
  FerretId,
  HarnessRefusal,
  RunnerDelivery,
} from '@ferretry/core-ferrets/contract';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { ApiError, REFUSAL_SENTENCES } from '@ferretry/kernel/contract';
import { fixedClock, owner, testHost } from '@ferretry/kernel/testing';
import { err, ok, type Result } from '@ferretry/std';
import { ConversationPort } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';

const F1 = ferretId('f1');
const CALLER = ferretId('lead');

/** What one scripted harness does when Conversation uses it. */
interface Script {
  deliver?: () => Promise<Result<DeliveryOutcome, HarnessRefusal>>;
  interrupt?: () => Promise<Result<true, HarnessRefusal>>;
}

/** Ferrets with the harness seam: every open is recorded with the caller it was given. */
class HarnessFerrets extends FakeFerrets {
  readonly opens: { readonly ferret: FerretId; readonly caller: FerretId | undefined }[] = [];
  readonly delivered: RunnerDelivery[] = [];
  interrupts = 0;
  script: Script = {};
  /** Set when `harness()` itself refuses, as Ferrets' mayTouch rule does. */
  refuseOpen: ApiError | undefined;

  async harness(ferret: FerretId, caller?: FerretId): Promise<FerretHarness | undefined> {
    this.opens.push({ ferret, caller });
    if (this.refuseOpen !== undefined) throw this.refuseOpen;
    if ((await this.get(ferret)) === undefined) return undefined;
    return {
      deliver: async delivery => {
        this.delivered.push(delivery);
        return await (this.script.deliver?.() ?? Promise.resolve(ok('turn-started' as const)));
      },
      interrupt: async () => {
        this.interrupts += 1;
        return await (this.script.interrupt?.() ?? Promise.resolve(ok(true as const)));
      },
      transcript: {
        read: async () => {
          throw new Error('Conversation does not read the transcript through the terminal seam');
        },
        follow: () => {
          throw new Error('unused');
        },
        find: async () => undefined,
      },
    };
  }
}

/** Without the seam: a Ferrets that predates `harness`. */
class SeamlessFerrets extends HarnessFerrets {
  constructor() {
    super();
    // An own property shadows the method, so `ferrets.harness` reads as absent, as on a Ferrets without the seam.
    (this as { harness?: unknown }).harness = undefined;
  }
}

/**
 * The real daemon half. The kernel's `act` is a bomb: the runner's deliver already acts on the ferret's terminal, so an
 * act Conversation opened around it would deadlock both (the comment above `act()` in Ferrets' service). Any use fails.
 */
async function conversation(ferrets: HarnessFerrets = new HarnessFerrets()) {
  ferrets.add({ id: F1, state: 'working' });
  const acted: string[] = [];
  const implementation = {
    ...daemon,
    build: (ctx: Parameters<NonNullable<typeof daemon.build>>[0]) => {
      const build = daemon.build;
      if (build === undefined) throw new Error('the conversation daemon half has no build');
      const act = (async (target: unknown) => {
        acted.push(String(JSON.stringify(target)));
        throw new Error('Conversation entered kernel.act around the harness seam: that deadlocks the runner');
      }) as typeof ctx.kernel.act;
      return build({ ...ctx, kernel: { ...ctx.kernel, act } });
    },
  } as typeof daemon;
  const host = await testHost({
    plugins: [implementation],
    fakes: { ferrets, asks: new FakeAsks() },
    clock: fixedClock('2026-11-08T09:00:00Z'),
  });
  return { host, ferrets, acted, api: () => host.provided(ConversationPort) };
}

/** The sends a ferret still holds: a refusal before any key leaves only a withdrawn tombstone, which this leaves out. */
const live = async (
  api: () => { sends(ferret: FerretId): Promise<{ sends: readonly { withdrawn?: boolean | undefined }[] }> },
) => (await api().sends(F1)).sends.filter(row => row.withdrawn !== true);

const send = async (host: Awaited<ReturnType<typeof conversation>>['host'], id = 'req-1', ferret = 'f1') =>
  await host.request('POST', `/v1/ferrets/${ferret}/send`, {
    as: owner(),
    headers: { 'x-fy-request-id': id },
    body: { message: 'hello there' },
  });

describe('Conversation types into a ferret through the Ferrets harness seam', () => {
  test('a send delivers the message, ledgers it as accepted, and opens no act on the ferret’s terminal', async () => {
    const { host, ferrets, acted, api } = await conversation();

    const response = await send(host);

    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({ ferret: 'f1', disposition: 'sent', sendId: 'req-1', fate: 'accepted' });
    expect(ferrets.delivered).toEqual([{ text: 'hello there' }]);
    // Deliver ran with no act around it: the kernel's act (a bomb here) was never entered.
    expect(acted).toEqual([]);
    const sends = (await api().sends(F1)).sends;
    expect(sends.map(row => [row.sendId, row.fate, row.message])).toEqual([['req-1', 'accepted', 'hello there']]);
    await host.stop();
  });

  test('the same send id twice is one message: the second is answered from the ledger and types nothing', async () => {
    const { host, ferrets } = await conversation();

    await send(host);
    const again = await send(host);

    expect(again.status).toBe(200);
    expect(ferrets.delivered).toHaveLength(1);
    await host.stop();
  });

  test('a handled-local outcome (a slash command) is answered as a send too', async () => {
    const { host, ferrets } = await conversation();
    ferrets.script.deliver = async () => ok('handled-local');

    expect((await send(host)).status).toBe(200);
    await host.stop();
  });

  test('a ferret this daemon does not know is the unknown-ferret answer: 404 not-found, nothing recorded', async () => {
    const { host, ferrets, api } = await conversation();

    const response = await send(host, 'req-1', 'ghost');

    expect([response.status, response.json<{ code: string }>().code]).toEqual([404, 'not-found']);
    expect(response.json<{ error: string }>().error).toContain('session not found: ghost');
    expect(ferrets.delivered).toEqual([]);
    expect((await api().sends(ferretId('ghost'))).sends).toEqual([]);
    await host.stop();
  });

  test('no pane: 409 send_refused saying to revive it; the record is taken back so the id may start over', async () => {
    const { host, ferrets, api } = await conversation();
    ferrets.script.deliver = async () => err({ refused: 'no_pane' });

    const response = await send(host);

    expect([response.status, response.json<{ code: string }>().code]).toEqual([409, 'send_refused']);
    expect(response.json<{ error: string }>().error).toContain('has no live agent to type into; revive it first');
    expect(await live(api)).toEqual([]);
    ferrets.script.deliver = async () => ok('turn-started');
    expect((await send(host)).status).toBe(200);
    expect(ferrets.delivered).toHaveLength(2);
    await host.stop();
  });

  test('plugin_unavailable: 503 plugin_unavailable, nothing recorded', async () => {
    const { host, ferrets, api } = await conversation();
    ferrets.script.deliver = async () => err({ refused: 'plugin_unavailable' });

    const response = await send(host);

    expect([response.status, response.json<{ code: string }>().code]).toEqual([503, 'plugin_unavailable']);
    expect(await live(api)).toEqual([]);
    await host.stop();
  });

  test.each(['held', 'quarantined', 'input_pending', 'holds_unavailable', 'target_gone'] as const)(
    'an act refusal (%s): 409 with its code and its fixed sentence, nothing recorded',
    async code => {
      const { host, ferrets, api } = await conversation();
      ferrets.script.deliver = async () => err({ refused: code });

      const response = await send(host);

      expect([response.status, response.json<{ code: string }>().code]).toEqual([409, code]);
      expect(response.json<{ error: string }>().error).toBe(REFUSAL_SENTENCES[code]);
      expect(await live(api)).toEqual([]);
      await host.stop();
    },
  );

  test('Ferrets refusing the open (mayTouch) stays 403 forbidden, and nothing is recorded', async () => {
    const { host, ferrets, api } = await conversation();
    ferrets.refuseOpen = new ApiError(403, 'a ferret acts only on itself and its helpers', 'forbidden');

    const response = await send(host);

    expect([response.status, response.json<{ code: string }>().code]).toEqual([403, 'forbidden']);
    expect((await api().sends(F1)).sends).toEqual([]);
    await host.stop();
  });

  test('a runner that throws mid-write is a failed send (500) and the record STAYS: what reached the pane is uncertain', async () => {
    const { host, ferrets, api } = await conversation();
    ferrets.script.deliver = async () => {
      throw new Error('the payload was typed but delivery could not be confirmed');
    };

    const response = await send(host);

    expect([response.status, response.json<{ code: string }>().code]).toEqual([500, 'session_send_failed']);
    expect((await api().sends(F1)).sends.map(row => [row.sendId, row.fate])).toEqual([['req-1', 'accepted']]);
    await host.stop();
  });

  test('a Ferrets that offers no harness seam answers 503 plugin_unavailable', async () => {
    const { host, api } = await conversation(new SeamlessFerrets());

    const response = await send(host);

    expect([response.status, response.json<{ code: string }>().code]).toEqual([503, 'plugin_unavailable']);
    expect((await api().sends(F1)).sends).toEqual([]);
    await host.stop();
  });
});

describe('the caller is Ferrets’ to judge (mayTouch), so it is passed through, not decided here', () => {
  test('the port’s send by a ferret opens the seam with that ferret as the caller', async () => {
    const { host, ferrets, api } = await conversation();

    const sent = await api().send(F1, { kind: 'ferret', ferret: CALLER }, { message: 'psst', sendId: 's-1' });

    expect(sent.ok).toBe(true);
    expect(ferrets.opens).toEqual([{ ferret: F1, caller: CALLER }]);
    await host.stop();
  });

  test('the port’s send by the owner opens it with no caller', async () => {
    const { host, ferrets, api } = await conversation();

    await api().send(F1, { kind: 'owner' }, { message: 'hi', sendId: 's-1' });

    expect(ferrets.opens).toEqual([{ ferret: F1, caller: undefined }]);
    await host.stop();
  });

  test('a forbidden open reaches the port’s caller as the refusal code forbidden', async () => {
    const { host, ferrets, api } = await conversation();
    ferrets.refuseOpen = new ApiError(403, 'a ferret acts only on itself and its helpers', 'forbidden');

    const sent = await api().send(F1, { kind: 'ferret', ferret: CALLER }, { message: 'psst', sendId: 's-1' });

    expect(sent).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(ferrets.delivered).toEqual([]);
    await host.stop();
  });

  test('the send ROUTE names no caller: a ferret messaging its parent or a peer is not a ferret acting on a helper', async () => {
    const { host, ferrets } = await conversation();

    await send(host);

    expect(ferrets.opens).toEqual([{ ferret: F1, caller: undefined }]);
    await host.stop();
  });
});

describe('interrupt goes through the same seam', () => {
  const interrupt = async (host: Awaited<ReturnType<typeof conversation>>['host'], ferret = 'f1') =>
    await host.request('POST', `/v1/ferrets/${ferret}/interrupt`, { as: owner(), body: {} });

  test('the route presses the harness’s interrupt, with no act of its own, and answers the ferret’s view', async () => {
    const { host, ferrets, acted } = await conversation();

    const response = await interrupt(host);

    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({ id: 'f1', status: 'interrupted' });
    expect(ferrets.interrupts).toBe(1);
    expect(acted).toEqual([]);
    await host.stop();
  });

  test('an unknown ferret is 404 not-found', async () => {
    const { host, ferrets } = await conversation();

    const response = await interrupt(host, 'ghost');

    expect([response.status, response.json<{ code: string }>().code]).toEqual([404, 'not-found']);
    expect(ferrets.interrupts).toBe(0);
    await host.stop();
  });

  test.each([
    [{ refused: 'no_pane' }, 409, 'send_refused'],
    [{ refused: 'plugin_unavailable' }, 503, 'plugin_unavailable'],
    [{ refused: 'held' }, 409, 'held'],
    [{ refused: 'holds_unavailable' }, 409, 'holds_unavailable'],
    [{ refused: 'target_gone' }, 409, 'target_gone'],
  ] as const)('refusal %o answers %d %s', async (refusal, status, code) => {
    const { host, ferrets } = await conversation();
    ferrets.script.interrupt = async () => err(refusal);

    const response = await interrupt(host);

    expect([response.status, response.json<{ code: string }>().code]).toEqual([status, code]);
    await host.stop();
  });

  test('forbidden from Ferrets stays 403', async () => {
    const { host, ferrets } = await conversation();
    ferrets.refuseOpen = new ApiError(403, 'a ferret acts only on itself and its helpers', 'forbidden');

    const response = await interrupt(host);

    expect([response.status, response.json<{ code: string }>().code]).toEqual([403, 'forbidden']);
    await host.stop();
  });

  test('the port’s interrupt is ok on success and carries the refusal’s code otherwise', async () => {
    const { host, ferrets, api } = await conversation();

    expect(await api().interrupt(F1, {})).toEqual({ ok: true, value: undefined });
    ferrets.script.interrupt = async () => err({ refused: 'held' });
    expect(await api().interrupt(F1, {})).toMatchObject({ ok: false, error: { code: 'held' } });
    await host.stop();
  });
});
