import { describe, expect, test } from 'bun:test';
import {
  isHandoffRead,
  markReplies,
  projectDeliveries,
  readSentMessage,
  shellCommandOf,
  simpleCommands,
} from '../../src/lib/peer-delivery.ts';
import type { ToolCall, TranscriptEntry } from '../../src/lib/session-screens.ts';

const TURN = '/home/kirin/.ferretry/state/sessions/s1/turns/turn-001.md';

const call = (name: string, input: unknown, result?: ToolCall['result'], key = 'k1'): ToolCall => ({
  key,
  use: { name, input },
  ...(result === undefined ? {} : { result }),
});
const bash = (command: string, result?: ToolCall['result']) => call('Bash', { command }, result);
const codex = (cmd: string, result?: ToolCall['result']) => call('exec_command', { cmd }, result);

describe('shellCommandOf', () => {
  test('reads Claude’s Bash, Codex’s exec_command and Codex’s shell array', () => {
    expect(shellCommandOf(bash('ls'))).toBe('ls');
    expect(shellCommandOf(codex('pwd'))).toBe('pwd');
    expect(shellCommandOf(call('shell', { command: ['bash', '-lc', 'fy ps'] }))).toBe('fy ps');
    expect(shellCommandOf(call('local_shell', { command: ['git', 'status'] }))).toBe('git status');
  });

  test('reads nothing from any other call or shape', () => {
    expect(shellCommandOf(call('Read', { file_path: TURN }))).toBeUndefined();
    expect(shellCommandOf(call('Bash', 'ls'))).toBeUndefined();
    expect(shellCommandOf(call('Bash', { command: 3 }))).toBeUndefined();
    expect(shellCommandOf(call('exec_command', { cmd: ['x'] }))).toBeUndefined();
    expect(shellCommandOf(call('shell', { command: 'ls' }))).toBeUndefined();
    expect(shellCommandOf(call('shell', { command: [1] }))).toBeUndefined();
    expect(shellCommandOf({ use: { name: undefined as unknown as string, input: { command: 'ls' } } })).toBeUndefined();
  });
});

const SCREENSHOT = 'Hello from home-manager-fd (the user asked me to say hi).';
const argv = (script: string): (readonly string[])[] =>
  simpleCommands(script).map(words => words.map(word => word.text));

