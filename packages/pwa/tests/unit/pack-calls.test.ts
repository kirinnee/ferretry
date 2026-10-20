import { describe, expect, test } from 'bun:test';
import type { PackNewOutcome, PackRecommendation, SessionView } from '@ferretry/protocol';
import { type PackStartCall, projectPackCalls, readPackCall } from '../../src/lib/pack-calls.ts';
import type { ToolCall, TranscriptEntry } from '../../src/lib/session-screens.ts';

const call = (name: string, input: unknown, result?: ToolCall['result'], key = 'k1'): ToolCall => ({
  key,
  use: { name, input },
  ...(result === undefined ? {} : { result }),
});
const bash = (command: string, result?: ToolCall['result'], key?: string) => call('Bash', { command }, result, key);
const codex = (cmd: string, result?: ToolCall['result'], key?: string) => call('exec_command', { cmd }, result, key);

// What `packages/cli/src/lib/pack/render.ts` prints, captured from the renderer itself.
const STARTED = [
  'Started nadia (mvq1k2-7f3a) on claude-auto-work, claude-opus-5-5 — decided by you.',
  '  refused codex-auto-work gpt-6-astra (probe 0ms) — out_of_quota: codex-auto-work has used its quota',
  '  started claude-auto-work claude-opus-5-5 (probe 812ms)',
  'Wait for its result: fy wait mvq1k2-7f3a',
].join('\n');
const STARTED_BARE = [
  'Started mvq1k2-7f3a on claude-auto-work — decided by jev.',
  'Jev could not answer, so the guide decided.',
  '  started claude-auto-work (probe cached)',
  'Wait for its result: fy wait mvq1k2-7f3a',
].join('\n');
const REFUSED = [
  'fy new: refused (probe_failed): codex-auto-work did not answer a "reply OK" check on gpt-6-astra: timed out.',
  'Try the next candidate.',
  '',
  'Tried:',
  '  refused codex-auto-work gpt-6-astra (probe 45000ms) — probe_failed: codex-auto-work did not answer a "reply OK" check on gpt-6-astra: timed out.',
].join('\n');
const ADVICE = [
  "Use case: Hard planning, review and critical code (plan-review, from the task's words; the built-in guide)",
  '',
  '1. ready   Claude Opus 5.5 (claude-opus-5-5) on claude-auto-work · effort max',
  '   The strongest planner and reviewer.',
  '2. cannot  gpt-6-astra · effort high',
  '   A different family.',
  '   cli_missing: codex is not installed',
  '',
  'Start the first: fy new --runtime claude-auto-work --model claude-opus-5-5 --effort max "<brief>"',
].join('\n');

const BRIEF = 'Review packages/daemon/src/lib/pack for races.\n\nReport findings as a list.';
const NEW = `fy new --runtime claude-auto-work --model claude-opus-5-5 --effort high "$(cat <<'EOF'\n${BRIEF}\nEOF\n)"`;

const view = {
  config: {
    id: 'mvq1k2-7f3a',
    incarnation: 'incarnation-1',
    runtimeGeneration: 1,
    name: 'Review the pack service',
    teammate: 'nadia',
    parent: 'mvlead-0001',
    boardAccess: 'none',
    agent: 'claude-auto-work',
    harness: 'claude',
    modelHint: 'claude-opus-5-5',
    model: 'claude-opus-5-5',
    launchReasoningEffort: 'high',
    mode: 'auto',
    remoteControl: false,
    harnessFlags: [],
    cwd: '/work/ferretry',
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:01.000Z',
    turn: 0,
    intervalSeconds: 30,
    timeoutSeconds: 120,
    nudgeAfterSeconds: 180,
    killAfterSeconds: 300,
    directSendMaxChars: 4_096,
    resumeMenuChoice: 'full',
    maxSnapshots: 10,
    retry: { transientAttempts: 1, stalledAttempts: 0, waitForQuotaReset: true, allowAccountFailover: false },
  },
  state: { id: 'mvq1k2-7f3a', status: 'starting', turn: 0 },
  directory: '/state/mvq1k2-7f3a',
} satisfies SessionView;

