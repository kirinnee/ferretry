import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import type {
  DeliveryOutcome,
  FerretHarness,
  FerretId,
  FerretSummary,
  HarnessDeliveryFailure,
  HarnessInterrupted,
  HarnessRefusal,
  QueueOutcome,
  RunnerDelivery,
} from '@ferretry/core-ferrets/contract';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { ferretActor } from '@ferretry/core-gate/contract';
import { ferretStanding, ownerStanding, wardenStanding } from '@ferretry/core-gate/contract/testing';
import { ApiError, type CallStanding, REFUSAL_SENTENCES, type RouteHandler } from '@ferretry/kernel/contract';
import { ferret as asFerret, fixedClock, owner, testHost, type TestCaller } from '@ferretry/kernel/testing';
import type { Instant } from '@ferretry/std';
import { err, ok, type Result } from '@ferretry/std';
import { CONVERSATION_STATE, ConversationPort, parsePeerEnvelope } from '../../../contract/index.ts';
import { conversationDaemon } from '../../../daemon/index.ts';
import {
  type HarnessGate,
  HARNESS_OPEN,
  INTERRUPT_UNAVAILABLE,
  NOT_READY_SENTENCES,
  SEND_EXTRAS_UNAVAILABLE,
  SEND_UNAVAILABLE,
  STRANDED_SENTENCE,
  UNCONFIRMED_SENTENCE,
} from '../../../daemon/harness-seam.ts';
import { writeAskedQuestion } from '../../../daemon/questions/adapters/state-asked-question.ts';
import { KeyedSerialExecutor } from '../../../daemon/seams/keyed-serial-executor.ts';
import { fixtureTexts } from '../../support/fixtures.ts';
import { memoryStatePort } from '../../support/state.ts';

const OPEN: HarnessGate = HARNESS_OPEN;
/** Both actions held back: what a gate that is not open answers. */
const CLOSED: HarnessGate = { send: false, interrupt: false };

const F1 = ferretId('f1');
const CALLER = ferretId('lead');
/** The calling ferret's name, apart from its id so a banner that names the wrong one shows. */
const LEAD_NAME = 'kamila';
const SEND_ROUTE = 'POST /v1/ferrets/:ferretId/send';

/**
 * The banner a message from the lead (`kamila`, session `lead`) is typed under, spelled out by hand rather than built
 * with the protocol's writer, so a change to what is typed fails here.
 */
const banner = (kind: 'message' | 'reply' | 'question', label?: 'action' | 'blocker', name = LEAD_NAME, id = 'lead') =>
  `[${label === undefined ? kind : `${kind} · ${label}`} from ferret ${name} (session ${id}) — not from the owner] To reply: fy send ${name} "<reply>"\n`;

/** A structured question the ferret asked (the live `PreToolUse` payload of `asked.test.ts`). */
const fixture = await fixtureTexts(join(import.meta.dir, '../../fixtures/question-asked'));
const QUESTION_PAYLOAD = fixture('claude-2.1.281-pretooluse.json');
const QUESTION_TOOL_USE = 'toolu_01T4KnfY1in2GTL7P9wUmRtt';

/** What one scripted harness does when Conversation uses it. */
interface Script {
  deliver?: () => Promise<Result<DeliveryOutcome, HarnessDeliveryFailure>>;
  queue?: () => Promise<Result<QueueOutcome, HarnessDeliveryFailure>>;
  interrupt?: () => Promise<Result<HarnessInterrupted, HarnessRefusal>>;
}

