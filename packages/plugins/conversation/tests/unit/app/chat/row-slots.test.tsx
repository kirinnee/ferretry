import { afterEach, describe, expect, test } from 'bun:test';
import { PanelSlot } from '@ferretry/app';
import { ensureDom, render, run } from '@ferretry/app/testing';
import { RowSlot, RowSlotProvider, rowSlotEntry } from '../../../../app/chat/row-slots.tsx';
import type { TranscriptEntry } from '../../../../app/chat/transcript-entries.ts';
import {
  CONVERSATION_ROW_ACTIONS_SLOT,
  CONVERSATION_ROW_SLOT,
  ROW_TOOL_TEXT_LIMIT,
} from '../../../../contract/index.ts';

ensureDom();

/**
 * THE SLOTS' PRIVACY RULE: a plugin that contributes to a Conversation slot sees ONLY the promised row fields, built from
 * what the daemon read (and masked), and never a row that exists only on this device.
 */

const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
  for (const page of mounted.splice(0)) run(() => page.unmount());
});

const SECRET = 'sk-live-pasted-secret';

/** A send the machine refused: it stays in this device's outbox, so its text is what was typed, unmasked. */
const refusedSend = {
  id: 'send:refused-1',
  kind: 'ledger',
  text: `here is my key ${SECRET}`,
  at: 100,
  label: 'You',
  ledger: {
    sendId: 'refused-1',
    acceptedAt: '2026-11-04T11:00:00.000Z',
    message: `here is my key ${SECRET}`,
    attachmentIds: [],
    fate: 'refused',
    outbox: { phase: 'refused' },
  },
  placement: 'chronological',
} as unknown as TranscriptEntry;

/** A row with fields beyond the promised ones, as a delivered user row of the daemon's log is. */
const delivered = {
  id: 'row-1',
  kind: 'user',
  text: 'a daemon-read message',
  at: 200,
  label: 'You',
  send: { sendId: 'delivered-1', message: SECRET, attachmentIds: [] },
  peer: { name: 'another-ferret' },
  tools: [],
} as unknown as TranscriptEntry;

const draw = (entry: TranscriptEntry, slot: 'conversation.row' | 'conversation.row-actions') => {
  const page = render(
    <RowSlotProvider daemon="alpha" ferret="shared">
      <RowSlot entry={entry} slot={slot} />
    </RowSlotProvider>,
  );
  mounted.push(page);
  return page;
};

describe('the transcript row slots', () => {
  test('a refused send in the device outbox reaches no conversation.row panel', () => {
    expect(draw(refusedSend, CONVERSATION_ROW_SLOT).root.findAllByType(PanelSlot)).toHaveLength(0);
  });

  test('a refused send in the device outbox reaches no conversation.row-actions panel', () => {
    expect(draw(refusedSend, CONVERSATION_ROW_ACTIONS_SLOT).root.findAllByType(PanelSlot)).toHaveLength(0);
  });

  test.each([
    ['conversation.row', CONVERSATION_ROW_SLOT],
    ['conversation.row-actions', CONVERSATION_ROW_ACTIONS_SLOT],
  ] as const)('%s props carry only the promised fields, and the ferret as the subject', (_name, slot) => {
    const [offered] = draw(delivered, slot).root.findAllByType(PanelSlot);
    expect(offered?.props.slot).toBe(slot);
    expect(offered?.props.subject).toBe('shared');
    expect(offered?.props.props).toEqual({
      entry: { id: 'row-1', kind: 'user', text: 'a daemon-read message', at: 200, label: 'You' },
    });
    expect(JSON.stringify(offered?.props.props)).not.toContain(SECRET);
  });

  test('a row with no time or label offers neither key', () => {
    expect(rowSlotEntry({ id: 'a', kind: 'assistant', text: 'hi' })).toEqual({
      id: 'a',
      kind: 'assistant',
      text: 'hi',
    });
  });

  test('every row that came from the daemon is offered, and only a device-local ledger row is not', () => {
    for (const kind of ['user', 'assistant', 'tool', 'command', 'notice', 'system'] as const) {
      expect(rowSlotEntry({ id: kind, kind, text: 't' })?.kind).toBe(kind);
    }
    expect(rowSlotEntry(refusedSend)).toBeNull();
  });

  test('outside a chat that said which ferret it draws, the slots draw nothing', () => {
    const page = render(<RowSlot entry={delivered} slot={CONVERSATION_ROW_SLOT} />);
    mounted.push(page);
    expect(page.root.findAllByType(PanelSlot)).toHaveLength(0);
  });
});

