import { describe, expect, test } from 'bun:test';
import { aboveComposerProps, needsInputOf, sendAcceptances } from '../../../../app/chat/above-composer-props.ts';
import { type ChatSession, unreadChatSession } from '../../../../app/chat/chat-session.ts';
import type { LedgerSendRecord } from '../../../../app/chat/send-ledger.ts';
import type { TranscriptEntry } from '../../../../app/chat/transcript-entries.ts';

/**
 * WHAT THE ABOVE-COMPOSER SLOT IS HANDED: rows, the turn, what parks it on the person, and the send ledger's ids. The
 * privacy rule is the point: a field the builder does not name never leaves it.
 */

const SECRET = 'sk-live-pasted-secret';

const session = (state: Record<string, unknown> = {}): ChatSession =>
  ({ config: { id: 'shared' }, state: { status: 'running', ...state } }) as unknown as ChatSession;

const QUESTION = {
  toolUseId: 'ask-1',
  questions: [
    { question: 'Ship it?', options: [{ label: 'Yes', description: SECRET }, { label: 'No' }], multiSelect: false },
    { question: 'Free text?' },
  ],
};

const PERMISSION = {
  id: 'abcdef0123456789',
  harness: 'claude',
  tool: 'Bash',
  action: 'run',
  what: `cat ${SECRET}`,
  detail: SECRET,
  question: 'Do you want to run this?',
  options: [
    { number: 1, label: 'Yes', kind: 'allow' },
    { number: 2, label: 'No', kind: 'deny' },
  ],
  selected: 1,
};

const DIALOG = {
  id: 'dialog-1',
  harness: 'claude',
  kind: 'hooks',
  title: 'Review hooks',
  body: SECRET,
  options: [{ number: 1, label: 'Trust', detail: SECRET, grantsTrust: true }],
  selected: 1,
};

describe('needsInputOf', () => {
  test('a ferret stopped on nothing offers nothing', () => {
    expect(needsInputOf(session(), null, false)).toEqual({});
  });

  test('an ended ferret is stopped on nothing, whatever its state still says', () => {
    const ended = session({ status: 'completed', permissionRequest: PERMISSION, turnPrompt: 'Sign in' });
    expect(needsInputOf(ended, QUESTION, true)).toEqual({});
  });

  test('the question is offered as its words and choices only', () => {
    const offered = needsInputOf(session(), QUESTION, false);
    expect(offered).toEqual({
      question: {
        questions: [
          { question: 'Ship it?', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] },
          { question: 'Free text?' },
        ],
      },
    });
    expect(JSON.stringify(offered)).not.toContain(SECRET);
    expect(JSON.stringify(offered)).not.toContain('toolUseId');
  });

  test('a permission prompt is its tool, question and choices, never the command it is about', () => {
    const offered = needsInputOf(session({ permissionRequest: PERMISSION }), null, false);
    expect(offered).toEqual({
      permissionRequest: {
        tool: 'Bash',
        question: 'Do you want to run this?',
        options: [{ label: 'Yes' }, { label: 'No' }],
      },
    });
    expect(JSON.stringify(offered)).not.toContain(SECRET);
  });

  test('a harness dialog is its title and choices alone, and is never beside a permission prompt', () => {
    expect(needsInputOf(session({ harnessDialog: DIALOG }), null, false)).toEqual({
      harnessDialog: { title: 'Review hooks', options: [{ label: 'Trust' }] },
    });
    const both = needsInputOf(session({ harnessDialog: DIALOG, permissionRequest: PERMISSION }), null, false);
    expect(both.harnessDialog).toBeUndefined();
    expect(both.permissionRequest?.tool).toBe('Bash');
  });

  test('the daemon’s one-line reason rides along', () => {
    expect(needsInputOf(session({ turnPrompt: 'Sign in again' }), null, false)).toEqual({
      turnPrompt: 'Sign in again',
    });
  });
});

describe('sendAcceptances', () => {
  const send = (sendId: string, acceptedAt: string): LedgerSendRecord =>
    ({ sendId, acceptedAt, message: SECRET, attachmentIds: ['a'], fate: 'delivered' }) as unknown as LedgerSendRecord;

  test('offers only the id and the daemon’s acceptance instant, oldest accepted first', () => {
    const offered = sendAcceptances([
      send('late', '2026-11-04T12:00:00.000Z'),
      send('early', '2026-11-04T11:00:00.000Z'),
      send('same', '2026-11-04T12:00:00.000Z'),
    ]);
    expect(offered).toEqual([
      { sendId: 'early', acceptedAt: '2026-11-04T11:00:00.000Z' },
      { sendId: 'late', acceptedAt: '2026-11-04T12:00:00.000Z' },
      { sendId: 'same', acceptedAt: '2026-11-04T12:00:00.000Z' },
    ]);
    expect(JSON.stringify(offered)).not.toContain(SECRET);
  });

  test('an empty ledger offers none', () => {
    expect(sendAcceptances([])).toEqual([]);
  });
});

describe('aboveComposerProps', () => {
  const entries = [
    { id: 'u1', kind: 'user', text: 'hello', send: { sendId: 's1', message: SECRET } },
    { id: 'a1', kind: 'assistant', text: 'hi there' },
    { id: 'send:x', kind: 'ledger', text: SECRET, ledger: { sendId: 'x' } },
  ] as unknown as TranscriptEntry[];

  test('hands the rows, the dated turn, what the ferret waits on and the sends; a device-only row is left out', () => {
    const props = aboveComposerProps({
      session: session({ turnState: 'needs-input', turnStateAt: '2026-11-04T11:30:00.000Z', turnPrompt: 'Sign in' }),
      entries,
      sends: [{ sendId: 's1', acceptedAt: '2026-11-04T11:00:00.000Z', message: SECRET } as unknown as LedgerSendRecord],
      question: null,
      ended: false,
      live: true,
    });
    expect(props).toEqual({
      rows: [
        { id: 'u1', kind: 'user', text: 'hello', send: { sendId: 's1' } },
        { id: 'a1', kind: 'assistant', text: 'hi there' },
      ],
      turn: { state: 'needs-input', at: '2026-11-04T11:30:00.000Z', live: true },
      needsInput: { turnPrompt: 'Sign in' },
      sends: [{ sendId: 's1', acceptedAt: '2026-11-04T11:00:00.000Z' }],
    });
    expect(JSON.stringify(props)).not.toContain(SECRET);
  });

  test('a ferret whose daemon names no turn has a null state and no instant', () => {
    const props = aboveComposerProps({
      session: session(),
      entries: [],
      sends: [],
      question: null,
      ended: false,
      live: true,
    });
    expect(props.turn).toEqual({ state: null, live: true });
  });

  test('`live` is exactly what the caller proved, never inferred from the session', () => {
    const base = { entries: [], sends: [], question: null, ended: false } as const;
    expect(aboveComposerProps({ ...base, session: unreadChatSession('shared'), live: false }).turn.live).toBe(false);
    expect(aboveComposerProps({ ...base, session: session({ turnState: 'working' }), live: false }).turn.live).toBe(
      false,
    );
    expect(aboveComposerProps({ ...base, session: session({ turnState: 'working' }), live: true }).turn.live).toBe(
      true,
    );
  });
});