const startedJson: PackNewOutcome = {
  outcome: 'started',
  view,
  decidedBy: 'guide',
  attempts: [{ runtime: 'claude-auto-work', model: 'claude-opus-5-5', outcome: 'started', probe: 'ran', probeMs: 640 }],
};
const refusedJson: PackNewOutcome = {
  outcome: 'refused',
  refusal: {
    code: 'limit_reached',
    message: 'mvlead-0001 has 4 running sub-ferrets.',
    remedy: 'Do the work yourself.',
  },
  attempts: [{ runtime: 'claude-auto-work', outcome: 'refused', probe: 'cached' }],
};
const adviceJson: PackRecommendation = {
  task: 'rename a helper',
  useCase: { id: 'bulk', title: 'Mechanical bulk edits', matchedBy: 'words' },
  guideSource: 'file',
  candidates: [
    {
      rank: 1,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      modelLabel: 'Haiku 4.5',
      effort: 'low',
      why: 'Cheap and quick.',
      runtime: 'claude-auto-work',
      ready: true,
    },
    {
      rank: 2,
      provider: 'zai',
      model: 'glm-5',
      why: 'Another family.',
      ready: false,
      refusal: { code: 'not_logged_in', message: 'zai-work needs signing in' },
    },
  ],
};

const startOf = (entry: TranscriptEntry | undefined): PackStartCall => {
  if (entry?.pack?.kind !== 'new') throw new Error('not a start card');
  return entry.pack;
};

const done = (pack: ReturnType<typeof readPackCall>) => {
  if (pack === null || pack.progress.state !== 'done') throw new Error(`not done: ${JSON.stringify(pack)}`);
  return pack.progress.value;
};

