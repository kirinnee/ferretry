import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deviceStanding, ferretStanding, ownerStanding } from '@ferretry/core-gate/contract/testing';
import type { CallerGovernance } from '@ferretry/core-gate/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { AskAnswer, AskSourceSpec } from '../../../contract/index.ts';
import {
  type AgendaLedger,
  type AgendaMutation,
  agendaLedgerDocument,
  applyAgendaCommand,
  applyAgendaCommandToSession,
} from '../../../daemon/lib/agenda/state-machine.ts';
import { gateReference } from '../../../daemon/lib/protocol/agenda-gate.ts';
import { agendaFilePath } from '../../support/daemon/agenda-state.ts';
import { asksHalf } from '../../support/daemon/asks-half.ts';

const BOARD = 'POST /v1/ferrets/:ferretId/agenda';
const F1 = { ferretId: 'f1' };
const AT = '2026-11-06T09:00:00.000Z';
const gate = {
  cardId: 'F12',
  laneId: 'to-test',
  laneName: 'To test',
  entry: 3,
  projectId: 'p1',
  cardTitle: 'Badge',
  options: [
    { id: 'done', label: 'Done', outcome: 'close' as const },
    { id: 'reopen', label: 'Not good', outcome: 'reopen-with-agenda' as const },
  ],
};
const reference = gateReference(gate);
/** A gate with one option is the one that also offers Not yet. */
const SOLO = [gate.options[0] as (typeof gate.options)[number]];
const ok = (mutation: AgendaMutation): AgendaLedger => {
  if (!mutation.ok) throw new Error(mutation.error.message);
  return mutation.ledger;
};

/** A ferret's board that carries one open card ask, written where the daemon reads it. */
async function home(options: typeof gate.options = gate.options): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'card-ask-answers-'));
  const raised = ok(
    applyAgendaCommandToSession(null, 'f1', {
      action: 'raise',
      actor: { kind: 'agent', sessionId: 'f1', name: null },
      request: {
        source: 'agent-raised',
        sourceRef: null,
        subject: 'Try it: Badge',
        why: 'Because.',
        context: 'ctx',
        premise: 'p',
        howToResolve: 'Choose',
        ask: { kind: 'open-question' },
        kind: 'reply',
      },
      at: AT,
    }),
  );
  const asked = ok(
    applyAgendaCommand(raised, {
      action: 'card-ask',
      actor: { kind: 'daemon', cause: 'system' },
      id: 'A1',
      operation: { kind: 'attach', ask: { gate: { ...gate, options } } },
      at: AT,
    }),
  );
  const file = agendaFilePath(root, 'f1', 'agenda.json');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, agendaLedgerDocument(asked));
  return root;
}

const halves: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(halves.splice(0).map(async half => await half.close()));
});

/** The card source: it moves the card as told, and records what it was asked. */
function board(outcome: 'applied' | { readonly refused: string } = 'applied', apply = true) {
  const applied: AskAnswer[] = [];
  const spec: AskSourceSpec = {
    schema: z.strictObject({}),
    title: 'Card {card}',
    form: false,
    ...(apply
      ? {
          apply: async (answer: AskAnswer) => {
            applied.push(answer);
            return outcome;
          },
        }
      : {}),
  };
  return { applied, providers: { 'ask.sources:card': spec } };
}
async function world(providers: Record<string, unknown> = {}, options?: typeof gate.options) {
  const half = await asksHalf(providers, { home: await home(options) });
  halves.push(half);
  return half;
}
type Half = Awaited<ReturnType<typeof world>>;

const choose = (
  half: Half,
  choice: string,
  extra: Record<string, unknown> = {},
  standing = ownerStanding('ui'),
  governance?: CallerGovernance,
) =>
  half.call(
    BOARD,
    F1,
    { action: 'resolve', id: 'A1', gate: true, response: { kind: 'multiple-choice', choice }, ...extra },
    standing,
    governance,
  );
const stateOf = async (half: Half) => {
  const [snapshot] = await half.asks.snapshots({ ferret: 'f1' });
  return snapshot;
};

