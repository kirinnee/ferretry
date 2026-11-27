import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { advance, baselineArgs, makeSandbox, type Sandbox } from './migrate-harness.ts';

setDefaultTimeout(60_000);

describe('baseline: every producer is checked, nothing hides an error', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await makeSandbox();
    await advance(sb, 'preflight');
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  test('--asks-open is required (the owner reads the count in the app)', async () => {
    const result = await sb.run('baseline', []);
    expect(result.code).toBe(1);
    expect(result.err).toContain('--asks-open');
  });

  test('R2.1: a failing `fy ps` is exit 1, not an empty baseline that later "matches"', async () => {
    await sb.fake('fy', [{ match: 'ps -a --json', code: 7 }]);
    const result = await sb.run('baseline', ['--asks-open', '0']);
    expect(result.code).toBe(1);
    expect(result.err).toContain("'fy ps -a --json' failed");
    expect(await sb.notesText()).not.toContain('# baselined');
  });

  test('R2.1: empty output of a successful `fy ps` is refused too (not a list of ferrets)', async () => {
    await sb.fake('fy', [{ match: 'ps -a --json', run: 'true' }]);
    const result = await sb.run('baseline', ['--asks-open', '0']);
    expect(result.code).toBe(1);
  });

  test('R2.1: a failing board read is exit 1, and so is a truncated board (more than 500 cards)', async () => {
    await sb.fake('fy', [
      { match: 'ps -a --json', run: 'cat "$D/ps.v4.json"' },
      { match: 'board --project all --state open*', code: 3 },
    ]);
    expect((await sb.run('baseline', ['--asks-open', '0'])).code).toBe(1);
    await sb.cleanup();
    sb = await makeSandbox();
    await advance(sb, 'preflight');
    await sb.state('board-closed.json', '{"cards":[],"nextCursor":"abc"}');
    const truncated = await sb.run('baseline', ['--asks-open', '0']);
    expect(truncated.code).toBe(1);
    expect(truncated.err).toContain('more than 500 closed tasks');
  });

  test('a damaged secret store stops the baseline; it is never read as an empty one', async () => {
    await sb.fake('fy', [
      { match: 'ps -a --json', run: 'cat "$D/ps.v4.json"' },
      { match: 'board *', run: 'echo \'{"cards":[],"nextCursor":null}\'' },
      { match: 'secret ls --json', out: '{"health":"damaged","secrets":[]}' },
    ]);
    const result = await sb.run('baseline', ['--asks-open', '0']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('damaged');
  });

  test('tmux that cannot be read is exit 2', async () => {
    await sb.fake('tmux', [{ match: '*', code: 42 }]);
    const result = await sb.run('baseline', ['--asks-open', '0']);
    expect(result.code).toBe(2);
  });
});

