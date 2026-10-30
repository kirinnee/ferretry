import { describe, it } from 'bun:test';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher, type ApiResponse, ApiRouter } from '../../../../src/lib/api/index.ts';
import {
  AGENDA_REPLY_CAP_MS,
  AGENDA_REPLY_SETTLE_MS,
  type AgendaBoardChange,
  AgendaBoardUndelivered,
  type AgendaChangeObserver,
  type AgendaComposerState,
  AgendaConversation,
  AgendaNotTyped,
  type AgendaOutbox,
  type AgendaOutboxRepository,
  AgendaReplyBatcher,
  AgendaReplyDelivery,
  type AgendaReplyTimers,
  AgendaService,
} from '../../../../src/lib/agenda/index.ts';
import { agendaRoutes, type DirectNotificationSubsystem } from '../../../../src/lib/runtime/index.ts';
import { jsonBody, request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, FakeLedgerRepository, human } from './support.ts';

/**
 * THE ATTENTION LOOP, END TO END AT THE ROUTE: a ferret raises an item with the headers `fy attention
 * add` sends from inside its pane, the owner closes it by every path they have, and the ferret is told
 * exactly once — in ONE message per burst of answers (docs/agenda.md § The loop).
 *
 * The board, the delivery observer, the batcher and the routes are the real ones; only the files, the
 * timers and the send path are fakes. A timer here does not fire on its own: a case reads the delay it
 * was armed with, then runs the flush the timer would have run.
 */

const START = Date.parse('2026-10-28T17:00:00.000Z');
const SESSION = 's1';
/** The stamp a batch begun when the first window closes carries in its send id. */
const STAMP = (START + AGENDA_REPLY_SETTLE_MS).toString(36);

/** What the browser sends: the inbox and the in-ferret panel both answer through `agenda-client.ts`. */
const browser = { authorization: `Bearer ${CREDENTIALS.admin}` } as const;

/**
 * The send ledger's one rule that matters here: one send id is one message, however often it is sent. A
 * case may make it refuse, as the real send path does for a draft in the composer (nothing typed).
 */
class RecordingSends {
  readonly sent = new Map<string, { sessionId: string; message: string }>();
  attempts = 0;
  refusal?: Error;

  async send(sessionId: string, message: string, sendId: string): Promise<void> {
    this.attempts += 1;
    if (this.refusal !== undefined) throw this.refusal;
    if (!this.sent.has(sendId)) this.sent.set(sendId, { sessionId, message });
  }
}

/** Every board change told twice, as an out-of-order or retried notice would be. */
class TwiceTold implements AgendaChangeObserver {
  constructor(private readonly inner: AgendaChangeObserver) {}

  async changed(sessionId: string, change: AgendaBoardChange): Promise<void> {
    await this.inner.changed(sessionId, change);
    await this.inner.changed(sessionId, change);
  }
}

class MemoryOutboxes implements AgendaOutboxRepository {
  readonly files = new Map<string, AgendaOutbox>();

  async read(sessionId: string): Promise<AgendaOutbox | null> {
    return this.files.get(sessionId) ?? null;
  }

  async write(outbox: AgendaOutbox): Promise<void> {
    this.files.set(outbox.sessionId, structuredClone(outbox));
  }
}

/** Timers that only remember when they would fire. */
class ArmedTimers implements AgendaReplyTimers {
  readonly armed = new Map<string, number>();

  schedule(key: string, delayMs: number): void {
    this.armed.set(key, delayMs);
  }

  cancel(key: string): void {
    this.armed.delete(key);
  }
}

class ManualClock {
  constructor(public ms = START) {}

  now(): string {
    return new Date(this.ms).toISOString();
  }
}

const inline = { run: async <T>(_key: string, task: () => Promise<T>): Promise<T> => await task() };