describe('the shell commands a tool row offers a slot', () => {
  const shellRow = (calls: NonNullable<TranscriptEntry['tools']>, more: object = {}): TranscriptEntry =>
    ({ id: 'tools:1', kind: 'tool', text: 'ran a tool', tools: calls, ...more }) as unknown as TranscriptEntry;

  test('a Bash call is offered as its command and the text of its answer, and nothing else of the call', () => {
    const offered = rowSlotEntry(
      shellRow([
        {
          key: 'k1',
          ts: '2026-11-04T11:00:00.000Z',
          use: { name: 'Bash', toolUseId: 'use-1', input: { command: 'fy new --auto "go"', description: 'extra' } },
          result: { text: 'Started nadia', isError: false, images: [{ handle: 'h' }] },
        },
      ] as never),
    );
    expect(offered?.tools).toEqual([
      {
        key: 'k1',
        name: 'Bash',
        command: 'fy new --auto "go"',
        ts: '2026-11-04T11:00:00.000Z',
        result: { text: 'Started nadia' },
      },
    ]);
  });

  test('a Codex shell call is offered as the script it ran; a failed answer says so', () => {
    const offered = rowSlotEntry(
      shellRow([
        {
          key: 'k2',
          use: { name: 'shell', input: { command: ['bash', '-lc', 'fy wait nadia'] } },
          result: { content: 'Process exited with code 1', isError: true },
        },
      ] as never),
    );
    expect(offered?.tools).toEqual([
      {
        key: 'k2',
        name: 'shell',
        command: 'fy wait nadia',
        result: { text: 'Process exited with code 1', isError: true },
      },
    ]);
  });

  test('another tool’s input never reaches a slot, and a row with no shell call has no tools key', () => {
    const offered = rowSlotEntry(
      shellRow([
        { key: 'w', use: { name: 'Write', input: { file_path: '/a', content: SECRET } }, result: { text: SECRET } },
        { key: 'r', use: { name: 'Read', input: { file_path: '/b' } } },
        { key: 'o', use: { name: 'Bash', input: {} }, orphanResult: true },
        { key: 'n', use: { name: 'Bash', input: { command: 42 } } },
      ] as never),
    );
    expect(offered).toEqual({ id: 'tools:1', kind: 'tool', text: 'ran a tool' });
    expect(JSON.stringify(offered)).not.toContain(SECRET);
  });

  test('a plain shell command and what it printed never reach a slot; a command that runs fy does', () => {
    const offered = rowSlotEntry(
      shellRow([
        { key: 'a', use: { name: 'Bash', input: { command: 'ls ~/.ssh && cat id_rsa' } }, result: { text: SECRET } },
        { key: 'b', use: { name: 'Bash', input: { command: 'env' } }, result: { text: `TOKEN=${SECRET}` } },
        { key: 'c', use: { name: 'Bash', input: { command: `echo "fy new" ${SECRET}` } }, result: { text: SECRET } },
        {
          key: 'd',
          use: { name: 'shell', input: { command: ['bash', '-lc', 'cat .env.local'] } },
          result: { text: SECRET },
        },
        {
          key: 'e',
          use: { name: 'Bash', input: { command: 'direnv exec . fy new --auto "go"' } },
          result: { text: 'Started nadia' },
        },
        {
          key: 'f',
          use: { name: 'exec_command', input: { cmd: '/usr/local/bin/fy wait nadia' } },
          result: { text: 'done' },
        },
      ] as never),
    );
    expect(offered?.tools?.map(call => call.key)).toEqual(['e', 'f']);
    expect(JSON.stringify(offered)).not.toContain(SECRET);
  });

  const HEREDOC_BRIEF = 'fy new --auto "$(cat <<\'EOF\'\nthe brief\nEOF\n)"';

  /** Whether a shell call with this script reaches a slot, with its output (which would carry the secret). */
  const offeredCommand = (call: Record<string, unknown>): boolean => {
    const offered = rowSlotEntry(shellRow([{ key: 'k', result: { text: SECRET }, ...call }] as never));
    if (offered?.tools === undefined) expect(JSON.stringify(offered)).not.toContain(SECRET);
    return offered?.tools !== undefined;
  };
  const bash = (command: string) => ({ use: { name: 'Bash', input: { command } } });

  test.each([
    'fy status; cat ~/.ssh/id_rsa',
    'cat .env.local; fy status',
    'cat .env.local && fy status',
    'fy status || cat .env.local',
    'fy status\ncat .env.local',
    'cat secret & fy status',
    'fy status &',
    'fy status;',
    '(cat secret); fy status',
    '(fy status)',
    '{ cat secret; }; fy status',
    '{ fy status; }',
    'fy status | cat - .env.local',
    'cat .env.local | fy send x -',
    'fy status | xargs cat',
    'direnv exec . fy status && cat secret',
    'cd /repo && direnv exec . fy new "go"',
    'fy wait x 2>&1 | tail -20',
    'fy status > out.txt',
    'fy status 2>&1',
    'fy send x < .env.local',
    'fy $(cat k)',
    'fy $' + '{HOME}',
    'fy $HOME',
    'fy `cat k`',
    'fy status "$(cat k)"',
    'fy status "`cat k`"',
    'fy status \\\ncat k',
    'fy new "$(cat <<EOF\n$(cat ~/.ssh/id_rsa)\nEOF\n)"',
    'fy new "$(cat <<\'EOF\'\nbrief\nEOF\ncat ~/.ssh/id_rsa\nEOF\n)"',
    "fy new \"$(cat <<'EOF'\nbrief\nEOF\n); cat ~/.ssh/id_rsa",
    'FOO=1 fy status',
    'fyx status',
    "sh -c 'fy status'",
    'eval fy status',
    "fy 'unterminated",
    '',
  ])('a script that is not exactly one plain fy command is never offered: %j', script => {
    expect(offeredCommand(bash(script))).toBe(false);
  });

  test('a compound script is not offered whichever shell tool carries it', () => {
    expect(offeredCommand({ use: { name: 'shell', input: { command: ['bash', '-lc', 'cat x; fy status'] } } })).toBe(
      false,
    );
    expect(offeredCommand({ use: { name: 'local_shell', input: { command: ['fy', 'status;', 'cat', 'x'] } } })).toBe(
      false,
    );
    expect(offeredCommand({ use: { name: 'exec_command', input: { cmd: 'cat secret; fy status' } } })).toBe(false);
  });

  test.each([
    'fy status',
    'direnv exec . fy new --auto "go"',
    '/usr/local/bin/fy wait nadia',
    "fy send x 'a; b | c'",
    'fy send x "a; b | c & d"',
    HEREDOC_BRIEF,
    'direnv exec . ' + HEREDOC_BRIEF,
    '  fy status  ',
  ])('a script that is exactly one plain fy command is offered: %j', script => {
    expect(offeredCommand(bash(script))).toBe(true);
  });

  test('a one-command Codex script is offered', () => {
    expect(offeredCommand({ use: { name: 'shell', input: { command: ['bash', '-lc', 'fy status'] } } })).toBe(true);
    expect(offeredCommand({ use: { name: 'exec_command', input: { cmd: 'fy status' } } })).toBe(true);
  });

  test('a row whose only shell commands are not fy has no tools key', () => {
    const offered = rowSlotEntry(
      shellRow([
        { key: 'a', use: { name: 'Bash', input: { command: 'cat .env' } }, result: { text: SECRET } },
      ] as never),
    );
    expect(offered).toEqual({ id: 'tools:1', kind: 'tool', text: 'ran a tool' });
  });

  test('a send a ferret made offers no tools, and no other row kind does either', () => {
    const call = { key: 'k', use: { name: 'Bash', input: { command: `fy send x "${SECRET}"` } } };
    expect(rowSlotEntry(shellRow([call] as never, { sent: { to: 'x' } }))?.tools).toBeUndefined();
    expect(rowSlotEntry({ id: 'a', kind: 'assistant', text: 't', tools: [call] } as never)?.tools).toBeUndefined();
  });

  test('an answer longer than the limit is cut', () => {
    const offered = rowSlotEntry(
      shellRow([
        {
          key: 'k',
          use: { name: 'Bash', input: { command: 'fy wait x' } },
          result: { text: 'a'.repeat(ROW_TOOL_TEXT_LIMIT + 5) },
        },
      ] as never),
    );
    expect(offered?.tools?.[0]?.result?.text).toHaveLength(ROW_TOOL_TEXT_LIMIT);
  });

  test('the tools ride in the slot props for a delivered tool row', () => {
    const row = shellRow([{ key: 'k', use: { name: 'Bash', input: { command: 'fy new x' } } }] as never);
    const [slot] = draw(row, CONVERSATION_ROW_SLOT).root.findAllByType(PanelSlot);
    const offered = slot?.props.props as { entry?: { tools?: unknown[] } } | undefined;
    expect(offered?.entry?.tools).toEqual([{ key: 'k', name: 'Bash', command: 'fy new x' }]);
  });
});