describe('shell redirections are not arguments', () => {
  test('the "Sent to" card does not end in a stray 2>', () => {
    expect(readSentMessage(bash(`fy send tanna "${SCREENSHOT}" 2>&1`), 'fy')).toMatchObject({
      to: 'tanna',
      body: SCREENSHOT,
    });
  });

  const REAL_WORLD: readonly (readonly [string, string, string[][]])[] = [
    ['stderr into stdout', `fy send tanna "${SCREENSHOT}" 2>&1`, [['fy', 'send', 'tanna', SCREENSHOT]]],
    ['both to /dev/null', 'fy send tanna hi >/dev/null 2>&1', [['fy', 'send', 'tanna', 'hi']]],
    ['spaced target', 'fy send tanna hi > /dev/null 2> /tmp/err.log', [['fy', 'send', 'tanna', 'hi']]],
    [
      'pipe to tee',
      'fy send tanna hi 2>&1 | tee /tmp/out',
      [
        ['fy', 'send', 'tanna', 'hi'],
        ['tee', '/tmp/out'],
      ],
    ],
    [
      'and then echo',
      'fy send tanna hi 2>&1 && echo sent',
      [
        ['fy', 'send', 'tanna', 'hi'],
        ['echo', 'sent'],
      ],
    ],
    ['append', 'fy send tanna hi >> /tmp/log 2>>/tmp/err', [['fy', 'send', 'tanna', 'hi']]],
    [
      'clobber and both-streams',
      'fy send tanna hi >| out; fy send tanna ho &> all &>> more',
      [
        ['fy', 'send', 'tanna', 'hi'],
        ['fy', 'send', 'tanna', 'ho'],
      ],
    ],
    ['stdin from a file', 'fy send tanna hi < in.txt', [['fy', 'send', 'tanna', 'hi']]],
    ['here-string is not argv', 'fy send tanna hi <<< "not a word"', [['fy', 'send', 'tanna', 'hi']]],
    ['dup and close', 'fy send tanna hi 2>&- >&2 <&3 3<&0 2>&1-', [['fy', 'send', 'tanna', 'hi']]],
    ['quoted target', 'fy send tanna hi > "/tmp/my out" 2>\'/tmp/e r\'', [['fy', 'send', 'tanna', 'hi']]],
    ['read-write and fd target', 'fy send tanna hi <> rw 5<in', [['fy', 'send', 'tanna', 'hi']]],
    ['redirect glued to the word', 'fy send tanna hi>out', [['fy', 'send', 'tanna', 'hi']]],
    ['redirect before the command', '>/dev/null fy send tanna hi', [['fy', 'send', 'tanna', 'hi']]],
    ['>& with a file', 'fy send tanna hi >&out.log', [['fy', 'send', 'tanna', 'hi']]],
    ['a digit apart from the operator is an argument', 'fy send tanna 2 > out', [['fy', 'send', 'tanna', '2']]],
    ['a quoted digit is an argument', 'fy send tanna "2">out', [['fy', 'send', 'tanna', '2']]],
    ['an escaped operator is text', 'fy send tanna a\\>b', [['fy', 'send', 'tanna', 'a>b']]],
    ['an operator in quotes is text', 'fy send tanna "a > b 2>&1"', [['fy', 'send', 'tanna', 'a > b 2>&1']]],
    [
      'a dangling redirect',
      'fy send tanna hi >; echo done',
      [
        ['fy', 'send', 'tanna', 'hi'],
        ['echo', 'done'],
      ],
    ],
  ];
  for (const [name, script, expected] of REAL_WORLD) {
    test(name, () => {
      expect(argv(script)).toEqual(expected);
    });
  }

  test('a heredoc after the command is dropped with its body', () => {
    expect(argv('fy send tanna hi <<EOF\nfy send zed boom\nEOF\necho after')).toEqual([
      ['fy', 'send', 'tanna', 'hi'],
      ['echo', 'after'],
    ]);
    expect(argv("cat <<-'END' > out\n\tline\n\tEND\nls")).toEqual([['cat'], ['ls']]);
    expect(argv('cat <<A <<B\none\nA\ntwo\nB\nls')).toEqual([['cat'], ['ls']]);
    expect(argv('cat <<EOF\nnever closed\n')).toEqual([['cat']]);
  });

  test('a send with a heredoc substitution and a redirect keeps exactly its body', () => {
    const script = `fy send tanna "$(cat <<'EOF'\nline one\nline two\nEOF\n)" > /dev/null 2>&1`;
    expect(readSentMessage(bash(script), 'fy')?.body).toBe('line one\nline two');
  });

  test('--ask and a message file survive a redirect', () => {
    expect(readSentMessage(bash('fy send tanna --ask --until 5m ok 2>&1'), 'fy')).toMatchObject({
      body: 'ok',
      ask: true,
    });
    expect(readSentMessage(bash('fy send tanna --message-file /tmp/b.md 2>&1'), 'fy')).toMatchObject({
      body: null,
      messageFile: '/tmp/b.md',
    });
  });

  test('a redirected single read is still not the hand-off read', () => {
    expect(isHandoffRead(bash(`cat ${TURN} 2>&1`), TURN)).toBe(false);
  });
});

