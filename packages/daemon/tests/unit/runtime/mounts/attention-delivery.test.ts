import { describe, it } from 'bun:test';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher, type ApiResponse, ApiRouter } from '../../../../src/lib/api/index.ts';
import {
  type AttentionBoardChange,
  type AttentionChangeObserver,
  AttentionConversation,
  AttentionReplyDelivery,
  AttentionService,
} from '../../../../src/lib/attention/index.ts';
import { attentionRoutes, type DirectNotificationSubsystem } from '../../../../src/lib/runtime/index.ts';
import { jsonBody, request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, FakeLedgerRepository, human } from './support.ts';

/**
 * THE ATTENTION LOOP, END TO END AT THE ROUTE: a ferret raises an item with the headers `fy attention
 * add` sends from inside its pane, the owner closes it by every path they have, and the ferret is told
 * exactly once each time (docs/attention.md § The loop).
 *
 * The live defect: the CLI sent no session header, so the raise was stored as the human's, and the
 * delivery — which tells only the ferret that asked — had nobody to tell. Every case below starts from
 * the real headers and the real service, so it fails the same way that box did.
 */

const AT = '2026-10-28T17:00:00.000Z';
const SESSION = 's1';

/** What the browser sends: the inbox and the in-ferret panel both answer through `attention-client.ts`. */
const browser = { authorization: `Bearer ${CREDENTIALS.admin}` } as const;

/** The send ledger's one rule that matters here: one send id is one message, however often it is sent. */
class RecordingSends {
  readonly sent = new Map<string, { sessionId: string; message: string }>();
  attempts = 0;

  async send(sessionId: string, message: string, sendId: string): Promise<void> {
    this.attempts += 1;
    if (!this.sent.has(sendId)) this.sent.set(sendId, { sessionId, message });
  }
}

/** Every board change told twice, as an out-of-order or retried notice would be. */
class TwiceTold implements AttentionChangeObserver {
  constructor(private readonly inner: AttentionChangeObserver) {}

  async changed(sessionId: string, change: AttentionBoardChange): Promise<void> {
    await this.inner.changed(sessionId, change);
    await this.inner.changed(sessionId, change);
  }
}

function loop() {
  const sends = new RecordingSends();
  const attention = new AttentionService(
    new FakeLedgerRepository(),
    { now: () => AT },
    { has: async sessionId => sessionId === SESSION },
    { raised: async () => undefined },
    new TwiceTold(new AttentionReplyDelivery(sends)),
  );
  const notifications: DirectNotificationSubsystem = {
    notifyDirect: async sessionId => ({ ok: true, value: { sessionId, delivered: 0 } }),
    enrolledDevices: async () => 1,
  };
  const dispatcher = new ApiDispatcher(
    new ApiRouter([...attentionRoutes(attention, notifications)]),
    CREDENTIALS,
    NO_GOVERNED_ROUTES_GUARD,
  );
  const post = async (body: unknown, headers: Readonly<Record<string, string>>): Promise<ApiResponse> =>
    await dispatcher.dispatch(
      request({ method: 'POST', path: `/v1/sessions/${SESSION}/attention`, headers, body: JSON.stringify(body) }),
    );
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
  return { sends, attention, post, raise };
}

describe('the attention loop, from a ferret’s raise to its delivered answer', () => {
  it('should tell the ferret once when the owner answers a choice in the inbox or the panel', async () => {
    // Arrange
    const { sends, post, raise } = loop();
    const choice = { kind: 'multiple-choice', options: [{ label: 'Looks good' }, { label: 'Something’s off' }] };
    const id = await raise('Does the loop work?', choice);

    // Act
    const answered = await post(
      { action: 'resolve', id, response: { kind: 'multiple-choice', choice: 'Something’s off' } },
      browser,
    );

    // Assert
    should(answered.status).equal(200);
    should(sends.attempts).equal(2);
    should([...sends.sent.entries()]).deepEqual([
      [
        `attention-${SESSION}-${id}`,
        { sessionId: SESSION, message: `[answer to !${id} «Does the loop work?»] Something’s off` },
      ],
    ]);
  });

  it('should tell the ferret once when the owner answers an open question in words', async () => {
    // Arrange
    const { sends, post, raise } = loop();
    const id = await raise('What should I call the next test item?');

    // Act
    await post({ action: 'resolve', id, response: { kind: 'open-question', answer: 'gaytem' } }, browser);

    // Assert
    should([...sends.sent.values()]).deepEqual([
      { sessionId: SESSION, message: `[answer to !${id} «What should I call the next test item?»] gaytem` },
    ]);
  });

  it('should tell the ferret once when the owner marks it done or dismisses it, from the app or `fy attention done`', async () => {
    // Arrange
    const { sends, post, raise } = loop();
    const doneInApp = await raise('First?');
    const doneAtShell = await raise('Second?');
    const dismissed = await raise('Third?');

    // Act — `fy attention done A2 --session s1` at the owner's own shell sends `human` (no session header).
    await post({ action: 'resolve', id: doneInApp }, browser);
    await post({ action: 'resolve', id: doneAtShell, note: 'Handled it myself' }, human);
    await post({ action: 'dismiss', id: dismissed }, browser);

    // Assert
    should([...sends.sent.values()].map(each => each.message)).deepEqual([
      `[done !${doneInApp} «First?»] The owner marked this done.`,
      `[answer to !${doneAtShell} «Second?»] Handled it myself`,
      `[dismissed !${dismissed} «Third?»] The owner dismissed this without an answer.`,
    ]);
    should(sends.sent.size).equal(3);
  });

  it('should not echo a ferret its own `fy attention done`', async () => {
    // Arrange
    const { sends, post, raise } = loop();
    const id = await raise('Mine to close?');

    // Act — the same command, run inside the ferret, carries its session header.
    const closed = await post({ action: 'resolve', id, note: 'sorted' }, agentIn(SESSION));

    // Assert
    should(closed.status).equal(200);
    should(sends.sent.size).equal(0);
  });

  it('should deliver a `!A1` reply in chat as the one message, and send nothing more when it resolves', async () => {
    // Arrange
    const { sends, attention, raise } = loop();
    const id = await raise('What should I call the next test item?');
    const conversation = new AttentionConversation(attention, 'fy');
    const words = `!${id} gaytem`;

    // Act — what the send route does with a person's chat message: prepare, deliver, then settle.
    const turn = await conversation.prepare(SESSION, words);
    await conversation.settle(SESSION, turn, words);

    // Assert — the chat message itself is the delivery; the board closing adds nothing.
    should(turn.message).equal(`[answer to !${id} «What should I call the next test item?»] ${words}`);
    should(sends.sent.size).equal(0);
    const board = await attention.list(SESSION);
    should(board.ok && board.value.resolved.map(item => item.id)).deepEqual([id]);
  });
});
