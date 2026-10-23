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
  'Started nadia (mvq1k2-7f3a) on claude-auto-work, claude-opus-5-5 — decided by the routing prompt.',
  '  refused codex-auto-work gpt-6-astra (probe failed 3436 ms) — out_of_quota: codex-auto-work has used its quota',
  '  started claude-auto-work claude-opus-5-5 (probe OK 812 ms)',
  'Wait for its result: fy wait mvq1k2-7f3a',
].join('\n');
const STARTED_BARE = [
  'Started mvq1k2-7f3a on claude-auto-work — decided by jev.',
  'Jev could not answer, so the routing prompt decided.',
  '  started claude-auto-work (probe OK, cached)',
  'Wait for its result: fy wait mvq1k2-7f3a',
].join('\n');
const REFUSED = [
  'fy new: refused (probe_failed): codex-auto-work did not answer a "reply OK" check on gpt-6-astra: timed out.',
  'Try the next candidate.',
  '',
  'Tried:',
  '  refused codex-auto-work gpt-6-astra (probe failed 45000 ms) — probe_failed: codex-auto-work did not answer a "reply OK" check on gpt-6-astra: timed out.',
].join('\n');
const ADVICE = [
  'Routing prompt (your routing prompt):',
  'Planning and review → claude-opus-5-5 at max.',
  '',
  'Chores → claude-haiku-5-5 at low.',
  '',
  'Models usable here now (3):',
  'ready  Claude Opus 5.5 (claude-opus-5-5) at max · claude-auto-work · quota 5h 2% · week 46% · named 1st in the prompt',
  '       fy new --runtime claude-auto-work --model claude-opus-5-5 --effort max "<brief>"',
  'ready  Claude Sonnet 5 (claude-sonnet-5) · claude-auto-work',
  '       fy new --runtime claude-auto-work --model claude-sonnet-5 "<brief>"',
  'cannot GPT 6 Astra (gpt-6-astra) · codex-work · quota not measured',
  '       cli_missing: codex is not installed',
  '',
  'Start the first: fy new --runtime claude-auto-work --model claude-opus-5-5 --effort max "<brief>"',
].join('\n');
const ADVICE_OPTIONS = [
  {
    ready: true,
    model: 'Claude Opus 5.5',
    id: 'claude-opus-5-5',
    runtime: 'claude-auto-work',
    effort: 'max',
    named: 1,
    quota: '5h 2% · week 46%',
  },
  { ready: true, model: 'Claude Sonnet 5', id: 'claude-sonnet-5', runtime: 'claude-auto-work' },
  {
    ready: false,
    model: 'GPT 6 Astra',
    id: 'gpt-6-astra',
    runtime: 'codex-work',
    quota: 'not measured',
    refusal: 'cli_missing: codex is not installed',
  },
];

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
  decidedBy: 'routing',
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
const quota = (summary: string, state: 'plenty' | 'unknown' = 'plenty') => ({ state, windows: [], summary });
const adviceJson: PackRecommendation = {
  task: 'rename a helper',
  routing: { text: 'Chores → claude-haiku-4-5 at low.', source: 'default' },
  available: [
    {
      model: 'claude-haiku-4-5',
      modelLabel: 'Haiku 4.5',
      harness: 'claude',
      efforts: ['low', 'high'],
      runtime: 'claude-auto-work',
      runtimes: 1,
      ready: true,
      quota: quota('5h 10%'),
      named: 1,
      effort: 'low',
      command: 'fy new --runtime claude-auto-work --model claude-haiku-4-5 --effort low "<brief>"',
    },
    {
      model: 'glm-5',
      modelLabel: 'GLM 5',
      harness: 'claude',
      efforts: [],
      runtime: 'zai-work',
      runtimes: 1,
      ready: false,
      refusal: { code: 'not_logged_in', message: 'zai-work needs signing in' },
      quota: quota('not measured', 'unknown'),
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
      decidedBy: 'the routing prompt',
      attempts: [
        {
          runtime: 'codex-auto-work',
          model: 'gpt-6-astra',
          outcome: 'refused',
          probe: 3436,
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
      note: 'Jev could not answer, so the routing prompt decided.',
      attempts: [{ runtime: 'claude-auto-work', outcome: 'started', probe: 'cached' }],
    });
    // No note: the line after the head is an attempt or the wait hint.
    const plain = 'Started tomi (mvx) on claude-w — decided by you.\nWait for its result: fy wait mvx';
    expect(done(readPackCall(bash('fy new --auto x', { text: plain }), 'fy'))).not.toHaveProperty('note');
  });

  test('reads a decider of several words as given, and the one-word ones', () => {
    const decided = (who: string) =>
      done(
        readPackCall(bash('fy new --auto x', { text: `Started tomi (mvx) on claude-w — decided by ${who}.` }), 'fy'),
      );
    expect(decided('the routing prompt')).toMatchObject({
      outcome: 'started',
      id: 'mvx',
      decidedBy: 'the routing prompt',
    });
    expect(decided('you')).toMatchObject({ decidedBy: 'you' });
    expect(decided('jev')).toMatchObject({ decidedBy: 'jev' });
  });

  test('reads every way an attempt line words its probe', () => {
    const text = [
      'Started tomi (mvx) on claude-w — decided by you.',
      '  started claude-w (probe OK)',
      '  started claude-a m1 (probe OK 640 ms)',
      '  refused claude-b (probe failed, shared) — probe_failed: x',
      '  refused claude-c (probe failed 12 ms) — probe_failed: y',
      '  started claude-d (probe 812ms)',
    ].join('\n');
    const outcome = done(readPackCall(bash('fy new --auto x', { text }), 'fy'));
    expect(outcome).toMatchObject({
      outcome: 'started',
      attempts: [
        { runtime: 'claude-w', outcome: 'started' },
        { runtime: 'claude-a', model: 'm1', outcome: 'started', probe: 640 },
        { runtime: 'claude-b', outcome: 'refused', code: 'probe_failed', message: 'x' },
        { runtime: 'claude-c', outcome: 'refused', probe: 12, code: 'probe_failed', message: 'y' },
        { runtime: 'claude-d', outcome: 'started', probe: 812 },
      ],
    });
    // No attempt line is mistaken for the note.
    expect(outcome).not.toHaveProperty('note');
    expect((outcome as { attempts: readonly object[] }).attempts[0]).not.toHaveProperty('probe');
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
      'fy new: refused (no_candidate): nothing\nTried:\n  refused claude-w (probe failed, shared) — not_agent: no';
    expect(done(readPackCall(bash('fy new --auto x', { text: noRemedy }), 'fy'))).toMatchObject({
      code: 'no_candidate',
      attempts: [{ runtime: 'claude-w', outcome: 'refused', code: 'not_agent', message: 'no' }],
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
      decidedBy: 'the routing prompt',
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
    const you = { ...startedJson, decidedBy: 'agent' };
    expect(done(readPackCall(bash('fy new --json --auto x', { text: JSON.stringify(you) }), 'fy'))).toMatchObject({
      decidedBy: 'you',
    });
    // The old decider ('guide') is not a valid answer any more: not invented into one.
    const guide = { ...startedJson, decidedBy: 'guide' };
    expect(readPackCall(bash('fy new --json --auto x', { text: JSON.stringify(guide) }), 'fy')?.progress).toEqual({
      state: 'unread',
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
      readPackCall(bash('direnv exec . fy new --runtime w --name "Rename" --mode auto --prompt-file /tmp/b.md'), 'fy'),
    ).toEqual({
      kind: 'new',
      runtime: 'w',
      auto: false,
      name: 'Rename',
      brief: null,
      briefFile: '/tmp/b.md',
      progress: { state: 'running' },
    });
    expect(readPackCall(bash('fy new --auto "fix $FILE"'), 'fy')).toMatchObject({ brief: null });
    expect(readPackCall(bash('/opt/bin/ferret new --auto go'), 'ferret')).toMatchObject({ kind: 'new', brief: 'go' });
    // An older ferret's `--use-case bulk` is not read as a field, and its value is not the brief.
    const old = readPackCall(bash('fy new --auto --use-case bulk "go"'), 'fy');
    expect(old).toMatchObject({ kind: 'new', brief: 'go' });
    expect(old).not.toHaveProperty('useCase');
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
  const expected = {
    routing: 'Planning and review → claude-opus-5-5 at max.\n\nChores → claude-haiku-5-5 at low.',
    source: 'your routing prompt',
    options: ADVICE_OPTIONS,
    next: 'fy new --runtime claude-auto-work --model claude-opus-5-5 --effort max "<brief>"',
  };

  test('reads the routing prompt and the models usable now from the human lines', () => {
    const pack = readPackCall(bash('fy recommend "review the auth change"', { text: ADVICE }), 'fy');
    expect(pack).toMatchObject({ kind: 'recommend', task: 'review the auth change' });
    expect(done(pack)).toEqual(expected);
    // A Codex result wraps the same lines in its header.
    const wrapped = readPackCall(
      codex('fy recommend x', { text: `Process exited with code 0\nOutput:\n${ADVICE}` }),
      'fy',
    );
    expect(done(wrapped)).toEqual(expected);
  });

  test('reads a default prompt, a cleaned-up one, a machine where nothing can run, and a prompt with blank lines', () => {
    const none = [
      'Routing prompt (the default, rendered from the model catalogs):',
      'Best for planning.',
      '',
      'No model can run here now.',
    ].join('\n');
    expect(done(readPackCall(bash('fy recommend x', { text: none }), 'fy'))).toEqual({
      routing: 'Best for planning.',
      source: 'the default, rendered from the model catalogs',
      options: [],
    });
    const cleaned = ADVICE.replace(
      'Routing prompt (your routing prompt):',
      'Routing prompt (cleaned up by gpt-oss-120b on 2026-10-22 and accepted):',
    );
    expect(done(readPackCall(bash('fy recommend x', { text: cleaned }), 'fy'))).toMatchObject({
      source: 'cleaned up by gpt-oss-120b on 2026-10-22 and accepted',
    });
    // Ordinals other than 1st: 2nd, 3rd, 11th.
    const ordinals = [
      'Routing prompt (your routing prompt):',
      'p',
      '',
      'Models usable here now (3):',
      'ready  A (a) · r · named 2nd in the prompt',
      'ready  B (b) · r · named 3rd in the prompt',
      'ready  C (c) · r · named 11th in the prompt',
    ].join('\n');
    expect(
      (
        done(readPackCall(bash('fy recommend x', { text: ordinals }), 'fy')) as {
          options: readonly { named?: number }[];
        }
      ).options.map(model => model.named),
    ).toEqual([2, 3, 11]);
  });

  test('reads the JSON payload, and fails or goes unread honestly', () => {
    expect(
      done(readPackCall(bash('fy recommend --json rename a helper', { text: JSON.stringify(adviceJson) }), 'fy')),
    ).toEqual({
      routing: 'Chores → claude-haiku-4-5 at low.',
      source: 'the default, rendered from the model catalogs',
      options: [
        {
          ready: true,
          model: 'Haiku 4.5',
          id: 'claude-haiku-4-5',
          runtime: 'claude-auto-work',
          effort: 'low',
          named: 1,
          quota: '5h 10%',
        },
        {
          ready: false,
          model: 'GLM 5',
          id: 'glm-5',
          runtime: 'zai-work',
          refusal: 'not_logged_in: zai-work needs signing in',
        },
      ],
    });
    // A prompt the owner wrote, and one cleaned up by a model, say so.
    const own = { ...adviceJson, routing: { text: 'mine', source: 'file' as const }, next: 'fy new …' };
    expect(done(readPackCall(bash('fy recommend --json x', { text: JSON.stringify(own) }), 'fy'))).toMatchObject({
      routing: 'mine',
      source: 'your routing prompt',
      next: 'fy new …',
    });
    const suggested = {
      ...adviceJson,
      routing: {
        text: 'mine',
        source: 'file' as const,
        suggested: {
          by: 'gpt-oss-120b',
          via: 'groq',
          at: '2026-10-22T08:00:00.000Z',
          acceptedAt: '2026-10-22T09:30:00.000Z',
        },
      },
    };
    expect(done(readPackCall(bash('fy recommend --json x', { text: JSON.stringify(suggested) }), 'fy'))).toMatchObject({
      source: 'cleaned up by gpt-oss-120b on 2026-10-22 and accepted',
    });
    expect(readPackCall(bash('fy recommend --json x', { text: '{}' }), 'fy')?.progress).toEqual({ state: 'unread' });
    expect(
      readPackCall(bash('fy recommend x', { text: 'Exit code 1\nfy recommend: no route', isError: true }), 'fy')
        ?.progress,
    ).toEqual({ state: 'failed', reason: 'fy recommend: no route' });
    expect(readPackCall(bash('fy recommend "$TASK"'), 'fy')).toMatchObject({ task: null });
  });

  test('an answer it does not recognise is unread, never an invented list', () => {
    const unread = (text: string) => readPackCall(bash('fy recommend x', { text }), 'fy')?.progress;
    expect(unread('something else entirely')).toEqual({ state: 'unread' });
    expect(unread('')).toEqual({ state: 'unread' });
    // A routing prompt with no models section after it.
    expect(unread('Routing prompt (your routing prompt):\nChores → haiku.')).toEqual({ state: 'unread' });
    // A models section with no routing prompt before it.
    expect(unread('Models usable here now (1):\nready  A (a) · r')).toEqual({ state: 'unread' });
    expect(unread('Routing prompt (your routing prompt):\n\nNo model can run here now.')).toEqual({
      state: 'unread',
    });
  });

  test('the old use-case recommendation is not read: an older transcript degrades to unread', () => {
    const old = [
      "Use case: Hard planning, review and critical code (plan-review, from the task's words; the built-in guide)",
      '',
      '1. ready   Claude Opus 5.5 (claude-opus-5-5) on claude-auto-work · effort max',
      '   The strongest planner and reviewer.',
      '',
      'Start the first: fy new --runtime claude-auto-work --model claude-opus-5-5 --effort max "<brief>"',
    ].join('\n');
    expect(readPackCall(bash('fy recommend --use-case plan-review x', { text: old }), 'fy')).toMatchObject({
      kind: 'recommend',
      task: 'x',
      progress: { state: 'unread' },
    });
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