describe('readSentMessage', () => {
  test('reads a Claude send: recipient, quoted body and delivery', () => {
    expect(
      readSentMessage(bash('fy send tanna "Hello \\"there\\" — costs \\$5"', { text: 'delivered\n…' }), 'fy'),
    ).toEqual({
      to: 'tanna',
      body: 'Hello "there" — costs $5',
      ask: false,
      state: 'delivered',
    });
    // Unescaped `$5` inside double quotes is an expansion this reader does not run.
    expect(readSentMessage(bash('fy send tanna "cost $5"'), 'fy')?.body).toBeNull();
  });

  test('reads a Codex send, a single-quoted body, a reply, and a send behind cd or direnv', () => {
    expect(
      readSentMessage(
        codex("fy reply tomi 'all green'", { text: 'Process exited with code 0\nOutput:\ndelivered' }),
        'fy',
      ),
    ).toMatchObject({ to: 'tomi', body: 'all green', state: 'delivered' });
    expect(
      readSentMessage(call('shell', { command: ['bash', '-lc', 'cd /repo && fy send tomi hi there'] }), 'fy'),
    ).toMatchObject({ to: 'tomi', body: 'hi there', state: 'sending' });
    expect(readSentMessage(bash('direnv exec . fy send tomi ok'), 'fy')).toMatchObject({ to: 'tomi', body: 'ok' });
    expect(readSentMessage(bash('/usr/local/bin/fy send tomi ok'), 'fy')?.to).toBe('tomi');
  });

  test('reads a heredoc body, flags, a message file and a backslash-continued line', () => {
    const heredoc = `fy send tanna --ask --until 30m "$(cat <<'EOF'\nline one\n\nline "two"\nEOF\n)"`;
    expect(readSentMessage(bash(heredoc), 'fy')).toMatchObject({
      to: 'tanna',
      body: 'line one\n\nline "two"',
      ask: true,
    });
    expect(readSentMessage(bash(`fy send tanna "$(cat <<EOF\nbare tag\nEOF\n)"`), 'fy')?.body).toBe('bare tag');
    expect(readSentMessage(bash('fy send tanna --message-file /tmp/brief.md'), 'fy')).toEqual({
      to: 'tanna',
      body: null,
      messageFile: '/tmp/brief.md',
      ask: false,
      state: 'sending',
    });
    expect(readSentMessage(bash('fy send tanna -f a.png --now --wait look \\\n  here'), 'fy')?.body).toBe('look here');
    expect(readSentMessage(bash('fy send tanna look\\ here'), 'fy')?.body).toBe('look here');
    expect(readSentMessage(bash('fy send tanna "two"" words"'), 'fy')?.body).toBe('two words');
  });

  test('says where the send got to, and why it failed', () => {
    expect(readSentMessage(bash('fy send a b', { text: "queued in the agent's own queue" }), 'fy')?.state).toBe(
      'queued',
    );
    expect(readSentMessage(bash('fy send a b', { text: 'revived the session with the message' }), 'fy')?.state).toBe(
      'delivered',
    );
    expect(
      readSentMessage(bash('fy send a b', { text: 'error: session not found: a', isError: true }), 'fy'),
    ).toMatchObject({
      state: 'failed',
      reason: 'session not found: a',
    });
    expect(
      readSentMessage(
        codex('fy send a b', { text: 'Process exited with code 1\nOutput:\n\nnot delivered (not delivered)\n' }),
        'fy',
      ),
    ).toMatchObject({ state: 'failed', reason: 'not delivered (not delivered)' });
    expect(readSentMessage(bash('fy send a b', { isError: true }), 'fy')).toMatchObject({
      state: 'failed',
      reason: '',
    });
  });

  test('is not fooled by a command that only mentions a send', () => {
    expect(readSentMessage(bash('echo "fy send tanna hi"'), 'fy')).toBeNull();
    expect(readSentMessage(bash('fy ps'), 'fy')).toBeNull();
    expect(readSentMessage(bash('fy send'), 'fy')).toBeNull();
    expect(readSentMessage(bash('fy send --ask tanna'), 'fy')).toBeNull();
    expect(readSentMessage(bash('fy send "$WHO" hi'), 'fy')).toBeNull();
    expect(readSentMessage(bash('sudo fy send tanna hi'), 'fy')).toBeNull();
    expect(readSentMessage(bash('fy send tanna "unterminated'), 'fy')).toBeNull();
    expect(readSentMessage(bash("fy send tanna 'unterminated"), 'fy')).toBeNull();
    expect(readSentMessage(bash('ls'), 'fy')).toBeNull();
    expect(readSentMessage(call('Read', { file_path: 'fy' }), 'fy')).toBeNull();
    // A second command after a send that is not one is still found; the first send wins.
    expect(readSentMessage(bash('fy ps; fy send a one; fy send b two'), 'fy')?.to).toBe('a');
  });

  test('marks a body built from any other expansion as unseen', () => {
    expect(readSentMessage(bash('fy send tanna `date`'), 'fy')?.body).toBeNull();
    expect(readSentMessage(bash('fy send tanna "now: `date`"'), 'fy')?.body).toBeNull();
  });
});

describe('isHandoffRead', () => {
  test('recognises Claude’s Read and Codex’s one-command reads of exactly that file', () => {
    expect(isHandoffRead(call('Read', { file_path: TURN }), TURN)).toBe(true);
    expect(isHandoffRead(call('read', { path: TURN }), TURN)).toBe(true);
    expect(isHandoffRead(codex(`cat ${TURN}`), TURN)).toBe(true);
    expect(isHandoffRead(codex(`sed -n '1,200p' '${TURN}'`), TURN)).toBe(true);
  });

  test('leaves every other read, and anything more than a read, alone', () => {
    expect(isHandoffRead(call('Read', { file_path: '/elsewhere.md' }), TURN)).toBe(false);
    expect(isHandoffRead(call('Read', null), TURN)).toBe(false);
    expect(isHandoffRead(codex(`cat ${TURN} | head`), TURN)).toBe(false);
    expect(isHandoffRead(codex(`rm ${TURN}`), TURN)).toBe(false);
    expect(isHandoffRead(codex(`cat ${TURN}\ncat ${TURN}`), TURN)).toBe(false);
    expect(isHandoffRead(codex(''), TURN)).toBe(false);
    expect(isHandoffRead(call('Write', { file_path: TURN }), TURN)).toBe(false);
  });
});

