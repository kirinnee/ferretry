import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { advance, makeSandbox, type Sandbox } from './migrate-harness.ts';

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
    expect(truncated.err).toContain('more than 500 closed cards');
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
    expect(gone.out).toMatch(/board open: card ids .* FAIL/);
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
      { match: 'secret ls --json', out: '{"secrets":[]}' },
      { match: 'ask', out: 'no asks are waiting' },
      { match: 'doctor' },
    ]);
    const result = await sb.run('verify');
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/panes .* FAIL/);
    expect(result.out).toMatch(/logins .* FAIL/);
    expect(result.out).toMatch(/secret names .* FAIL/);
  });

  test('a different ask count is shown to the owner (REVIEW), not hidden', async () => {
    await sb.fake('fy', [
      { match: 'ps -a --json', run: 'cat "$D/ps.v5.json"' },
      { match: 'board *', run: 'echo \'{"cards":[],"nextCursor":null}\'' },
      { match: 'secret ls --json', out: '{"secrets":[{"name":"API_KEY"}]}' },
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