function loop(outboxes = new MemoryOutboxes(), sends = new RecordingSends()) {
  const clock = new ManualClock();
  const timers = new ArmedTimers();
  const composer: { state: AgendaComposerState } = { state: 'empty' };
  const batcher = new AgendaReplyBatcher(outboxes, sends, timers, inline, clock, undefined, undefined, {
    composer: { state: async () => composer.state },
    receipts: { receipt: async () => ({ state: 'delivered' }) },
    // The board, built just below, reopens what did not arrive — read lazily, as the composition root does.
    undelivered: new AgendaBoardUndelivered({
      undelivered: async (...parameters) => await agenda.undelivered(...parameters),
    }),
  });
  const agenda: AgendaService = new AgendaService(
    new FakeLedgerRepository(),
    { now: () => clock.now() },
    { has: async sessionId => sessionId === SESSION },
    { raised: async () => undefined },
    new TwiceTold(new AgendaReplyDelivery(batcher, 'fy')),
  );
  const notifications: DirectNotificationSubsystem = {
    agendaDelivered: async () => 0,
    enrolledDevices: async () => 1,
  };
  const dispatcher = new ApiDispatcher(
    new ApiRouter([...agendaRoutes(agenda, notifications, batcher)]),
    CREDENTIALS,
    NO_GOVERNED_ROUTES_GUARD,
  );
  const post = async (
    body: unknown,
    headers: Readonly<Record<string, string>>,
    path = `/v1/sessions/${SESSION}/attention`,
  ): Promise<ApiResponse> =>
    await dispatcher.dispatch(request({ method: 'POST', path, headers, body: JSON.stringify(body) }));
  const raise = async (subject: string, ask: unknown = { kind: 'open-question' }): Promise<string> => {
    const response = await post(
      { action: 'add', subject, why: `${subject} why`, howToResolve: 'answer it', ask },
      agentIn(SESSION),
    );
    should(response.status).equal(200);
    const items = jsonBody(response).items as readonly { id: string; subject: string; raisedBy: string }[];
    const raised = items.find(item => item.subject === subject);
    should(raised).containDeep({ raisedBy: 'agent' });
    return raised?.id ?? '';
  };
  /** Lets the armed window pass and runs the flush its timer would. */
  const settle = async (): Promise<void> => {
    clock.ms += timers.armed.get(SESSION) ?? 0;
    await batcher.flush(SESSION);
  };
  return { sends, attention: agenda, batcher, clock, timers, outboxes, composer, dispatcher, post, raise, settle };
}

describe('the attention loop when a Discuss cannot reach the ferret (the owner’s "swipe Discuss doesn’t send")', () => {
  it('should hold a Discuss while the ferret’s message box holds text, never typing into it', async () => {
    // Arrange
    const { sends, outboxes, composer, post, raise, settle, dispatcher } = loop();
    const id = await raise('Set up ProtoDurian, step by step');
    composer.state = 'occupied';

    // Act — swipe down: Discuss.
    await post({ action: 'discuss', id }, browser);
    await settle();
    const board = await dispatcher.dispatch(request({ path: `/v1/sessions/${SESSION}/attention`, headers: browser }));

    // Assert — nothing typed, nothing recorded as delivered: it is still waiting to go, and the board says why.
    should(sends.attempts).equal(0);
    should(outboxes.files.get(SESSION)?.pending.map(each => each.id)).deepEqual([`${id}~1`]);
    should(outboxes.files.get(SESSION)?.delivered).be.empty();
    should(jsonBody(board).delivery).deepEqual({ sending: [], heldForComposer: true });
  });

  it('should give a Discuss the send path refused back to the owner as a card, instead of counting it delivered', async () => {
    // Arrange — before this fix the refusal was swallowed and the outbox wrote the item down as delivered.
    const { sends, outboxes, post, raise, settle, attention: agenda } = loop();
    const id = await raise('Set up ProtoDurian, step by step');
    sends.refusal = new Error('session s1 is quarantined awaiting a person');

    // Act
    await post({ action: 'discuss', id, note: 'I do not follow step 4' }, browser);
    await settle();
    const listed = await agenda.list(SESSION);

    // Assert — open again, out of discussion, with the discussion kept for Retry and the reason said.
    if (!listed.ok) throw new Error(listed.error.message);
    const [item] = listed.value.items;
    should(item).not.have.property('waitingFor');
    should(item?.undelivered).containDeep({
      reply: { action: 'discuss', note: 'I do not follow step 4' },
      reason: 'session s1 is quarantined awaiting a person',
    });
    should(outboxes.files.get(SESSION)?.delivered).be.empty();
  });

  it('should put a Discuss back to waiting when the send path typed nothing, and deliver it once the box is empty', async () => {
    // Arrange — the composer read empty, then a person started typing before the keys went.
    const { sends, clock, post, raise, settle, batcher, attention: agenda } = loop();
    const id = await raise('Set up ProtoDurian, step by step');
    sends.refusal = new AgendaNotTyped('the composer holds unsent text');

    // Act
    await post({ action: 'discuss', id }, browser);
    await settle();
    sends.refusal = undefined;
    clock.ms += 5_000;
    await batcher.flush(SESSION);
    await batcher.watch(SESSION);
    const listed = await agenda.list(SESSION);

    // Assert — delivered once, and the item stays in discussion.
    should([...sends.sent.values()].map(each => each.message.slice(0, 9))).deepEqual(['[discuss ']);
    should(listed.ok && listed.value.items[0]?.waitingFor).equal('discussion');
  });
});