describe('readPackCall — new', () => {
  test('reads a Claude start: what it asked for, the heredoc brief, and the started ferret with every attempt', () => {
    const pack = readPackCall(bash(NEW, { text: STARTED }), 'fy');
    expect(pack).toMatchObject({
      kind: 'new',
      runtime: 'claude-auto-work',
      model: 'claude-opus-5-5',
      effort: 'high',
      auto: false,
      brief: BRIEF,
    });
    expect(done(pack)).toEqual({
      outcome: 'started',
      id: 'mvq1k2-7f3a',
      teammate: 'nadia',
      runtime: 'claude-auto-work',
      model: 'claude-opus-5-5',
      decidedBy: 'you',
      attempts: [
        {
          runtime: 'codex-auto-work',
          model: 'gpt-6-astra',
          outcome: 'refused',
          probe: 0,
          code: 'out_of_quota',
          message: 'codex-auto-work has used its quota',
        },
        { runtime: 'claude-auto-work', model: 'claude-opus-5-5', outcome: 'started', probe: 812 },
      ],
    });
  });

  test('reads a ferret with no callsign, a note, and a cached probe', () => {
    expect(done(readPackCall(bash('fy new --auto "rename it"', { text: STARTED_BARE }), 'fy'))).toEqual({
      outcome: 'started',
      id: 'mvq1k2-7f3a',
      runtime: 'claude-auto-work',
      decidedBy: 'jev',
      note: 'Jev could not answer, so the guide decided.',
      attempts: [{ runtime: 'claude-auto-work', outcome: 'started', probe: 'cached' }],
    });
    // No note: the line after the head is an attempt or the wait hint.
    const plain = 'Started tomi (mvx) on claude-w — decided by guide.\nWait for its result: fy wait mvx';
    expect(done(readPackCall(bash('fy new --auto x', { text: plain }), 'fy'))).not.toHaveProperty('note');
  });

  test('reads a Claude refusal (exit 2, on stderr) and a Codex one, each with its remedy and attempts', () => {
    const claude = readPackCall(bash(NEW, { text: `Exit code 2\n${REFUSED}`, isError: true }), 'fy');
    expect(done(claude)).toEqual({
      outcome: 'refused',
      code: 'probe_failed',
      message: 'codex-auto-work did not answer a "reply OK" check on gpt-6-astra: timed out.',
      remedy: 'Try the next candidate.',
      attempts: [
        {
          runtime: 'codex-auto-work',
          model: 'gpt-6-astra',
          outcome: 'refused',
          probe: 45000,
          code: 'probe_failed',
          message: 'codex-auto-work did not answer a "reply OK" check on gpt-6-astra: timed out.',
        },
      ],
    });
    const bare = 'fy new: refused (depth_exceeded): too deep\n';
    expect(
      done(readPackCall(codex('fy new --auto "x"', { text: `Process exited with code 2\nOutput:\n${bare}` }), 'fy')),
    ).toEqual({ outcome: 'refused', code: 'depth_exceeded', message: 'too deep', attempts: [] });
    // A refusal whose next line is the attempt list has no remedy.
    const noRemedy =
      'fy new: refused (no_candidate): nothing\nTried:\n  refused claude-w (probe cached) — not_agent: no';
    expect(done(readPackCall(bash('fy new --auto x', { text: noRemedy }), 'fy'))).toMatchObject({
      code: 'no_candidate',
      attempts: [{ runtime: 'claude-w', outcome: 'refused', probe: 'cached', code: 'not_agent', message: 'no' }],
    });
  });

  test('prefers the JSON payload when the command asked for --json', () => {
    const codexJson = `Chunk ID: 1\nWall time: 3.2 seconds\nProcess exited with code 0\nOutput:\n${JSON.stringify(startedJson, null, 2)}`;
    expect(done(readPackCall(codex('fy new --json --auto "Review it"', { text: codexJson }), 'fy'))).toEqual({
      outcome: 'started',
      id: 'mvq1k2-7f3a',
      teammate: 'nadia',
      runtime: 'claude-auto-work',
      model: 'claude-opus-5-5',
      effort: 'high',
      decidedBy: 'guide',
      attempts: [{ runtime: 'claude-auto-work', model: 'claude-opus-5-5', outcome: 'started', probe: 640 }],
    });
    const refused = readPackCall(
      bash('fy new --json --runtime=claude-auto-work x', { text: `Exit code 2\n${JSON.stringify(refusedJson)}` }),
      'fy',
    );
    expect(refused).toMatchObject({ runtime: 'claude-auto-work' });
    expect(done(refused)).toEqual({
      outcome: 'refused',
      code: 'limit_reached',
      message: 'mvlead-0001 has 4 running sub-ferrets.',
      remedy: 'Do the work yourself.',
      attempts: [{ runtime: 'claude-auto-work', outcome: 'refused', probe: 'cached' }],
    });
    // A Jev decision reads as itself, and a ferret with no callsign, model or effort leaves them out.
    const { teammate: _t, model: _m, launchReasoningEffort: _e, ...plain } = view.config;
    const jev = { ...startedJson, decidedBy: 'jev', note: 'n', view: { ...view, config: plain } };
    expect(done(readPackCall(bash('fy new --json --auto x', { text: JSON.stringify(jev) }), 'fy'))).toEqual({
      outcome: 'started',
      id: 'mvq1k2-7f3a',
      runtime: 'claude-auto-work',
      decidedBy: 'jev',
      note: 'n',
      attempts: [{ runtime: 'claude-auto-work', model: 'claude-opus-5-5', outcome: 'started', probe: 640 }],
    });
    // JSON that does not parse falls back to the human lines.
    expect(done(readPackCall(bash('fy new --json --auto x', { text: `{oops}\n${STARTED}` }), 'fy'))).toMatchObject({
      id: 'mvq1k2-7f3a',
    });
  });

  test('says running, failed and not recognised rather than inventing an outcome', () => {
    expect(readPackCall(bash(NEW), 'fy')?.progress).toEqual({ state: 'running' });
    expect(
      readPackCall(bash(NEW, { text: 'Exit code 1\nerror: the daemon is not running', isError: true }), 'fy')?.progress,
    ).toEqual({ state: 'failed', reason: 'the daemon is not running' });
    expect(readPackCall(bash(NEW, { text: '', isError: true }), 'fy')?.progress).toEqual({
      state: 'failed',
      reason: 'exit code 1',
    });
    expect(readPackCall(codex(NEW, { text: 'Process exited with code 7' }), 'fy')?.progress).toEqual({
      state: 'failed',
      reason: 'exit code 7',
    });
    expect(readPackCall(bash(NEW, { text: 'something else' }), 'fy')?.progress).toEqual({ state: 'unread' });
    // A result that carries its text as plain content is read too.
    expect(readPackCall(bash(NEW, { content: STARTED }), 'fy')?.progress.state).toBe('done');
    expect(readPackCall(bash(NEW, { content: [{ type: 'text' }] }), 'fy')?.progress).toEqual({ state: 'unread' });
  });

  test('reads a brief from a file, from an expansion, every value option, and a binary named otherwise', () => {
    expect(
      readPackCall(
        bash('direnv exec . fy new --runtime w --use-case bulk --name "Rename" --mode auto --prompt-file /tmp/b.md'),
        'fy',
      ),
    ).toEqual({
      kind: 'new',
      runtime: 'w',
      auto: false,
      useCase: 'bulk',
      name: 'Rename',
      brief: null,
      briefFile: '/tmp/b.md',
      progress: { state: 'running' },
    });
    expect(readPackCall(bash('fy new --auto "fix $FILE"'), 'fy')).toMatchObject({ brief: null });
    expect(readPackCall(bash('/opt/bin/ferret new --auto go'), 'ferret')).toMatchObject({ kind: 'new', brief: 'go' });
    // A value option at the very end, with its value missing, is still not the brief.
    expect(readPackCall(bash('fy new --auto x --cwd'), 'fy')).toMatchObject({ brief: 'x' });
  });

  test('is null for every command that is not a Pack start', () => {
    expect(readPackCall(bash('fy new --continue auth refactor'), 'fy')).toBeNull();
    expect(readPackCall(bash('echo "fy new --auto x"'), 'fy')).toBeNull();
    expect(readPackCall(bash('ls -la'), 'fy')).toBeNull();
    expect(readPackCall(bash('fy ps'), 'fy')).toBeNull();
    expect(readPackCall(bash('fy wait'), 'fy')).toBeNull();
    expect(readPackCall(bash('fy wait "$ID"'), 'fy')).toBeNull();
    expect(readPackCall(call('Read', { file_path: '/fy' }), 'fy')).toBeNull();
    // `fy` mentioned, but run by something other than direnv.
    expect(readPackCall(bash('sudo fy new --auto x'), 'fy')).toBeNull();
    // The second command is the start.
    expect(readPackCall(bash('cd /repo && fy new --auto x'), 'fy')).toMatchObject({ kind: 'new', brief: 'x' });
  });
});