describe('a card ask answered by the owner', () => {
  it('should move the card first through the card source, then record the answer the owner gave', async () => {
    // Arrange
    const card = board();
    const half = await world(card.providers);

    // Act
    const response = await choose(half, 'Done', { note: 'looks right' }, deviceStanding('phone'));

    // Assert
    expect(response.status).toBe(200);
    expect(card.applied).toHaveLength(1);
    expect(card.applied[0]).toMatchObject({
      ferret: 'f1',
      ask: 'A1',
      source: 'card',
      entry: reference,
      effect: 'choose',
      choice: 'Done',
      text: 'looks right',
      by: { kind: 'device', holder: 'phone' },
    });
    expect(card.applied[0]?.id).toMatch(/^an_[0-9a-f]{24}$/u);
    expect((await stateOf(half))?.items[0]?.cardAsks?.[0]?.answer).toMatchObject({
      response: { kind: 'multiple-choice', choice: 'Done' },
      note: 'looks right',
    });
  });

  it('should be recorded as Not yet when the owner set it aside, and the card told it was only a choice', async () => {
    // Arrange
    const card = board();
    const half = await world(card.providers, SOLO);

    // Act
    const response = await choose(half, 'Not yet');

    // Assert
    expect(response.status).toBe(200);
    expect(card.applied[0]).toMatchObject({ effect: 'choose', choice: 'Not yet' });
    expect((await stateOf(half))?.items[0]?.cardAsks?.[0]).toMatchObject({ notYet: expect.anything() });
  });

  it('should reopen the card with the owner’s words when they say what is not good', async () => {
    // Arrange
    const card = board();
    const half = await world(card.providers);

    // Act
    const typed = await half.call(
      BOARD,
      F1,
      { action: 'resolve', id: 'A1', gate: true, response: { kind: 'other', answer: 'the badge is clipped' } },
      ownerStanding('ui'),
    );

    // Assert
    expect(typed.status).toBe(200);
    expect(card.applied[0]).toMatchObject({ effect: 'clarify', text: 'the badge is clipped' });
  });

  it('should join a note to the words of a Not good', async () => {
    // Arrange
    const card = board();
    const half = await world(card.providers);

    // Act
    await choose(half, 'Not good', { note: 'on the phone' });

    // Assert
    expect(card.applied[0]?.text).toBe('on the phone');
  });

  it('should answer a replay of the same answer with the recorded one, and refuse a different one', async () => {
    // Arrange
    const card = board();
    const half = await world(card.providers);
    await choose(half, 'Done');

    // Act
    const replay = await choose(half, 'Done', { cardAsk: reference });
    const other = await choose(half, 'Not good', { cardAsk: reference, note: 'changed my mind' });

    // Assert
    expect(replay.status).toBe(200);
    expect(card.applied).toHaveLength(1);
    expect(other.status).toBe(409);
    expect(other.json()).toMatchObject({ code: 'gate_moved_on' });
  });
});