describe('the attention loop, from a ferret’s raise to its delivered answer', () => {
  it('should hold an answer for the settle window, say so on the board, then deliver it once', async () => {
    // Arrange
    const { sends, timers, post, raise, settle } = loop();
    const choice = { kind: 'multiple-choice', options: [{ label: 'Looks good' }, { label: 'Something’s off' }] };
    const id = await raise('Does the loop work?', choice);

    // Act
    const answered = await post(
      { action: 'resolve', id, response: { kind: 'multiple-choice', choice: 'Something’s off' } },
      browser,
    );
    const held = sends.sent.size;
    await settle();

    // Assert — nothing goes while the owner may still be answering; then one message, under the item's id
    // stamped with when its batch began.
    should(held).equal(0);
    should(jsonBody(answered).replies).deepEqual({ pending: [id], dueAt: '2026-10-28T17:00:10.000Z' });
    should(timers.armed.get(SESSION)).equal(AGENDA_REPLY_SETTLE_MS);
    should([...sends.sent.entries()]).deepEqual([
      [
        `agenda-${SESSION}-${id}-${STAMP}`,
        { sessionId: SESSION, message: `[answer to !${id} «Does the loop work?»] Something’s off` },
      ],
    ]);
  });

  it('should deliver a burst of answers, dones and dismissals as ONE message, each item once', async () => {
    // Arrange
    const { sends, post, raise, settle } = loop();
    const named = await raise('What should I call the next test item?');
    const doneInApp = await raise('First?');
    const doneAtShell = await raise('Second?');
    const dismissed = await raise('Third?');

    // Act — `fy attention done … --session s1` at the owner's own shell sends `human` (no session header).
    await post({ action: 'resolve', id: named, response: { kind: 'open-question', answer: 'gaytem' } }, browser);
    await post({ action: 'resolve', id: doneInApp }, browser);
    await post({ action: 'resolve', id: doneAtShell, note: 'Handled it myself' }, human);
    await post({ action: 'dismiss', id: dismissed }, browser);
    await settle();
    await settle();

    // Assert
    should([...sends.sent.entries()]).deepEqual([
      [
        `agenda-${SESSION}-${named}-${doneInApp}-${doneAtShell}-${dismissed}-${STAMP}`,
        {
          sessionId: SESSION,
          message: [
            `[answer to !${named} «What should I call the next test item?»] gaytem`,
            `[done !${doneInApp} «First?»] The owner marked this done.`,
            `[answer to !${doneAtShell} «Second?»] Done · note: Handled it myself`,
            `[dismissed !${dismissed} «Third?»] Not needed — the owner dismissed this without a reason.`,
          ].join('\n\n'),
        },
      ],
    ]);
    should(sends.attempts).equal(1);
  });

  it('should accept a reply with every action and deliver the answer and the reply together', async () => {
    // Arrange
    const { sends, post, raise, settle } = loop();
    const choice = { kind: 'multiple-choice', options: [{ label: 'Rebase now' }, { label: 'Wait' }] };
    const chosen = await raise('Rebase?', choice);
    const approved = await raise('Deploy?', { kind: 'permission' });
    const done = await raise('Look?', { kind: 'task' });
    const asked = await raise('Which account?');
    const dismissed = await raise('Still needed?', { kind: 'task' });

    // Act
    const results = [
      await post(
        { action: 'resolve', id: chosen, response: { kind: 'multiple-choice', choice: 'Wait' }, note: 'after lunch' },
        browser,
      ),
      await post(
        {
          action: 'resolve',
          id: approved,
          response: { kind: 'permission', decision: 'approve' },
          note: 'Always allow — same repo',
        },
        browser,
      ),
      await post({ action: 'resolve', id: done, note: 'Done — thanks' }, browser),
      await post({ action: 'needs-info', id: asked, note: 'the work one, please' }, browser),
      await post({ action: 'dismiss', id: dismissed, note: 'Skip — not this week' }, browser),
    ];
    await settle();

    // Assert
    should(results.map(each => each.status)).deepEqual([200, 200, 200, 200, 200]);
    const [sent] = [...sends.sent.values()];
    should(sent?.message.split('\n\n')).deepEqual([
      `[answer to !${chosen} «Rebase?»] Wait · note: after lunch`,
      `[answer to !${approved} «Deploy?»] Approved. · note: Always allow — same repo`,
      `[answer to !${done} «Look?»] Done · note: Done — thanks`,
      `[needs more info !${asked} «Which account?»] the work one, please`,
      `[dismissed !${dismissed} «Still needed?»] Not needed: Skip — not this week`,
    ]);
  });

  it('should restart the ten-second window on each card action (the cap is the batcher’s own case)', async () => {
    // Arrange
    const { clock, timers, post, raise } = loop();
    const ids = [
      await raise('One?'),
      await raise('Two?'),
      await raise('Three?'),
      await raise('Four?'),
      await raise('Five?'),
    ];

    // Act — an answer every 8 s: each one is inside the last one's window.
    const delays: number[] = [];
    for (const id of ids) {
      await post({ action: 'resolve', id }, browser);
      delays.push(timers.armed.get(SESSION) ?? -1);
      clock.ms += 8_000;
    }

    // Assert — the full settle window again after every action, well inside the first answer's cap.
    should(AGENDA_REPLY_CAP_MS).be.above(ids.length * 8_000);
    should(delays).deepEqual(ids.map(() => AGENDA_REPLY_SETTLE_MS));
  });

  it('should deliver at once when the owner taps "Send now", and hold nothing after', async () => {
    // Arrange
    const { sends, timers, post, raise } = loop();
    const id = await raise('Go now?');
    await post({ action: 'resolve', id }, browser);

    // Act
    const now = await post({}, browser, `/v1/sessions/${SESSION}/attention/replies`);
    await Promise.resolve();

    // Assert
    should(now.status).equal(200);
    should(jsonBody(now)).not.have.property('replies');
    should(timers.armed.has(SESSION)).be.false();
    should([...sends.sent.values()].map(each => each.message)).deepEqual([
      `[done !${id} «Go now?»] The owner marked this done.`,
    ]);
  });

  it('should refuse "Send now" for a session that does not exist', async () => {
    // Arrange
    const { post } = loop();

    // Act
    const response = await post({}, browser, '/v1/sessions/nobody/attention/replies');

    // Assert
    should(response.status).equal(404);
  });

  it('should not echo a ferret its own `fy attention done`', async () => {
    // Arrange
    const { sends, timers, post, raise } = loop();
    const id = await raise('Mine to close?');

    // Act — the same command, run inside the ferret, carries its session header.
    const closed = await post({ action: 'resolve', id, note: 'sorted' }, agentIn(SESSION));

    // Assert
    should(closed.status).equal(200);
    should(jsonBody(closed)).not.have.property('replies');
    should(timers.armed.size).equal(0);
    should(sends.sent.size).equal(0);
  });

  it('should deliver a `!A1` reply in chat as the one message, and close the item as replied', async () => {
    // Arrange
    const { sends, timers, attention: agenda, raise } = loop();
    const id = await raise('What should I call the next test item?');
    const conversation = new AgendaConversation(agenda);
    const words = `!${id} gaytem`;

    // Act — what the send route does with a person's chat message: prepare, deliver, then settle.
    const turn = await conversation.prepare(SESSION, words);
    await conversation.settle(SESSION, turn, words);

    // Assert — the chat message itself is the delivery, and the item is closed for the owner; nothing is held or resent.
    should(turn.message).equal(`[re !${id} «What should I call the next test item?»] ${words}`);
    should(turn.referenced.map(item => item.id)).deepEqual([id]);
    should(timers.armed.size).equal(0);
    should(sends.sent.size).equal(0);
    const board = await agenda.list(SESSION);
    should(board.ok && board.value.items).be.empty();
    should(board.ok && board.value.resolved[0]).containDeep({ id, disposition: 'replied' });
  });

  it('should deliver what a restart interrupted, once, under the same send id', async () => {
    // Arrange — one answer held, and one batch handed to the send path but never confirmed.
    const outboxes = new MemoryOutboxes();
    const sends = new RecordingSends();
    const before = loop(outboxes, sends);
    const held = await before.raise('Held?');
    const interrupted = await before.raise('Interrupted?');
    await before.post({ action: 'resolve', id: interrupted }, browser);
    const outbox = outboxes.files.get(SESSION) as AgendaOutbox;
    outboxes.files.set(SESSION, {
      ...outbox,
      pending: [],
      sending: [{ sendId: `attention-${SESSION}-${interrupted}`, ids: [interrupted], message: 'interrupted' }],
    });
    await sends.send(SESSION, 'interrupted', `attention-${SESSION}-${interrupted}`);
    await before.post({ action: 'resolve', id: held }, browser);

    // Act — a new daemon over the same files.
    const after = loop(outboxes, sends);
    await after.batcher.resume([SESSION, 'unknown-session']);
    await after.settle();
    await after.batcher.watch(SESSION);

    // Assert — the interrupted batch is the ledger's one message; the held answer goes once; both are
    // delivered only once their receipts are read.
    should([...sends.sent.keys()]).deepEqual([
      `attention-${SESSION}-${interrupted}`,
      `agenda-${SESSION}-${held}-${STAMP}`,
    ]);
    should(outboxes.files.get(SESSION)).containDeep({ pending: [], sending: [], delivered: [interrupted, held] });
  });
});