describe('readPackCall — redirections', () => {
  test('a stderr redirect is not part of the brief, the id or the task', () => {
    expect(readPackCall(bash('fy new --runtime claude "Fix the bug" 2>&1'), 'fy')).toMatchObject({
      kind: 'new',
      brief: 'Fix the bug',
    });
    expect(readPackCall(bash('fy wait tomi-1 >/dev/null 2>&1'), 'fy')).toMatchObject({ kind: 'wait', id: 'tomi-1' });
    expect(readPackCall(bash('fy recommend "pick a model" 2>&1 | head'), 'fy')).toMatchObject({
      kind: 'recommend',
      task: 'pick a model',
    });
  });
});

describe('readPackCall — wait', () => {
  test('reads the status, the summary and the stop that followed it', () => {
    const text = [
      'mvq1k2-7f3a is completed',
      '',
      'Found **two** races:',
      '- a',
      'fy wait: stopped mvq1k2-7f3a now its result is collected (--keep leaves it running)',
    ].join('\n');
    expect(readPackCall(bash('fy wait mvq1k2-7f3a', { text }), 'fy')).toEqual({
      kind: 'wait',
      id: 'mvq1k2-7f3a',
      progress: {
        state: 'done',
        value: { status: 'completed', summary: 'Found **two** races:\n- a', stopped: true },
      },
    });
    expect(done(readPackCall(bash('fy wait x', { text: 'x is stopped\n' }), 'fy'))).toEqual({
      status: 'stopped',
      stopped: false,
    });
  });

  test('reads the JSON state with its result, and a wait that ended without one', () => {
    const json = JSON.stringify({ id: 'x', status: 'completed', turn: 3, result: 'All green.' });
    expect(
      done(readPackCall(codex('fy wait --json x', { text: `Process exited with code 0\nOutput:\n${json}` }), 'fy')),
    ).toEqual({ status: 'completed', summary: 'All green.', stopped: false });
    expect(done(readPackCall(bash('fy wait --json x', { text: '{"status":"failed"}' }), 'fy'))).toEqual({
      status: 'failed',
      stopped: false,
    });
    // A JSON line with no status falls back to the human line.
    expect(readPackCall(bash('fy wait --json x', { text: '{"id":"x"}' }), 'fy')?.progress).toEqual({
      state: 'unread',
    });
    expect(readPackCall(bash('fy wait --json x', { text: '[1]' }), 'fy')?.progress).toEqual({ state: 'unread' });
    const timeout = 'Exit code 124\nx is running\nfy wait: timed out after 30s';
    expect(done(readPackCall(bash('fy wait x --timeout 30', { text: timeout, isError: true }), 'fy'))).toEqual({
      status: 'running',
      stopped: false,
      note: 'timed out after 30s',
    });
    expect(
      readPackCall(bash('fy wait x', { text: 'Exit code 69\nfy wait: the daemon went away', isError: true }), 'fy')
        ?.progress,
    ).toEqual({ state: 'failed', reason: 'fy wait: the daemon went away' });
  });
});