describe('a card ask answer the owner may not give, or the card cannot take', () => {
  const refusal = async (
    card: ReturnType<typeof board> | undefined,
    send: (half: Half) => ReturnType<typeof choose>,
  ) => {
    const half = await world(card?.providers);
    const response = await send(half);
    return { response, half, card };
  };

  it('should leave the ask open when the board cannot move the card', async () => {
    // Arrange / Act
    const { response, half } = await refusal(undefined, h => choose(h, 'Done'));
    const withoutApply = await refusal(board('applied', false), h => choose(h, 'Done'));

    // Assert
    expect(response.status).toBe(409);
    expect(response.json()).toMatchObject({ code: 'gate_not_moved' });
    expect(withoutApply.response.status).toBe(409);
    expect((await stateOf(half))?.items[0]?.cardAsks?.[0]?.answer).toBeUndefined();
  });

  it('should leave the ask open with the sentence the card gave when it refuses the move', async () => {
    // Arrange / Act
    const { response, half } = await refusal(board({ refused: 'the card is archived' }), h => choose(h, 'Done'));

    // Assert
    expect(response.status).toBe(409);
    expect(response.json()).toMatchObject({ code: 'gate_not_moved', error: 'the card is archived' });
    expect((await stateOf(half))?.items[0]?.cardAsks?.[0]?.answer).toBeUndefined();
  });

  it('should refuse a ferret, before the card is touched', async () => {
    // Arrange
    const card = board();
    const half = await world(card.providers);

    // Act
    const response = await choose(half, 'Done', {}, ferretStanding('f1' as FerretId));

    // Assert
    expect(response.status).toBe(403);
    expect(card.applied).toEqual([]);
  });

  it('should refuse a name the ask does not offer, an answer that is not a choice, and a Not good without words', async () => {
    // Arrange
    const card = board();
    const half = await world(card.providers);

    // Act
    const unknown = await choose(half, 'Maybe');
    const notAChoice = await half.call(
      BOARD,
      F1,
      { action: 'resolve', id: 'A1', gate: true, response: { kind: 'permission', decision: 'approve' } },
      ownerStanding('ui'),
    );
    const noWords = await choose(half, 'Not good');
    const tooLong = await choose(half, 'Not good', { note: 'x'.repeat(2_049) });

    // Assert
    expect(unknown.status).toBe(400);
    expect(unknown.json()).toMatchObject({ error: 'A1 has no option Maybe' });
    expect(notAChoice.status).toBe(400);
    expect(notAChoice.json()).toMatchObject({ error: 'A1 asks you to choose one of its options' });
    expect(noWords.status).toBe(400);
    expect(noWords.json()).toMatchObject({ error: 'say what is not good so the ferret can fix it' });
    expect(tooLong.status).toBe(400);
    expect(card.applied).toEqual([]);
  });

  it('should take own words only where the ask offers a Not good', async () => {
    // Arrange
    const card = board();
    const fresh = await world(card.providers, SOLO);

    // Act
    const response = await fresh.call(
      BOARD,
      F1,
      { action: 'resolve', id: 'A1', gate: true, response: { kind: 'other', answer: 'words' } },
      ownerStanding('ui'),
    );

    // Assert
    expect(response.status).toBe(400);
    expect(response.json()).toMatchObject({ error: 'A1 is answered with one of its options' });
  });

  it('should refuse an answer to an ask the item no longer carries', async () => {
    // Arrange
    const card = board();
    const half = await world(card.providers);

    // Act
    const missing = await half.call(
      BOARD,
      F1,
      { action: 'resolve', id: 'A9', gate: true, response: { kind: 'multiple-choice', choice: 'Done' } },
      ownerStanding('ui'),
    );
    const named = await choose(half, 'Done', { cardAsk: 'gate:F99:to-test:3' });

    // Assert
    expect(missing.status).toBe(409);
    expect(named.status).toBe(409);
    expect(named.json()).toMatchObject({ code: 'gate_moved_on' });
  });

  it('should refuse files for an answer that is not a Not good, from another ferret, and from this one', async () => {
    // Arrange
    const card = board();
    const half = await world(card.providers);
    const files = (from: string) => ({ from, ids: [`att_${'a'.repeat(64)}`] });

    // Act
    const forDone = await choose(half, 'Done', { attachments: files('f1') });
    const foreign = await choose(half, 'Not good', { note: 'broken', attachments: files('f2') });
    const own = await choose(half, 'Not good', { note: 'broken', attachments: files('f1') });

    // Assert
    expect(forDone.json()).toMatchObject({ error: 'only a Not good takes files, and A1 was answered otherwise' });
    expect(foreign.json()).toMatchObject({ error: 'the files for A1 must be uploaded to the session it is on' });
    expect(own.json()).toMatchObject({
      error: 'this daemon cannot carry files with an answer (update it: fy daemon update)',
    });
    expect([forDone.status, foreign.status, own.status]).toEqual([400, 400, 400]);
    expect(card.applied).toEqual([]);
  });

  it('should ask a device for its fleet grant before the card is touched', async () => {
    // Arrange
    const card = board();
    const half = await world(card.providers);

    // Act
    const response = await choose(half, 'Done', {}, deviceStanding('phone'), {
      governed: true,
      decide: () => ({ allowed: false, refusal: 'not-granted' }),
    });

    // Assert
    expect(response.status).toBe(403);
    expect(card.applied).toEqual([]);
  });
});

describe('what the card source is told is a card ask', () => {
  it('should be answered by plain words as the item’s own question, not as the card ask', async () => {
    // Arrange
    const card = board();
    const half = await world(card.providers);

    // Act
    const response = await half.call(
      BOARD,
      F1,
      { action: 'resolve', id: 'A1', response: { kind: 'open-question', answer: 'what is this?' } },
      ownerStanding('ui'),
    );

    // Assert
    expect(response.status).toBe(200);
    expect(card.applied).toEqual([]);
  });
});