const handoffEntry: TranscriptEntry = {
  id: 'u1',
  kind: 'user',
  text: 'pointer',
  handoff: { kind: 'turn', name: 'turn-001', turn: 1, path: TURN },
};
const tools = (id: string, calls: ToolCall[]): TranscriptEntry => ({ id, kind: 'tool', text: 'ran', tools: calls });

describe('projectDeliveries', () => {
  test('drops the receiver’s successful read of its hand-off, and the group it emptied', () => {
    const read = call('Read', { file_path: TURN }, { text: 'contents' });
    const out = projectDeliveries([handoffEntry, tools('t1', [read])], 'fy');
    expect(out.map(entry => entry.id)).toEqual(['u1']);
  });

  test('keeps a FAILED read, and a second read of the same file', () => {
    const failed = call('Read', { file_path: TURN }, { text: 'denied', isError: true });
    expect(projectDeliveries([handoffEntry, tools('t1', [failed])], 'fy')[1]?.tools).toEqual([failed]);
    const first = call('Read', { file_path: TURN }, { text: 'ok' }, 'a');
    const again = call('Read', { file_path: TURN }, { text: 'ok' }, 'b');
    const out = projectDeliveries([handoffEntry, tools('t1', [first]), tools('t2', [again])], 'fy');
    expect(out.map(entry => entry.id)).toEqual(['u1', 't2']);
  });

  test('looks for a read only after a hand-off', () => {
    const read = call('Read', { file_path: TURN }, { text: 'ok' });
    const human: TranscriptEntry = { id: 'h', kind: 'user', text: 'hi' };
    expect(projectDeliveries([human, tools('t1', [read])], 'fy')).toHaveLength(2);
  });

  test('lifts a send out of its group into a row of its own, between the calls around it', () => {
    const before = call('Read', { file_path: '/a' }, { text: 'a' }, 'b1');
    const send = { ...bash('fy send tanna hi', { text: 'delivered' }), key: 's1', ts: '2026-10-18T02:00:00.000Z' };
    const after = call('Grep', { pattern: 'x' }, { text: '' }, 'a1');
    const untimed = { ...bash('fy send tomi yo'), key: 's2' };
    const out = projectDeliveries([tools('t1', [before, send, after, untimed])], 'fy');
    expect(out.map(entry => entry.id)).toEqual(['t1', 'sent:s1', 't1:a1', 'sent:s2']);
    expect(out[1]).toMatchObject({ kind: 'tool', text: 'sent to tanna', at: Date.parse('2026-10-18T02:00:00.000Z') });
    expect(out[1]?.sent).toMatchObject({ to: 'tanna', body: 'hi', state: 'delivered' });
    expect(out[3]?.at).toBeUndefined();
    expect(out[0]?.text).toBe('ran a tool');
    const many = projectDeliveries([tools('t1', [before, after])], 'fy');
    expect(many[0]?.text).toBe('ran 2 tools');
  });

  test('passes every other row through untouched', () => {
    const assistant: TranscriptEntry = { id: 'a', kind: 'assistant', text: 'hi' };
    const bare: TranscriptEntry = { id: 't', kind: 'tool', text: 'ran a tool' };
    expect(projectDeliveries([assistant, bare], 'fy')).toEqual([assistant, bare]);
  });
});

describe('markReplies', () => {
  const sent = (to: string, state: 'delivered' | 'failed' = 'delivered'): TranscriptEntry => ({
    id: `sent:${to}`,
    kind: 'tool',
    text: '',
    sent: { to, body: 'q', ask: false, state },
  });

  test('marks a send replied once a later message comes from its recipient, by any of its names', () => {
    const byPeer: TranscriptEntry = {
      id: 'p',
      kind: 'user',
      text: 'a',
      peer: { name: 'tanna', kind: 'reply', replyExpected: false, note: '' },
    };
    const bySend: TranscriptEntry = {
      id: 'h',
      kind: 'user',
      text: 'pointer',
      send: {
        sendId: 's',
        acceptedAt: '2026-10-18T02:00:00.000Z',
        message: 'x',
        attachmentIds: [],
        fate: 'delivered',
        from: 'id-tomi',
      },
    };
    const out = markReplies([sent('tanna'), sent('id-tomi'), sent('nobody'), byPeer, bySend, sent('tanna')]);
    expect(out.map(entry => entry.sent?.state)).toEqual([
      'replied',
      'replied',
      'delivered',
      undefined,
      undefined,
      'delivered',
    ]);
  });

  test('never calls a failed send replied', () => {
    const later: TranscriptEntry = {
      id: 'p',
      kind: 'user',
      text: 'a',
      peer: { name: 'tanna', kind: 'message', replyExpected: false, note: '' },
    };
    expect(markReplies([sent('tanna', 'failed'), later])[0]?.sent?.state).toBe('failed');
  });
});