describe('readPackCall — recommend', () => {
  test('reads the ranked list from the human lines', () => {
    const pack = readPackCall(bash('fy recommend "review the auth change"', { text: ADVICE }), 'fy');
    expect(pack).toMatchObject({ kind: 'recommend', task: 'review the auth change' });
    expect(done(pack)).toEqual({
      useCase: 'Hard planning, review and critical code',
      options: [
        {
          rank: 1,
          ready: true,
          model: 'Claude Opus 5.5 (claude-opus-5-5)',
          runtime: 'claude-auto-work',
          effort: 'max',
          why: 'The strongest planner and reviewer.',
        },
        {
          rank: 2,
          ready: false,
          model: 'gpt-6-astra',
          effort: 'high',
          why: 'A different family.',
          refusal: 'cli_missing: codex is not installed',
        },
      ],
      next: 'fy new --runtime claude-auto-work --model claude-opus-5-5 --effort max "<brief>"',
    });
    const none = 'Use case: Bulk (bulk, as named; your models guide)\n\n1. cannot  m\n\nNothing can run it here now.';
    expect(done(readPackCall(bash('fy recommend --use-case bulk x', { text: none }), 'fy'))).toEqual({
      useCase: 'Bulk',
      options: [{ rank: 1, ready: false, model: 'm' }],
    });
  });

  test('reads the JSON payload, and fails or goes unread honestly', () => {
    expect(
      done(readPackCall(bash('fy recommend --json rename a helper', { text: JSON.stringify(adviceJson) }), 'fy')),
    ).toEqual({
      useCase: 'Mechanical bulk edits',
      options: [
        {
          rank: 1,
          ready: true,
          model: 'Haiku 4.5',
          runtime: 'claude-auto-work',
          effort: 'low',
          why: 'Cheap and quick.',
        },
        {
          rank: 2,
          ready: false,
          model: 'glm-5',
          why: 'Another family.',
          refusal: 'not_logged_in: zai-work needs signing in',
        },
      ],
    });
    expect(readPackCall(bash('fy recommend --json x', { text: '{}' }), 'fy')?.progress).toEqual({ state: 'unread' });
    expect(
      readPackCall(bash('fy recommend x', { text: 'Exit code 1\nfy recommend: no route', isError: true }), 'fy')
        ?.progress,
    ).toEqual({ state: 'failed', reason: 'fy recommend: no route' });
    expect(readPackCall(bash('fy recommend "$TASK"'), 'fy')).toMatchObject({ task: null });
  });
});