describe('verify: compares each field with its own v5 destination', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await makeSandbox();
    await advance(sb, 'start');
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  const v5 = (list: unknown) => sb.state('ps.v5.json', JSON.stringify(list));

  test('R2.2: callsign is compared with the v5 name and title with the v5 title (a title is NOT a callsign)', async () => {
    const result = await sb.run('verify');
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/callsigns .* OK/);
    expect(result.out).toMatch(/titles .* OK/);
  });

  test('R2.2: the converter fallback (no valid callsign: the title, or the id, becomes the name) is a REVIEW, not a FAIL', async () => {
    await v5([
      { id: 'f1', name: 'Review Migration Prompt Fixes', title: 'Review Migration Prompt Fixes' },
      { id: 'f2', name: 'f2', title: 'Child task', parent: 'f1' },
    ]);
    const result = await sb.run('verify');
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/callsigns .* REVIEW/);
  });

  test('a v5 name that is neither the callsign, the title nor the id is a FAIL', async () => {
    await v5([
      { id: 'f1', name: 'someone-else', title: 'Review Migration Prompt Fixes' },
      { id: 'f2', name: 'bob', title: 'Child task', parent: 'f1' },
    ]);
    const result = await sb.run('verify');
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/callsigns .* FAIL/);
  });

  test('a changed parent or a missing ferret is a FAIL; a dropped title is a REVIEW', async () => {
    await v5([
      { id: 'f1', name: 'ashlie' },
      { id: 'f2', name: 'bob', title: 'Child task' },
    ]);
    const result = await sb.run('verify');
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/parents .* FAIL/);
    expect(result.out).toMatch(/titles .* REVIEW/);
    await v5([{ id: 'f1', name: 'ashlie', title: 'Review Migration Prompt Fixes' }]);
    expect((await sb.run('verify')).out).toMatch(/ferret ids .* FAIL/);
  });

  test('R2.1: a failing v5 read is a FAIL, never two empty sides that "match"', async () => {
    await sb.fake('fy', [
      { match: 'ps -a --json', code: 7 },
      { match: 'board *', code: 7 },
      { match: 'secret ls --json', code: 7 },
      { match: 'ask', code: 7 },
      { match: 'doctor', code: 7 },
    ]);
    const result = await sb.run('verify');
    expect(result.code).toBe(1);
    for (const row of ['ferrets', 'board open', 'secret names', 'asks', 'fy doctor'])
      expect(result.out).toMatch(new RegExp(`${row}.* FAIL`));
  });

  test('board: a missing card id is a FAIL; a card in another lane is a REVIEW the owner decides', async () => {
    await sb.state('board-open.json', '{"cards":[{"id":"C1","laneId":"done"}],"nextCursor":null}');
    const lane = await sb.run('verify');
    expect(lane.code).toBe(0);
    expect(lane.out).toMatch(/board open: lanes .* REVIEW/);
    await sb.state('board-open.json', '{"cards":[],"nextCursor":null}');
    const gone = await sb.run('verify');
    expect(gone.code).toBe(1);
    expect(gone.out).toMatch(/board open: task ids .* FAIL/);
  });

  test('a missing pane, login or secret name is a FAIL', async () => {
    await sb.fake('tmux', [
      { match: '*session_name*', out: 'fy-other %9' },
      { match: '*window_activity*', out: '%1 1' },
    ]);
    await rm(join(sb.v4home, 'config', 'logins', 'beta.yaml'));
    await sb.fake('fy', [
      { match: 'ps -a --json', run: 'cat "$D/ps.v5.json"' },
      { match: 'board *', run: 'echo \'{"cards":[{"id":"C1","laneId":"todo"}],"nextCursor":null}\'' },
      { match: 'secret ls --json', out: '{"health":"ready","secrets":[]}' },
      { match: 'ask', out: 'no asks are waiting' },
      { match: 'doctor' },
    ]);
    const result = await sb.run('verify');
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/panes .* FAIL/);
    expect(result.out).toMatch(/logins .* FAIL/);
    expect(result.out).toMatch(/secret names .* FAIL/);
  });

  /** f1's v5 history, as Ferrets journals it: one JSON event per line, `type` naming it. */
  const history = async (...types: string[]) => {
    await mkdir(join(sb.v4home, 'state', 'ferrets', 'f1'), { recursive: true });
    await writeFile(
      join(sb.v4home, 'state', 'ferrets', 'f1', 'history.jsonl'),
      types
        .map((type, index) => JSON.stringify({ format: 1, sequence: index + 1, sessionId: 'f1', type, data: {} }))
        .join('\n') + '\n',
    );
  };
  /** Like {@link history}, but each event carries its own data (an exit says how the agent ended). */
  const historyWith = async (...events: { type: string; data?: Record<string, unknown> }[]) => {
    await mkdir(join(sb.v4home, 'state', 'ferrets', 'f1'), { recursive: true });
    await writeFile(
      join(sb.v4home, 'state', 'ferrets', 'f1', 'history.jsonl'),
      events
        .map((event, index) =>
          JSON.stringify({ format: 1, sequence: index + 1, sessionId: 'f1', type: event.type, data: event.data ?? {} }),
        )
        .join('\n') + '\n',
    );
  };
  const panesNow = async (line: string) =>
    await sb.fake('tmux', [
      { match: '*session_name*', out: line },
      { match: '*window_activity*', out: '%1 1' },
    ]);

  test('M3: a pane v5 replaced by restarting its ferret passes: same session, a new pane, and session.restarted', async () => {
    // The converter queues a restart for every ferret in its v4 pane; a restart ends the old harness and starts a new
    // pane. Counting pane ids alone failed every migration with a live ferret once the restart worked.
    await panesNow('fy-f1 %7');
    await history('session.created', 'session.stopped', 'session.resumed', 'session.restarted');
    const result = await sb.run('verify');
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/panes +OK +0 baseline panes still present, 1 restarted by v5 in a new pane/);
  });

  test('M3: a new pane with no session.restarted in its history is still a missing pane (FAIL)', async () => {
    await panesNow('fy-f1 %7');
    await history('session.created');
    const result = await sb.run('verify');
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/panes +FAIL +1 baseline panes missing/);
  });

  test('M3: a restart that gave up is a FAIL naming the ferret, even with its old pane still there', async () => {
    // A failed restart leaves the ferret stopped in v5; its old pane surviving proves nothing.
    await history('session.restarted', 'session.restart_gave_up');
    const result = await sb.run('verify');
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/panes +FAIL +v5 could not restart: f1 .*session.restart_gave_up/);
  });

  test('M3: the LAST restart event decides: a later successful restart clears an earlier give-up', async () => {
    await panesNow('fy-f1 %8');
    await history('session.restart_gave_up', 'session.resumed', 'session.restarted');
    const result = await sb.run('verify');
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/panes +OK .*1 restarted by v5/);
  });

  test('run 7: a restart blocked on a login is a REVIEW naming the login and what to do, never a FAIL', async () => {
    // The restart judged the runtime first and found its login needs sign-in: the v4 harness was never stopped, the
    // restart is still queued, and v5 restarts it once the login is signed in.
    await sb.state(
      'ps.v5.json',
      JSON.stringify([
        { id: 'f1', name: 'ashlie', title: 'Review Migration Prompt Fixes', login: 'codex-main' },
        { id: 'f2', name: 'bob', title: 'Child task', parent: 'f1' },
      ]),
    );
    await history('session.created', 'session.restart_blocked');
    const result = await sb.run('verify');
    expect(result.code).toBe(0);
    expect(result.out).toMatch(
      /panes +REVIEW +1 baseline panes still present \(1 not restarted yet: f1 \(still on v4 until codex-main is signed in\)\), 0 restarted by v5 in a new pane\. Sign each in \(fy login signin codex-main\)/,
    );
    expect(result.out).toContain(
      'Some running ferrets are still on v4 until a login is signed in: fy login signin codex-main',
    );
  });

  test('run 7: a blocked restart with no login on record points to fy login ls; a blocked one whose pane is gone FAILs', async () => {
    await history('session.restart_blocked');
    const unnamed = await sb.run('verify');
    expect(unnamed.code).toBe(0);
    expect(unnamed.out).toMatch(/panes +REVIEW .*f1 \(still on v4 until its login is signed in\).*fy login ls/);
    await panesNow('fy-other %9');
    const gone = await sb.run('verify');
    expect(gone.code).toBe(1);
    expect(gone.out).toMatch(/panes +FAIL +1 baseline panes missing/);
  });

  test('D-105: a ferret v5 restarted that then exited cleanly (status 0) is a REVIEW, not a missing pane', async () => {
    // The restart worked and the agent finished by itself: its pane is gone because the work is done, not lost.
    await panesNow('fy-other %9');
    await historyWith(
      { type: 'session.created' },
      { type: 'session.restarted' },
      { type: 'session.exited', data: { status: 'stopped', pane: 'dead', exitCode: 0, signal: null } },
    );
    const result = await sb.run('verify');
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/panes +REVIEW +.*f1 exited cleanly after v5 restarted it .*the work is done/);
    expect(result.out).not.toMatch(/panes +FAIL/);
  });

  test('D-105: a restarted ferret whose agent then crashed or was killed is still a FAIL', async () => {
    await panesNow('fy-other %9');
    await historyWith(
      { type: 'session.restarted' },
      { type: 'session.exited', data: { status: 'failed', pane: 'dead', exitCode: 1, signal: null } },
    );
    const crashed = await sb.run('verify');
    expect(crashed.code).toBe(1);
    expect(crashed.out).toMatch(/panes +FAIL +1 baseline panes missing/);
    await historyWith(
      { type: 'session.restarted' },
      { type: 'session.exited', data: { status: 'failed', pane: 'gone', exitCode: null, signal: null } },
    );
    const gone = await sb.run('verify');
    expect(gone.code).toBe(1);
    expect(gone.out).toMatch(/panes +FAIL +1 baseline panes missing/);
  });

  test('D-105: the done marker after a restart is the same REVIEW; a resume after the clean exit that then crashed is a FAIL', async () => {
    await panesNow('fy-other %9');
    await historyWith({ type: 'session.restarted' }, { type: 'session.completed' });
    const done = await sb.run('verify');
    expect(done.code).toBe(0);
    expect(done.out).toMatch(/panes +REVIEW +.*f1 exited cleanly after v5 restarted it/);
    await historyWith(
      { type: 'session.restarted' },
      { type: 'session.exited', data: { status: 'stopped', pane: 'dead', exitCode: 0, signal: null } },
      { type: 'session.resumed' },
      { type: 'session.exited', data: { status: 'failed', pane: 'gone', exitCode: null, signal: null } },
    );
    const crashed = await sb.run('verify');
    expect(crashed.code).toBe(1);
    expect(crashed.out).toMatch(/panes +FAIL +1 baseline panes missing/);
  });

  test('D-105: a clean exit from BEFORE the restart does not excuse a missing pane', async () => {
    await panesNow('fy-other %9');
    await historyWith(
      { type: 'session.exited', data: { status: 'stopped', pane: 'dead', exitCode: 0, signal: null } },
      { type: 'session.restarted' },
    );
    const result = await sb.run('verify');
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/panes +FAIL +1 baseline panes missing/);
  });

  test('run 7: a blocked restart that later went through is OK', async () => {
    await panesNow('fy-f1 %8');
    await history('session.restart_blocked', 'session.resumed', 'session.restarted');
    const result = await sb.run('verify');
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/panes +OK .*1 restarted by v5/);
  });

  test('a different ask count is shown to the owner (REVIEW), not hidden', async () => {
    await sb.fake('fy', [
      { match: 'ps -a --json', run: 'cat "$D/ps.v5.json"' },
      { match: 'board *', run: 'echo \'{"cards":[],"nextCursor":null}\'' },
      { match: 'secret ls --json', out: '{"health":"ready","secrets":[{"name":"API_KEY"}]}' },
      { match: 'ask', out: 'ASK  FROM  ASKING\na1  f1  q\na2  f2  q' },
      { match: 'doctor' },
    ]);
    await sb.state('board-open.json', '{"cards":[],"nextCursor":null}');
    const result = await sb.run('verify');
    expect(result.out).toMatch(/asks .* REVIEW .*v5 lists 2, the owner counted 0/);
  });
});