/** Ferrets with the harness seam: every open is recorded with the caller it was given. */
class HarnessFerrets extends FakeFerrets {
  readonly opens: { readonly ferret: FerretId; readonly caller: FerretId | undefined }[] = [];
  readonly delivered: RunnerDelivery[] = [];
  /** What was put in the busy pane's own queue. */
  readonly queued: string[] = [];
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
      queue: async text => {
        this.queued.push(text);
        if (this.script.queue === undefined) throw new Error('this test did not expect a send to be queued');
        return await this.script.queue();
      },
      interrupt: async () => {
        this.interrupts += 1;
        return await (this.script.interrupt?.() ?? Promise.resolve(ok({ pressed: true, working: false })));
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
 * The real daemon half, on the test's own memory state (so a test can seed `question.json`). The kernel's `act` is a
 * bomb: the runner's deliver already acts on the ferret's terminal, so an act Conversation opened around it would
 * deadlock both (the comment above `act()` in Ferrets' service). Any use fails.
 */
async function conversation(
  ferrets: HarnessFerrets = new HarnessFerrets(),
  gate: HarnessGate = OPEN,
  f1: Partial<FerretSummary> = {},
  options: {
    /**
     * The standing Gate stamps on a send ROUTE call, built with Gate's own helpers (`ferretStanding`, `ferretActor`,
     * `wardenStanding`) so a rename of what Gate stamps breaks this test rather than production. The test host's
     * stand-in admission stamps no actor and no credential at all, so the send route is wrapped to carry this one.
     */
    readonly sendStanding?: CallStanding;
  } = {},
) {
  ferrets.add({ id: F1, state: 'working', ...f1 });
  ferrets.add({ id: CALLER, name: LEAD_NAME, state: 'working' });
  const acted: string[] = [];
  const base = memoryStatePort(CONVERSATION_STATE);
  /** Set to make every appended line fail (the send ledger appends each accept, settle and withdrawal). */
  const writes = { fail: false };
  const state: typeof base = {
    ...base,
    append: async (...args: Parameters<typeof base.append>) => {
      if (writes.fail) throw new Error('ENOSPC: no space left on device, write /state/sends/f1.jsonl');
      return await base.append(...args);
    },
  };
  const served = conversationDaemon(gate);
  const implementation = {
    ...served,
    build: (ctx: Parameters<NonNullable<typeof served.build>>[0]) => {
      const build = served.build;
      if (build === undefined) throw new Error('the conversation daemon half has no build');
      const act = (async (target: unknown) => {
        acted.push(String(JSON.stringify(target)));
        throw new Error('Conversation entered kernel.act around the harness seam: that deadlocks the runner');
      }) as typeof ctx.kernel.act;
      const built = build({ ...ctx, kernel: { ...ctx.kernel, act, state } });
      const standing = options.sendStanding;
      if (standing === undefined) return built;
      const routes = built.routes as Readonly<Record<string, RouteHandler | undefined>>;
      const handler = routes[SEND_ROUTE];
      if (handler === undefined) throw new Error('the conversation daemon half serves no send route');
      const peer: RouteHandler = async call => await handler({ ...call, ...standing } as typeof call);
      return { ...built, routes: { ...routes, [SEND_ROUTE]: peer } } as typeof built;
    },
  } as typeof served;
  const host = await testHost({
    plugins: [implementation],
    fakes: { ferrets, asks: new FakeAsks() },
    clock: fixedClock('2026-11-08T09:00:00Z'),
  });
  const asking = async () =>
    await writeAskedQuestion(
      state,
      new KeyedSerialExecutor(),
      F1,
      QUESTION_PAYLOAD,
      '2026-11-08T08:59:00.000Z' as Instant,
      '/home/user/.claude/projects/-work-repro/48fa096f-185c-42e1-b456-33dd3c77c5ce.jsonl',
    );
  return { host, ferrets, acted, asking, writes, api: () => host.provided(ConversationPort) };
}

/** The sends a ferret still holds: a refusal before any key leaves only a withdrawn tombstone, which this leaves out. */
const live = async (
  api: () => { sends(ferret: FerretId): Promise<{ sends: readonly { withdrawn?: boolean | undefined }[] }> },
) => (await api().sends(F1)).sends.filter(row => row.withdrawn !== true);

const send = async (
  host: Awaited<ReturnType<typeof conversation>>['host'],
  id = 'req-1',
  ferret = 'f1',
  body: Record<string, unknown> = { message: 'hello there' },
  as: TestCaller = owner(),
) =>
  await host.request('POST', `/v1/ferrets/${ferret}/send`, {
    as,
    headers: { 'x-fy-request-id': id },
    body,
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

  test('a runner failure nobody could classify is a failed send (500) and the record STAYS: what reached the pane is uncertain', async () => {
    const { host, ferrets, api } = await conversation();
    ferrets.script.deliver = async () => {
      throw new Error('the runner failed in a way it could not classify');
    };

    const response = await send(host);

    expect([response.status, response.json<{ code: string }>().code]).toEqual([500, 'session_send_failed']);
    expect((await api().sends(F1)).sends.map(row => [row.sendId, row.fate])).toEqual([['req-1', 'accepted']]);
    // The same id again types nothing: the kept record answers it (as today's duplicate is answered from its record).
    expect((await send(host)).status).toBe(200);
    expect(ferrets.delivered).toHaveLength(1);
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

describe('the closed taxonomy of a delivery, as today’s send routes answer it', () => {
  test.each(['busy', 'dialog', 'exited'] as const)(
    'not_ready (%s), and no queue to fall back on: 409 send_refused with its ONE fixed sentence; nothing typed, so the record is taken back',
    async why => {
      const { host, ferrets, api } = await conversation();
      ferrets.script.deliver = async () => err({ refused: 'not_ready', why });
      // A runner that cannot queue: only a busy pane is offered the queue at all.
      ferrets.script.queue = async () => err({ refused: 'plugin_unavailable' });

      const response = await send(host);

      expect([response.status, response.json<{ code: string }>().code]).toEqual([409, 'send_refused']);
      expect(response.json<{ error: string }>().error).toBe(NOT_READY_SENTENCES[why]);
      expect(await live(api)).toEqual([]);
      expect(ferrets.queued).toEqual(why === 'busy' ? ['hello there'] : []);
      // The id may start over once the pane is ready.
      ferrets.script.deliver = async () => ok('turn-started');
      expect((await send(host)).status).toBe(200);
      await host.stop();
    },
  );

  test('composer_occupied: 409 composer_occupied with the person’s draft in the body; nothing typed, record taken back', async () => {
    const { host, ferrets, api } = await conversation();
    ferrets.script.deliver = async () => err({ refused: 'composer_occupied', draft: 'half a thought' });

    const response = await send(host);

    expect([response.status, response.json<{ code: string }>().code]).toEqual([409, 'composer_occupied']);
    expect(response.json<{ draft?: string }>().draft).toBe('half a thought');
    expect(response.json<{ error: string }>().error).toContain('already holds unsent text ("half a thought")');
    expect(await live(api)).toEqual([]);
    await host.stop();
  });

  test('composer_unreadable: 409 send_refused saying nothing was typed; record taken back', async () => {
    const { host, ferrets, api } = await conversation();
    ferrets.script.deliver = async () => err({ refused: 'composer_unreadable' });

    const response = await send(host);

    expect([response.status, response.json<{ code: string }>().code]).toEqual([409, 'send_refused']);
    expect(response.json<{ error: string }>().error).toContain('so nothing was typed');
    expect(await live(api)).toEqual([]);
    await host.stop();
  });

  test('unconfirmed: 409 send_unconfirmed with the sendId, the record kept as unaccounted, never typed again', async () => {
    const { host, ferrets, api } = await conversation();
    ferrets.script.deliver = async () => err({ unconfirmed: true, stranded: false });

    const response = await send(host);

    expect([response.status, response.json<{ code: string }>().code]).toEqual([409, 'send_unconfirmed']);
    expect(response.json<{ sendId?: string }>().sendId).toBe('req-1');
    expect(response.json<{ error: string }>().error).toBe(UNCONFIRMED_SENTENCE);
    expect((await api().sends(F1)).sends.map(row => [row.sendId, row.fate, row.unaccountedReason])).toEqual([
      ['req-1', 'unaccounted', 'landing_unconfirmed'],
    ]);
    // Its retry answers the same, with the same id, and types nothing: it is never read as `sent`.
    ferrets.script.deliver = async () => ok('turn-started');
    const again = await send(host);
    expect([again.status, again.json<{ code: string }>().code]).toEqual([409, 'send_unconfirmed']);
    expect(again.json<{ sendId?: string }>().sendId).toBe('req-1');
    expect(ferrets.delivered).toHaveLength(1);
    await host.stop();
  });

  test('unconfirmed and stranded: 409 send_unconfirmed saying it stayed after Enter, marked typed-not-sent', async () => {
    const { host, ferrets, api } = await conversation();
    ferrets.script.deliver = async () => err({ unconfirmed: true, stranded: true });

    const response = await send(host);

    expect([response.status, response.json<{ code: string }>().code]).toEqual([409, 'send_unconfirmed']);
    expect(response.json<{ error: string }>().error).toBe(STRANDED_SENTENCE);
    const [row] = (await api().sends(F1)).sends;
    expect([row?.fate, row?.typedNotSent]).toEqual(['unaccounted', true]);
    await host.stop();
  });

  test.each<[string, HarnessDeliveryFailure, string]>([
    // A busy pane goes to the queue (its own describe); a dialog is the not_ready that is answered at once.
    ['not_ready', { refused: 'not_ready', why: 'dialog' }, 'send_refused'],
    ['composer_occupied', { refused: 'composer_occupied', draft: 'mine' }, 'composer_occupied'],
    ['composer_unreadable', { refused: 'composer_unreadable' }, 'send_refused'],
    ['unconfirmed', { unconfirmed: true, stranded: false }, 'send_unconfirmed'],
    ['held', { refused: 'held' }, 'held'],
  ])('the port answers %s with the route’s code', async (_name, failure, code) => {
    const { host, ferrets, api } = await conversation();
    ferrets.script.deliver = async () => err(failure);

    const sent = await api().send(F1, { kind: 'owner' }, { message: 'nudge', sendId: 's-1' });

    expect(sent).toMatchObject({ ok: false, error: { code } });
    await host.stop();
  });

  test('the port’s retry of an unconfirmed send answers send_unconfirmed again and types nothing', async () => {
    const { host, ferrets, api } = await conversation();
    ferrets.script.deliver = async () => err({ unconfirmed: true, stranded: false });

    await api().send(F1, { kind: 'owner' }, { message: 'nudge', sendId: 's-1' });
    const again = await api().send(F1, { kind: 'owner' }, { message: 'nudge', sendId: 's-1' });

    expect(again).toMatchObject({ ok: false, error: { code: 'send_unconfirmed' } });
    expect(ferrets.delivered).toHaveLength(1);
    await host.stop();
  });

  test('the port’s unconfirmed answer names the send it minted, so the caller can ask about exactly that one', async () => {
    const { host, ferrets, api } = await conversation();
    ferrets.script.deliver = async () => err({ unconfirmed: true, stranded: false });

    const sent = await api().send(F1, { kind: 'owner' }, { message: 'nudge' });

    const [row] = (await api().sends(F1)).sends;
    expect(row?.sendId).toBeString();
    expect(sent).toMatchObject({
      ok: false,
      error: { code: 'send_unconfirmed', message: `${UNCONFIRMED_SENTENCE} (send ${row?.sendId})` },
    });
    await host.stop();
  });

  test('an unconfirmed send whose record cannot be settled is the uncertain 500: record kept, nothing typed again', async () => {
    const { host, ferrets, api, writes } = await conversation();
    ferrets.script.deliver = async () => {
      writes.fail = true;
      return err({ unconfirmed: true, stranded: false });
    };

    const response = await send(host);
    writes.fail = false;

    expect([response.status, response.json<{ code: string }>().code]).toEqual([500, 'session_send_failed']);
    const said = response.json<{ error: string }>().error;
    expect(said).toBe(
      `${UNCONFIRMED_SENTENCE}. Its record could not be marked unconfirmed, so a repeat of this send may wrongly read as sent; check the ferret’s terminal instead`,
    );
    // The disk's own words (a path) stay out of the answer.
    expect(said).not.toContain('ENOSPC');
    expect((await live(api)).map(row => (row as { fate?: string }).fate)).toEqual(['accepted']);
    expect(ferrets.delivered).toHaveLength(1);
    await host.stop();
  });
});

describe('a send to a ferret still working on its turn goes to the harness’s own queue (today’s busy path)', () => {
  const busy = async (ferrets: HarnessFerrets, queued: () => Promise<Result<QueueOutcome, HarnessDeliveryFailure>>) => {
    ferrets.script.deliver = async () => err({ refused: 'not_ready', why: 'busy' });
    ferrets.script.queue = queued;
  };
  type Row = { sendId: string; fate: string; path?: string; typedNotSent?: boolean; unaccountedReason?: string };
  const rows = async (api: Awaited<ReturnType<typeof conversation>>['api']) =>
    (await api().sends(F1)).sends.map(row => {
      const { sendId, fate, path, typedNotSent, unaccountedReason } = row as unknown as Row;
      return { sendId, fate, path, typedNotSent, unaccountedReason };
    });

  test('held: 200 queued, the row queued on the busy path, and a repeat of the id types nothing', async () => {
    const { host, ferrets, api } = await conversation();
    await busy(ferrets, async () => ok('held'));

    const response = await send(host);

    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({ disposition: 'queued', sendId: 'req-1', fate: 'queued' });
    expect(ferrets.delivered).toEqual([{ text: 'hello there' }]);
    expect(ferrets.queued).toEqual(['hello there']);
    expect(await rows(api)).toEqual([
      { sendId: 'req-1', fate: 'queued', path: 'native-inline', typedNotSent: undefined, unaccountedReason: undefined },
    ]);
    const again = await send(host);
    expect(again.status).toBe(200);
    expect(again.json()).toMatchObject({ disposition: 'queued', fate: 'queued' });
    expect([ferrets.delivered.length, ferrets.queued.length]).toEqual([1, 1]);
    await host.stop();
  });

  test('held, but the row cannot be settled: still 200 queued (not an error), the row stays accepted on the direct path, a repeat types nothing', async () => {
    const { host, ferrets, api, writes } = await conversation();
    await busy(ferrets, async () => {
      writes.fail = true;
      return ok('held');
    });

    const response = await send(host);
    writes.fail = false;

    // The message IS in the harness's queue: an error here would invite the caller to send it again as a new id.
    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({ disposition: 'queued', sendId: 'req-1', fate: 'queued' });
    expect(await rows(api)).toEqual([
      { sendId: 'req-1', fate: 'accepted', path: 'direct', typedNotSent: undefined, unaccountedReason: undefined },
    ]);
    const again = await send(host);
    expect(again.status).toBe(200);
    // Answered from the row as any typed direct send is: the honest 'queued' was the first answer's.
    expect(again.json()).toMatchObject({ disposition: 'delivered', sendId: 'req-1', fate: 'accepted' });
    expect([ferrets.delivered.length, ferrets.queued.length]).toEqual([1, 1]);
    await host.stop();
  });

  test('left (out of the composer, no queue shows it): 200 sent, the row stays accepted on the busy path', async () => {
    const { host, ferrets, api } = await conversation();
    await busy(ferrets, async () => ok('left'));

    const response = await send(host);

    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({ disposition: 'sent', fate: 'accepted' });
    expect((await rows(api)).map(row => [row.fate, row.path])).toEqual([['accepted', 'native-inline']]);
    await host.stop();
  });

  test('typed (still in the composer after the queue keys): 409 send_unconfirmed as stranded, never typed again', async () => {
    const { host, ferrets, api } = await conversation();
    await busy(ferrets, async () => ok('typed'));

    const response = await send(host);

    expect([response.status, response.json<{ code: string }>().code]).toEqual([409, 'send_unconfirmed']);
    expect(response.json<{ error: string; sendId: string }>()).toMatchObject({
      error: STRANDED_SENTENCE,
      sendId: 'req-1',
    });
    expect(await rows(api)).toEqual([
      {
        sendId: 'req-1',
        fate: 'unaccounted',
        path: 'native-inline',
        typedNotSent: true,
        unaccountedReason: 'landing_unconfirmed',
      },
    ]);
    expect((await send(host)).status).toBe(409);
    expect([ferrets.delivered.length, ferrets.queued.length]).toEqual([1, 1]);
    await host.stop();
  });

  test('the queue typed and nothing proved it: 409 send_unconfirmed, the row kept unaccounted', async () => {
    const { host, ferrets, api } = await conversation();
    await busy(ferrets, async () => err({ unconfirmed: true, stranded: false }));

    const response = await send(host);

    expect([response.status, response.json<{ code: string }>().code]).toEqual([409, 'send_unconfirmed']);
    expect(response.json<{ error: string }>().error).toBe(UNCONFIRMED_SENTENCE);
    expect((await rows(api)).map(row => [row.fate, row.path])).toEqual([['unaccounted', 'native-inline']]);
    await host.stop();
  });

  test('the queue refused before a key (a draft in the way): 409 composer_occupied, the record taken back', async () => {
    const { host, ferrets, api } = await conversation();
    await busy(ferrets, async () => err({ refused: 'composer_occupied', draft: 'half a thought' }));

    const response = await send(host);

    expect([response.status, response.json<{ code: string }>().code]).toEqual([409, 'composer_occupied']);
    expect(await live(api)).toEqual([]);
    await host.stop();
  });

  test('the queue is tried ONCE: a queue that finds the pane busy too is the busy refusal, not a second try', async () => {
    const { host, ferrets, api } = await conversation();
    await busy(ferrets, async () => err({ refused: 'not_ready', why: 'busy' }));

    const response = await send(host);

    expect([response.status, response.json<{ code: string }>().code]).toEqual([409, 'send_refused']);
    expect(response.json<{ error: string }>().error).toBe(NOT_READY_SENTENCES.busy);
    expect([ferrets.delivered.length, ferrets.queued.length]).toEqual([1, 1]);
    expect(await live(api)).toEqual([]);
    await host.stop();
  });

  test('a queue that failed in a way nobody could classify is the uncertain 500: record kept', async () => {
    const { host, ferrets, api } = await conversation();
    await busy(ferrets, async () => {
      throw new Error('tmux: lost server');
    });

    const response = await send(host);

    expect([response.status, response.json<{ code: string }>().code]).toEqual([500, 'session_send_failed']);
    expect((await rows(api)).map(row => row.fate)).toEqual(['accepted']);
    await host.stop();
  });

  test('a peer’s send to a working lead is queued under its banner, through the port', async () => {
    const { host, ferrets, api } = await conversation();
    await busy(ferrets, async () => ok('held'));

    const sent = await api().send(
      F1,
      { kind: 'ferret', ferret: CALLER },
      { message: 'done: abc123', sendId: 's-1', label: 'action' },
    );

    expect(sent).toMatchObject({ ok: true, value: { disposition: 'queued', fate: 'queued' } });
    expect(ferrets.queued).toEqual([`${banner('message', 'action')}done: abc123`]);
    await host.stop();
  });

  test.each(['dialog', 'exited'] as const)('not_ready (%s) is never queued', async why => {
    const { host, ferrets } = await conversation();
    ferrets.script.deliver = async () => err({ refused: 'not_ready', why });
    ferrets.script.queue = async () => ok('held');

    expect((await send(host)).status).toBe(409);
    expect(ferrets.queued).toEqual([]);
    await host.stop();
  });
});

describe('a send has no target rule: no caller reaches Ferrets, and a ferret is the SENDER', () => {
  test('the port’s send by a ferret opens the seam with NO caller, so it matches the route', async () => {
    const { host, ferrets, api } = await conversation();

    const sent = await api().send(F1, { kind: 'ferret', ferret: CALLER }, { message: 'psst', sendId: 's-1' });

    expect(sent.ok).toBe(true);
    expect(ferrets.opens).toEqual([{ ferret: F1, caller: undefined }]);
    await host.stop();
  });

  test('the port’s send by a ferret is ledgered as that ferret’s message, not the owner’s', async () => {
    const { host, api } = await conversation();

    await api().send(F1, { kind: 'ferret', ferret: CALLER }, { message: 'psst', sendId: 's-1' });
    await api().send(F1, { kind: 'owner' }, { message: 'hi', sendId: 's-2' });

    const rows = (await api().sends(F1)).sends;
    expect(rows.map(row => [row.sendId, row.senderKind, row.from])).toEqual(
      expect.arrayContaining([
        ['s-1', 'agent', CALLER],
        ['s-2', 'human', undefined],
      ]),
    );
    await host.stop();
  });

  test('the port’s send by the owner opens it with no caller', async () => {
    const { host, ferrets, api } = await conversation();

    await api().send(F1, { kind: 'owner' }, { message: 'hi', sendId: 's-1' });

    expect(ferrets.opens).toEqual([{ ferret: F1, caller: undefined }]);
    await host.stop();
  });

  test('the send ROUTE names no caller: a ferret messaging its parent or a peer is not a ferret acting on a helper', async () => {
    const { host, ferrets } = await conversation();

    await send(host);

    expect(ferrets.opens).toEqual([{ ferret: F1, caller: undefined }]);
    await host.stop();
  });
});

describe('the CLI’s own send body goes: `now: false` and a label are not extras', () => {
  /** Exactly what `cli/lib/send/controller.ts` posts for `fy send f1 hi` (`now` and `label` are always set). */
  const CLI_BODY = { message: 'hello there', attachmentIds: [], now: false, label: 'action' };

  test('the owner’s `fy send`: 200, delivered once', async () => {
    const { host, ferrets } = await conversation();

    const response = await send(host, 'req-cli', 'f1', CLI_BODY);

    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({ disposition: 'sent', sendId: 'req-cli' });
    expect(ferrets.delivered).toEqual([{ text: 'hello there' }]);
    await host.stop();
  });

  // Gate's standing for a ferret's own `fys_` token: `ferret:<id>` and the ferret credential, as admission stamps them.
  test('a ferret’s `fy send` through the route: 200, delivered once, under its banner and label', async () => {
    const { host, ferrets, api } = await conversation(undefined, OPEN, {}, { sendStanding: ferretStanding(CALLER) });

    const response = await send(host, 'req-cli', 'f1', CLI_BODY, asFerret(CALLER));

    expect(response.status).toBe(200);
    expect(ferrets.delivered).toEqual([{ text: `${banner('message', 'action')}hello there` }]);
    expect((await api().sends(F1)).sends.map(row => [row.sendId, row.senderKind, row.from, row.fromName])).toEqual([
      ['req-cli', 'agent', CALLER, LEAD_NAME],
    ]);
    await host.stop();
  });

  test.each(['action', 'blocker'] as const)(
    'a peer’s %s label types at once, as the seam types (the port)',
    async label => {
      const { host, ferrets, api } = await conversation();

      const sent = await api().send(
        F1,
        { kind: 'ferret', ferret: CALLER },
        { message: 'psst', sendId: 's-1', now: false, label },
      );

      expect(sent.ok).toBe(true);
      expect(ferrets.delivered).toEqual([{ text: `${banner('message', label)}psst` }]);
      expect((await api().sends(F1)).sends.map(row => [row.sendId, row.senderKind, row.from])).toEqual([
        ['s-1', 'agent', CALLER],
      ]);
      await host.stop();
    },
  );

  test('the port’s send with `now: false`, `replyExpected: false` and an action label goes', async () => {
    const { host, ferrets, api } = await conversation();

    const sent = await api().send(
      F1,
      { kind: 'ferret', ferret: CALLER },
      { message: 'psst', sendId: 's-1', now: false, replyExpected: false, label: 'action' },
    );

    expect(sent.ok).toBe(true);
    expect(ferrets.delivered).toEqual([{ text: `${banner('message', 'action')}psst` }]);
    await host.stop();
  });
});

describe('a peer’s message is typed under today’s banner, so it never reads as the owner speaking', () => {
  test('the port: a ferret’s send is typed as banner + label + message, and ledgered as typed', async () => {
    const { host, ferrets, api } = await conversation();

    const sent = await api().send(
      F1,
      { kind: 'ferret', ferret: CALLER },
      { message: 'psst', sendId: 's-1', label: 'blocker' },
    );

    expect(sent.ok).toBe(true);
    const typed =
      '[message · blocker from ferret kamila (session lead) — not from the owner] To reply: fy send kamila "<reply>"\npsst';
    expect(ferrets.delivered).toEqual([{ text: typed }]);
    const rows = (await api().sends(F1)).sends;
    expect(rows.map(row => [row.sendId, row.message, row.senderKind, row.from, row.fromName])).toEqual([
      ['s-1', typed, 'agent', CALLER, LEAD_NAME],
    ]);
    await host.stop();
  });

  test('the port: a send with no label is typed under the plain banner', async () => {
    const { host, ferrets, api } = await conversation();

    await api().send(F1, { kind: 'ferret', ferret: CALLER }, { message: 'psst', sendId: 's-1' });

    expect(ferrets.delivered).toEqual([{ text: `${banner('message')}psst` }]);
    await host.stop();
  });

  test('the ROUTE: a ferret’s own credential (Gate’s `ferret:<id>` standing) types the CLI body under the banner, label and all', async () => {
    const { host, ferrets, api } = await conversation(undefined, OPEN, {}, { sendStanding: ferretStanding(CALLER) });

    const response = await send(
      host,
      'req-peer',
      'f1',
      { message: 'hello there', attachmentIds: [], now: false, label: 'action' },
      asFerret(CALLER),
    );

    expect(response.status).toBe(200);
    expect(ferrets.delivered).toEqual([
      {
        text: '[message · action from ferret kamila (session lead) — not from the owner] To reply: fy send kamila "<reply>"\nhello there',
      },
    ]);
    expect((await api().sends(F1)).sends.map(row => [row.sendId, row.senderKind, row.from])).toEqual([
      ['req-peer', 'agent', CALLER],
    ]);
    await host.stop();
  });

  test('the ROUTE: the owner’s send is typed as the bare message, and a label it carries is not honoured', async () => {
    const { host, ferrets } = await conversation();

    await send(host, 'req-own', 'f1', { message: 'hello there', now: false, label: 'blocker' });

    expect(ferrets.delivered).toEqual([{ text: 'hello there' }]);
    await host.stop();
  });

  test('the ROUTE: the owner’s own standing (Gate’s `admin-cli`) is typed bare and ledgered as the person', async () => {
    const { host, ferrets, api } = await conversation(undefined, OPEN, {}, { sendStanding: ownerStanding() });

    await send(host, 'req-own', 'f1', { message: 'hello there', now: false, label: 'blocker' });

    expect(ferrets.delivered).toEqual([{ text: 'hello there' }]);
    expect((await api().sends(F1)).sends.map(row => [row.sendId, row.senderKind, row.from])).toEqual([
      ['req-own', 'human', undefined],
    ]);
    await host.stop();
  });

  test('the ROUTE: the admin token plus the session header (Gate stamps `ferret:<id>`) types under the banner', async () => {
    const standing: CallStanding = {
      actor: ferretActor(CALLER),
      credential: { kind: 'authenticated', tokenClass: 'admin' },
    };
    const { host, ferrets, api } = await conversation(undefined, OPEN, {}, { sendStanding: standing });

    await send(host, 'req-hdr', 'f1', { message: 'hello there', now: false, label: 'blocker' });

    expect(ferrets.delivered).toEqual([{ text: `${banner('message', 'blocker')}hello there` }]);
    expect((await api().sends(F1)).sends.map(row => [row.sendId, row.senderKind, row.from])).toEqual([
      ['req-hdr', 'agent', CALLER],
    ]);
    await host.stop();
  });

  test('the ROUTE: a warden’s send is no peer’s — typed bare, ledgered as the person, its label not honoured', async () => {
    const { host, ferrets, api } = await conversation(undefined, OPEN, {}, { sendStanding: wardenStanding(CALLER) });

    await send(host, 'req-wdn', 'f1', { message: 'hello there', now: false, label: 'action' });

    expect(ferrets.delivered).toEqual([{ text: 'hello there' }]);
    expect((await api().sends(F1)).sends.map(row => [row.sendId, row.senderKind, row.from])).toEqual([
      ['req-wdn', 'human', undefined],
    ]);
    await host.stop();
  });

  test('the ROUTE: a ferret credential names the sender before the actor does, so an actor cannot be moved to forge one', async () => {
    const standing: CallStanding = { ...ferretStanding(CALLER), actor: ferretActor(ferretId('someone-else')) };
    const { host, ferrets, api } = await conversation(undefined, OPEN, {}, { sendStanding: standing });

    await send(host, 'req-frg', 'f1', { message: 'hello there' }, asFerret(CALLER));

    expect(ferrets.delivered).toEqual([{ text: `${banner('message')}hello there` }]);
    expect((await api().sends(F1)).sends.map(row => row.from)).toEqual([CALLER]);
    await host.stop();
  });

  // Tripwire: the r4 BLOCKER was the route keeping only a `peer:` actor, which Gate never stamps. An agent admin call
  // whose actor is `peer:<id>` must name NO sender: a route that reads that prefix again types a banner here and fails.
  test('the ROUTE reads no `peer:` actor: Gate never stamps one, so it names no sender and types the bare message', async () => {
    const standing: CallStanding = {
      actor: `peer:${CALLER}`,
      credential: { kind: 'authenticated', tokenClass: 'admin' },
    };
    const { host, ferrets, api } = await conversation(undefined, OPEN, {}, { sendStanding: standing });

    await send(host, 'req-old', 'f1', { message: 'hello there', now: false, label: 'action' });

    expect(ferrets.delivered).toEqual([{ text: 'hello there' }]);
    expect((await api().sends(F1)).sends.map(row => [row.sendId, row.senderKind, row.from])).toEqual([
      ['req-old', 'human', undefined],
    ]);
    await host.stop();
  });

  test('the app reads the typed text back as FROM that ferret (parsePeerEnvelope round-trip)', async () => {
    const { host, ferrets, api } = await conversation();

    await api().send(
      F1,
      { kind: 'ferret', ferret: CALLER },
      { message: 'ship it\nthen tell me', sendId: 's-1', label: 'action' },
    );

    const typed = ferrets.delivered[0]?.text ?? '';
    expect(parsePeerEnvelope(typed)).toMatchObject({
      envelope: { name: LEAD_NAME, sessionId: CALLER, kind: 'message', label: 'action', replyExpected: false },
      body: 'ship it\nthen tell me',
    });
    await host.stop();
  });

  test('the answer a recipient is parked on is typed as a reply', async () => {
    const { host, ferrets, api } = await conversation(undefined, OPEN, {
      waiting: { since: '2026-11-08T08:00:00.000Z' as Instant, peer: CALLER, peerName: LEAD_NAME },
    });

    await api().send(F1, { kind: 'ferret', ferret: CALLER }, { message: 'done', sendId: 's-1', label: 'action' });

    expect(ferrets.delivered).toEqual([{ text: `${banner('reply', 'action')}done` }]);
    await host.stop();
  });

  test('a sender Ferrets cannot find now is still named by its id, never typed in the owner’s voice', async () => {
    const { host, ferrets, api } = await conversation();
    const gone = ferretId('gone-1');

    await api().send(F1, { kind: 'ferret', ferret: gone }, { message: 'psst', sendId: 's-1' });

    expect(ferrets.delivered).toEqual([{ text: `${banner('message', undefined, 'gone-1', 'gone-1')}psst` }]);
    await host.stop();
  });

  test('a ferret sending to itself is typed as the bare message', async () => {
    const { host, ferrets, api } = await conversation();

    await api().send(F1, { kind: 'ferret', ferret: F1 }, { message: 'note to self', sendId: 's-1' });

    expect(ferrets.delivered).toEqual([{ text: 'note to self' }]);
    await host.stop();
  });

  test('the message is trimmed as today, and one with nothing in it is refused before anything is kept', async () => {
    const { host, ferrets, api } = await conversation();

    await api().send(F1, { kind: 'owner' }, { message: '  ship it \n', sendId: 's-1' });
    const empty = await api().send(F1, { kind: 'ferret', ferret: CALLER }, { message: '   ', sendId: 's-2' });

    expect(ferrets.delivered).toEqual([{ text: 'ship it' }]);
    expect(empty).toMatchObject({ ok: false, error: { code: 'send_refused' } });
    expect((await api().sends(F1)).sends.map(row => row.sendId)).toEqual(['s-1']);
    await host.stop();
  });
});

describe('a send carrying what the seam does not type yet is refused 503, never answered sent', () => {
  const post = async (
    host: Awaited<ReturnType<typeof conversation>>['host'],
    extra: Record<string, unknown>,
    as: TestCaller = owner(),
  ) => await send(host, 'req-x', 'f1', { message: 'hello there', ...extra }, as);

  test.each([
    ['attachmentIds', { attachmentIds: ['file-1'] }],
    ['now', { now: true }],
    ['replyExpected', { replyExpected: true }],
  ] as const)('the route refuses %s: 503, nothing opened, typed or recorded', async (_name, extra) => {
    const { host, ferrets, api } = await conversation();

    const response = await post(host, extra);

    expect([response.status, response.json<{ code: string }>().code]).toEqual([
      503,
      'conversation_terminal_unavailable',
    ]);
    expect(response.json<{ error: string }>().error).toBe(SEND_EXTRAS_UNAVAILABLE);
    expect(ferrets.opens).toEqual([]);
    expect(ferrets.delivered).toEqual([]);
    expect((await api().sends(F1)).sends).toEqual([]);
    await host.stop();
  });

  test.each<[string, { attachmentIds?: string[]; label?: 'fyi'; now?: boolean; replyExpected?: boolean }]>([
    ['attachmentIds', { attachmentIds: ['file-1'] }],
    ['label', { label: 'fyi' }],
    ['now', { now: true }],
    ['replyExpected', { replyExpected: true }],
  ])('the port refuses %s the same way', async (_name, extra) => {
    const { host, ferrets, api } = await conversation();

    const sent = await api().send(F1, { kind: 'ferret', ferret: CALLER }, { message: 'psst', sendId: 's-1', ...extra });

    expect(sent).toMatchObject({
      ok: false,
      error: { code: 'conversation_terminal_unavailable', message: SEND_EXTRAS_UNAVAILABLE },
    });
    expect(ferrets.delivered).toEqual([]);
    expect((await api().sends(F1)).sends).toEqual([]);
    await host.stop();
  });

  test('an empty attachment list carries nothing, so it goes', async () => {
    const { host, ferrets } = await conversation();

    expect((await post(host, { attachmentIds: [] })).status).toBe(200);
    expect(ferrets.delivered).toHaveLength(1);
    await host.stop();
  });
});

describe('a gate that is not open answers 503 before anything is opened, typed or kept', () => {
  const waiting = async () => await conversation(new HarnessFerrets(), CLOSED);

  test('the route’s send is 503 conversation_terminal_unavailable', async () => {
    const { host, ferrets, api } = await waiting();

    const response = await send(host);

    expect([response.status, response.json<{ code: string }>().code]).toEqual([
      503,
      'conversation_terminal_unavailable',
    ]);
    expect(response.json<{ error: string }>().error).toBe(SEND_UNAVAILABLE);
    expect(ferrets.opens).toEqual([]);
    expect(ferrets.delivered).toEqual([]);
    expect((await api().sends(F1)).sends).toEqual([]);
    await host.stop();
  });

  test('the port’s send says the same, so a retry of the same id never reads as sent', async () => {
    const { host, ferrets, api } = await waiting();

    const first = await api().send(F1, { kind: 'owner' }, { message: 'nudge', sendId: 's-1' });
    const again = await api().send(F1, { kind: 'owner' }, { message: 'nudge', sendId: 's-1' });

    expect(first).toMatchObject({
      ok: false,
      error: { code: 'conversation_terminal_unavailable', message: SEND_UNAVAILABLE },
    });
    expect(again).toEqual(first);
    expect(ferrets.opens).toEqual([]);
    expect((await api().sends(F1)).sends).toEqual([]);
    await host.stop();
  });

  test('the route’s interrupt is 503 and presses nothing', async () => {
    const { host, ferrets, acted } = await waiting();

    const response = await host.request('POST', '/v1/ferrets/f1/interrupt', { as: owner(), body: {} });

    expect([response.status, response.json<{ code: string }>().code]).toEqual([
      503,
      'conversation_terminal_unavailable',
    ]);
    expect(response.json<{ error: string }>().error).toBe(INTERRUPT_UNAVAILABLE);
    expect(ferrets.opens).toEqual([]);
    expect(ferrets.interrupts).toBe(0);
    expect(acted).toEqual([]);
    await host.stop();
  });

  test('the port’s interrupt refuses with the same code and presses nothing', async () => {
    const { host, ferrets, api } = await waiting();

    const result = await api().interrupt(F1, {});

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'conversation_terminal_unavailable', message: INTERRUPT_UNAVAILABLE },
    });
    expect(ferrets.opens).toEqual([]);
    expect(ferrets.interrupts).toBe(0);
    await host.stop();
  });
});

describe('interrupt: the session’s own refusals first, then the harness’s stop key under its own rule', () => {
  const interrupt = async (host: Awaited<ReturnType<typeof conversation>>['host'], ferret = 'f1') =>
    await host.request('POST', `/v1/ferrets/${ferret}/interrupt`, { as: owner(), body: {} });

  test('an auto ferret’s stop presses the harness’s stop, with no act of its own, and answers interrupted', async () => {
    const { host, ferrets, acted } = await conversation();

    const response = await interrupt(host);

    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({ id: 'f1', status: 'interrupted' });
    expect(ferrets.interrupts).toBe(1);
    expect(acted).toEqual([]);
    await host.stop();
  });

  test('an interactive ferret whose pane shows no work after the stop is handed back: awaiting_user', async () => {
    const { host, ferrets } = await conversation(new HarnessFerrets(), OPEN, { mode: 'interactive' });
    ferrets.script.interrupt = async () => ok({ pressed: true, working: false });

    const response = await interrupt(host);

    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({ id: 'f1', status: 'awaiting_user' });
    await host.stop();
  });

  test.each<[string, HarnessInterrupted]>([
    ['still working', { pressed: true, working: true }],
    ['unread afterwards', { pressed: true }],
  ])('an interactive ferret %s after the stop is interrupted, not handed back', async (_name, stopped) => {
    const { host, ferrets } = await conversation(new HarnessFerrets(), OPEN, { mode: 'interactive' });
    ferrets.script.interrupt = async () => ok(stopped);

    expect((await interrupt(host)).json()).toMatchObject({ status: 'interrupted' });
    await host.stop();
  });

  test('a pending structured question is refused BEFORE the harness is asked: 409, nothing pressed', async () => {
    const { host, ferrets, asking, api } = await conversation();
    expect(await asking()).toBeDefined();

    const response = await interrupt(host);

    expect([response.status, response.json<{ code: string }>().code]).toEqual([409, 'send_refused']);
    expect(response.json<{ error: string }>().error).toContain(`structured question ${QUESTION_TOOL_USE}`);
    expect(ferrets.opens).toEqual([]);
    expect(ferrets.interrupts).toBe(0);
    expect(await api().interrupt(F1, {})).toMatchObject({ ok: false, error: { code: 'send_refused' } });
    expect(ferrets.interrupts).toBe(0);
    await host.stop();
  });

  test.each<[string, Partial<FerretSummary>, string]>([
    ['stopped', { state: 'stopped', cause: { kind: 'stopped' } }, 'is stopped'],
    ['finished', { state: 'stopped', cause: { kind: 'completed' } }, 'is completed'],
    ['crashed', { state: 'stopped', cause: { kind: 'agent_crashed', exitCode: 1 } }, 'is failed'],
  ])('a %s ferret has no running turn: 409, nothing pressed', async (_name, f1, says) => {
    const { host, ferrets } = await conversation(new HarnessFerrets(), OPEN, f1);

    const response = await interrupt(host);

    expect([response.status, response.json<{ code: string }>().code]).toEqual([409, 'send_refused']);
    expect(response.json<{ error: string }>().error).toContain(`${says}; there is no running turn to interrupt`);
    expect(ferrets.interrupts).toBe(0);
    await host.stop();
  });

  test('an unknown ferret is 404 not-found', async () => {
    const { host, ferrets } = await conversation();

    const response = await interrupt(host, 'ghost');

    expect([response.status, response.json<{ code: string }>().code]).toEqual([404, 'not-found']);
    expect(ferrets.interrupts).toBe(0);
    await host.stop();
  });

  test('no_pane: 409 send_refused, saying nothing was pressed and to try again or revive', async () => {
    const { host, ferrets } = await conversation();
    ferrets.script.interrupt = async () => err({ refused: 'no_pane' });

    const response = await interrupt(host);

    expect([response.status, response.json<{ code: string }>().code]).toEqual([409, 'send_refused']);
    expect(response.json<{ error: string }>().error).toContain('nothing was pressed');
    expect(response.json<{ error: string }>().error).not.toMatch(/tmux|Escape|C-c|runner/);
    await host.stop();
  });

  test.each([
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

  test('the port refuses a toolUseId as the route does (501): a plain stop would report an abandon that never happened', async () => {
    const { host, ferrets, api } = await conversation();

    const result = await api().interrupt(F1, { toolUseId: 'toolu_1' });

    expect(result).toMatchObject({ ok: false, error: { code: 'question_abandon_unsupported' } });
    expect(ferrets.interrupts).toBe(0);
    await host.stop();
  });
});