describe('projectPackCalls', () => {
  const group = (id: string, tools: readonly ToolCall[]): TranscriptEntry => ({ id, kind: 'tool', text: 'ran', tools });
  const wait = (id: string, key: string, text = `${id} is completed\n\nDone.`) => bash(`fy wait ${id}`, { text }, key);

  test('lifts each Pack command out of its group, between the calls around it, keeping the group id', () => {
    const entries: TranscriptEntry[] = [
      { id: 'u', kind: 'user', text: 'go' },
      group('g1', [
        bash('ls', undefined, 'a'),
        { ...bash(NEW, { text: STARTED }, 'b'), ts: '2026-10-20T00:00:00.000Z' },
        bash('pwd', undefined, 'c'),
        bash('git status', undefined, 'd'),
      ]),
      {
        id: 's',
        kind: 'tool',
        text: 'sent to x',
        tools: [bash('fy send x hi')],
        sent: { to: 'x', body: 'hi', ask: false, state: 'sending' },
      },
      { id: 'empty', kind: 'tool', text: 'ran' },
    ];
    const out = projectPackCalls(entries, 'fy');
    expect(out.map(entry => [entry.id, entry.text, entry.tools?.map(tool => tool.key)])).toEqual([
      ['u', 'go', undefined],
      ['g1', 'ran a tool', ['a']],
      ['pack:b', 'started a sub-ferret', ['b']],
      ['g1:c', 'ran 2 tools', ['c', 'd']],
      ['s', 'sent to x', ['k1']],
      ['empty', 'ran', undefined],
    ]);
    expect(out[2]?.at).toBe(Date.parse('2026-10-20T00:00:00.000Z'));
    expect(out[2]?.pack?.kind).toBe('new');
  });

  test('folds a wait INTO the card of the ferret it waits for, by id or callsign, with both calls', () => {
    const out = projectPackCalls(
      [
        group('g1', [bash(NEW, { text: STARTED }, 'n1')]),
        { id: 'a', kind: 'assistant', text: 'waiting' },
        group('g2', [wait('nadia', 'w1', 'nadia is completed\n\nDone.')]),
        group('g3', [bash(NEW, { text: STARTED_BARE }, 'n2'), wait('mvq1k2-7f3a', 'w2'), wait('nobody', 'w3')]),
      ],
      'fy',
    );
    expect(out.map(entry => [entry.id, entry.pack?.kind, entry.tools?.map(tool => tool.key)])).toEqual([
      ['pack:n1', 'new', ['n1', 'w1']],
      ['a', undefined, undefined],
      ['pack:n2', 'new', ['n2', 'w2']],
      ['pack:w3', 'wait', ['w3']],
    ]);
    expect(startOf(out[0]).collected).toEqual({
      state: 'done',
      value: { status: 'completed', summary: 'Done.', stopped: false },
    });
    // The same id again goes to the LATEST card that started it.
    expect(startOf(out[2]).collected?.state).toBe('done');
  });

  test('a wait for a ferret no card started, or one whose start is not done, stands alone', () => {
    const out = projectPackCalls([group('g', [bash(NEW, undefined, 'n'), wait('mvq1k2-7f3a', 'w')])], 'fy');
    expect(out.map(entry => entry.pack?.kind)).toEqual(['new', 'wait']);
  });

  test('marks a refused start that was followed by another start as retried', () => {
    const refused = bash(NEW, { text: `Exit code 2\n${REFUSED}`, isError: true }, 'r');
    const out = projectPackCalls(
      [
        group('g', [refused]),
        { id: 'a', kind: 'assistant', text: 'trying the next' },
        group('h', [bash(NEW, { text: STARTED }, 's')]),
      ],
      'fy',
    );
    expect(startOf(out[0]).retried).toBe(true);
    expect(startOf(out[2]).retried).toBeUndefined();
    // A start that was NOT refused is never marked.
    const twice = projectPackCalls(
      [group('g', [bash(NEW, { text: STARTED }, 'x'), bash(NEW, { text: STARTED }, 'y')])],
      'fy',
    );
    expect(startOf(twice[0]).retried).toBeUndefined();
  });
});