describe('verify on an empty fleet', () => {
  test('the pane check is SKIPPED with its reason, never failed', async () => {
    const empty = await makeSandbox({ panes: false });
    try {
      await advance(empty, 'start');
      const result = await empty.run('verify');
      expect(result.code).toBe(0);
      expect(result.out).toMatch(/panes .* SKIP .*no live ferret/);
    } finally {
      await empty.cleanup();
    }
  });
});

describe('verify: the Claude connector (Claude stays signed in)', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await makeSandbox();
    await advance(sb, 'preflight');
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  const grant = (id: string, revoked: boolean) => ({
    id,
    ...(revoked ? { revokedAt: '2026-11-01T00:00:00.000Z' } : {}),
  });
  const put = async (path: string, text: string) => {
    await mkdir(join(sb.v4home, path, '..'), { recursive: true });
    await writeFile(join(sb.v4home, path), text);
  };
  /** The v4 home as the owner has it: the switch on, two grants of which one is live. */
  const v4Connector = async () => {
    await put('config/daemon.json', JSON.stringify({ connector: { enabled: true, publicUrl: 'https://c.example' } }));
    await put(
      'state/connector/connector.json',
      JSON.stringify({ version: 1, grants: [grant('cg_a', false), grant('cg_b', true)] }),
    );
  };
  const toStart = async () => {
    for (const [phase, args] of [
      ['baseline', baselineArgs],
      ['quiet', ['--owner-confirmed']],
      ['backup', ['--owner-yes']],
      ['convert', []],
      ['install', []],
      ['start', []],
    ] as const)
      expect((await sb.run(phase, args)).code, phase).toBe(0);
  };

  /** What v5's daemon says is IN EFFECT (`fy connector --json`): the switch actually on, and its grants. */
  const inEffect = (switchedOn: boolean, grants: ReturnType<typeof grant>[], enabled = true) =>
    sb.state('connector.v5.json', JSON.stringify({ enabled, switchedOn, grants }));

  test('the same live grants and the same switch IN EFFECT in v5: OK', async () => {
    await v4Connector();
    await toStart();
    await inEffect(true, [grant('cg_a', false), grant('cg_b', true)]);
    const result = await sb.run('verify');
    expect(result.code, result.all).toBe(0);
    expect(result.out).toMatch(/claude connector .* OK .*1 live grants/);
  });

  test('a lost grant is a FAIL: Claude would have to sign in again', async () => {
    await v4Connector();
    await toStart();
    await inEffect(true, [grant('cg_b', true)]);
    const result = await sb.run('verify');
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/claude connector .* FAIL .*1 in v4, 0 in v5/);
  });

  test('a switch that is not on in v5 is a REVIEW for the owner, never a silent pass', async () => {
    await v4Connector();
    await toStart();
    await inEffect(false, [grant('cg_a', false)], false);
    const result = await sb.run('verify');
    expect(result.code, result.all).toBe(0);
    expect(result.out).toMatch(/claude connector .* REVIEW .*on=true in v4, on=false in v5/);
  });

  test('the file says on but v5 holds the connector OFF: verify reads what is in effect, so it is a REVIEW, not OK', async () => {
    await v4Connector();
    await toStart();
    // The converted config/connector.yaml says `enabled: true`, but the daemon holds the switch off.
    await put('config/connector.yaml', 'enabled: true\npublicUrl: https://c.example\n');
    await inEffect(false, [grant('cg_a', false)], true);
    const result = await sb.run('verify');
    expect(result.out).toMatch(/claude connector .* REVIEW .*on=true in v4, on=false in v5/);
    expect(result.out).not.toMatch(/claude connector .* OK/);
  });

  test('a v5 that cannot say what is in effect is a FAIL, never a guess from a file', async () => {
    await v4Connector();
    await toStart();
    await put('config/connector.yaml', 'enabled: true\n');
    await sb.fake('fy', [
      { match: 'connector --json', code: 7 },
      { match: 'ps -a --json', run: 'cat "$D/ps.v5.json"; echo' },
      { match: 'secret ls --json', out: '{"health":"ready","secrets":[]}' },
      { match: 'ask', out: 'no asks are waiting' },
      { match: 'doctor', out: 'doctor clean' },
      { match: 'board *', run: 'echo \'{"cards":[],"nextCursor":null}\'' },
      { match: '*', code: 0 },
    ]);
    const result = await sb.run('verify');
    expect(result.out).toMatch(/claude connector .* FAIL .*fy connector --json/);
  });

  test('a home with no connector at all verifies as 0 grants, off, as in v4', async () => {
    await toStart();
    const result = await sb.run('verify');
    expect(result.out).toMatch(/claude connector .* OK .*on=false, 0 live grants/);
  });

  test('a damaged connector.json stops the baseline, names the file AND the way out (restore, or move it aside)', async () => {
    await put('state/connector/connector.json', '{ "grants": [');
    const result = await sb.run('baseline', baselineArgs);
    expect(result.code).toBe(1);
    expect(result.err).toContain('state/connector/connector.json');
    expect(result.err).toContain('restore it from your v4 backup');
    expect(result.err).toContain('mv state/connector/connector.json state/connector/connector.json.damaged');
  });
});
