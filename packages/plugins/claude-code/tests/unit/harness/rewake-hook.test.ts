import { describe, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  CLAUDE_QUESTION_HOOK_COMMAND,
  CLAUDE_QUESTION_HOOKS,
  CLAUDE_REWAKE_HOOK_COMMAND,
  CLAUDE_REWAKE_HOOKS,
  CLAUDE_REWAKE_TIMEOUT_SECONDS,
  fixedLayer,
} from '../../../daemon/lib/harness/fixed-layer.ts';

/** Runs the REAL listener under `sh`, with `FY_REWAKE_DIR` set (or not), and reports how it ended. */
function listen(folder: string | undefined, stdin = '{"hook_event_name":"Stop"}') {
  const child = Bun.spawn(['sh', '-c', CLAUDE_REWAKE_HOOK_COMMAND], {
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...(folder === undefined ? {} : { FY_REWAKE_DIR: folder }) },
    // A `Buffer`, not a `Blob` (see the question-hook test: happy-dom replaces the global `Blob` in the shared process).
    stdin: Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    child,
    result: (async () => ({
      code: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    }))(),
  };
}

const wait = async (ms: number) => await new Promise(resolve => setTimeout(resolve, ms));

async function inbox(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'claude-rewake-hook-'));
}

describe('the Stop hook overlay entry', () => {
  it('the overlay carries a Stop entry with asyncRewake and a day-long timeout, beside the unchanged question hook', () => {
    const { overlay, settings } = fixedLayer('auto', '/work/repo');
    const hooks = overlay.hooks as typeof CLAUDE_QUESTION_HOOKS & typeof CLAUDE_REWAKE_HOOKS;
    should(CLAUDE_REWAKE_TIMEOUT_SECONDS).equal(86_400);
    should(hooks.Stop).eql([
      {
        hooks: [{ type: 'command', command: CLAUDE_REWAKE_HOOK_COMMAND, asyncRewake: true, timeout: 86_400 }],
      },
    ]);
    // The question hook is exactly what it was, and the fixed settings (the other overlay source) carry no hook at all.
    should(hooks.PreToolUse).eql([
      { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: CLAUDE_QUESTION_HOOK_COMMAND }] },
    ]);
    should(Object.keys(settings)).not.containEql('hooks');
  });
});

describe('the rewake listener (real sh)', () => {
  it('claims the OLDEST message, moves it to taken/, prints its text on stderr and exits 2', async () => {
    const folder = await inbox();
    try {
      await writeFile(join(folder, '00000000000002-newer.md'), 'second message\n');
      await writeFile(
        join(folder, '00000000000001-older.md'),
        '[message from ferret avary (session s1) — not from the owner] To reply: fy send avary "<reply>"\nhello\n',
      );
      const { result } = listen(folder);
      const ended = await result;
      should(ended.code).equal(2);
      should(ended.stderr).equal(
        '[message from ferret avary (session s1) — not from the owner] To reply: fy send avary "<reply>"\nhello\n',
      );
      should(ended.stdout).equal('');
      // One message per wake: the older was claimed, the newer waits for the next Stop.
      should((await readdir(folder)).filter(name => name.endsWith('.md'))).eql(['00000000000002-newer.md']);
      should(await readdir(join(folder, 'taken'))).eql(['00000000000001-older.md']);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('exits 0 at once, printing nothing, when FY_REWAKE_DIR is unset or names no folder', async () => {
    const folder = await inbox();
    try {
      for (const target of [undefined, join(folder, 'missing')]) {
        const ended = await listen(target).result;
        should(ended.code).equal(0);
        should(ended.stdout).equal('');
        should(ended.stderr).equal('');
      }
      // Nothing was created beside a folder that does not exist.
      should(await readdir(folder)).eql([]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('a NEWER listener supersedes an older one, which exits 0 without taking anything', async () => {
    const folder = await inbox();
    try {
      const older = listen(folder);
      await wait(300);
      should(await Bun.file(join(folder, 'armed')).exists()).equal(true);
      const first = await readFile(join(folder, 'armed'), 'utf8');
      const newer = listen(folder);
      // The older sees the token change on its next second and ends, quietly.
      const ended = await older.result;
      should(ended.code).equal(0);
      should(ended.stderr).equal('');
      should(await readFile(join(folder, 'armed'), 'utf8')).not.equal(first);
      // The newer is still waiting: a message is handed to IT, once.
      await writeFile(join(folder, '00000000000001-one.md'), 'only once\n');
      const taken = await newer.result;
      should(taken.code).equal(2);
      should(taken.stderr).equal('only once\n');
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('moves the heartbeat: armed is touched every second while the listener waits', async () => {
    const folder = await inbox();
    const { child, result } = listen(folder);
    try {
      await wait(300);
      const armed = join(folder, 'armed');
      // Age the file, then see the listener bring it back to now.
      const old = new Date(Date.now() - 60_000);
      await utimes(armed, old, old);
      should(Date.now() - (await stat(armed)).mtimeMs).be.above(50_000);
      await wait(1_600);
      should(Date.now() - (await stat(armed)).mtimeMs).be.below(3_000);
    } finally {
      child.kill();
      await result;
      await rm(folder, { recursive: true, force: true });
    }
  });
});
