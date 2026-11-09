import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { TerminalsConfigSchema } from '@ferretry/plugin-terminals/contract';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { prepare } from '../../preview/driver.ts';
import { PREVIEW } from '../../preview/plan.ts';
import { copyOne, copySqlite } from '../../preview/stage.ts';
import {
  CHECK_COMMAND,
  CHECK_TERMINAL,
  LOGIN_SHELLS,
  startChecks,
  terminalCheck,
  type Run,
} from '../../preview/start-checks.ts';
import { ferretsStep } from '../../src/steps/ferrets.ts';
import { packsStep } from '../../src/steps/packs.ts';
import { buildPlan } from '../../src/steps/settings.ts';
import { CODEX_HELD_SENTENCE, PREVIEW_SETTINGS_ITEM, previewShellEnv } from '../../src/v5/preview-env.ts';
import { AT, fixture } from './ferret-fixture.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fy-fix6-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const write = async (base: string, path: string, text: string) => {
  await mkdir(join(base, path, '..'), { recursive: true });
  await writeFile(join(base, path), text);
};

/** A v4 home with a Claude runtime and a Codex one, a Claude ferret and a Codex ferret. */
async function twoHarnesses() {
  const f = await fixture();
  await write(f.from, 'layout-version', '2\n');
  await write(f.from, 'config/runtimes/claude-work.yaml', 'credential: claude-login\nprofile: main\nharness: claude\n');
  await write(f.from, 'config/runtimes/codex-work.yaml', 'credential: codex-login\nprofile: main\nharness: codex\n');
  await write(f.from, 'config/profiles/main.yaml', 'contents: []\n');
  await f.session('cl1', { agent: 'claude-work', harness: 'claude' });
  await f.session('cx1', { agent: 'codex-work', harness: 'codex' });
  return f;
}

const previewCtx = (f: Awaited<ReturnType<typeof fixture>>) => ({
  ...f.ctx(),
  preview: true,
  previewV4Home: f.from,
  previewShellEnv: previewShellEnv(f.to, PREVIEW.port),
});

describe('MAJOR-1 prepare writes the terminal environment', () => {
  test('config/terminals.yaml carries the four preview entries and parses with the Terminals schema', async () => {
    const f = await fixture();
    try {
      await write(f.from, 'layout-version', '2\n');
      const done = await prepare({
        v4Home: f.from,
        target: f.to,
        lock: { held: async () => false },
        now: () => new Date('2026-11-09T00:00:00Z'),
        home: join(f.root, 'home'),
      });
      expect(done.report?.complete).toBe(true);
      const text = await readFile(join(f.to, 'config/terminals.yaml'), 'utf8');
      const parsed = TerminalsConfigSchema.parse(parseYaml(text));
      const env = previewShellEnv(f.to, PREVIEW.port);
      expect(Object.keys(env).sort()).toEqual(['FY_HOME', 'FY_PORT', 'FY_URL', '__ETC_PROFILE_NIX_SOURCED']);
      expect(parsed.environment).toEqual(env);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe('MAJOR-1 terminalCheck', () => {
  const target = '/p/preview';
  const shim = `${target}/bin/fy`;
  const callerEnv = { HOME: '/h', USER: 'u', PATH: '/usr/bin' };
  const fy5 = `${target}/bin/${PREVIEW.wrapper}`;

  /** A fake daemon: `ps` answers `ps`, `read` answers `pane`, and every call is kept. */
  const fake = (options: { ps?: { code: number; stdout: string }; open?: number; pane?: string }) => {
    const calls: string[][] = [];
    const run: Run = async argv => {
      calls.push([...argv]);
      const verb = argv[1] === 'terminal' ? argv[2] : argv[1];
      if (verb === 'ps') return options.ps ?? { code: 0, stdout: JSON.stringify([{ id: 'ferret-1' }]) };
      if (verb === 'open') return { code: options.open ?? 0, stdout: '' };
      if (verb === 'read') return { code: 0, stdout: options.pane ?? `fy=${shim}\nhome=${target}\n` };
      return { code: 0, stdout: '' };
    };
    return { run, calls };
  };
  const check = (run: Run, sleep?: (ms: number) => Promise<void>) =>
    terminalCheck({ target, v4Home: '/v4', callerEnv, run, ...(sleep === undefined ? {} : { sleep }) });
  const verbs = (calls: string[][]) => calls.map(call => (call[1] === 'terminal' ? call[2] : call[1]));

  test('passes when the pane reports the shim and the preview home, and closes the terminal', async () => {
    const { run, calls } = fake({});
    const result = await check(run);
    expect(result.ok).toBe(true);
    expect(result.passed.join(' ')).toContain(shim);
    expect(verbs(calls)).toEqual(['ps', 'open', 'wait', 'read', 'close']);
    expect(calls[0]?.[0]).toBe(fy5);
    expect(calls[1]).toEqual([fy5, 'terminal', 'open', CHECK_TERMINAL, '--ferret', 'ferret-1', CHECK_COMMAND]);
  });

  test("fails when the pane reports v4's fy, and still closes the terminal", async () => {
    const { run, calls } = fake({ pane: `fy=/h/.nix-profile/bin/fy\nhome=${target}\n` });
    const result = await check(run);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('/h/.nix-profile/bin/fy');
    expect(result.problems.join(' ')).toContain('The terminal was closed');
    expect(verbs(calls).at(-1)).toBe('close');
  });

  test('fails when FY_HOME is the wrong one or unset, and when fy is not found', async () => {
    const wrong = await check(fake({ pane: `fy=${shim}\nhome=/h/.ferretry\n` }).run);
    expect(wrong.ok).toBe(false);
    expect(wrong.problems.join(' ')).toContain('FY_HOME /h/.ferretry');
    const unset = await check(fake({ pane: `fy=${shim}\nhome=\n` }).run);
    expect(unset.problems.join(' ')).toContain('FY_HOME unset');
    const nowhere = await check(fake({ pane: 'nothing here\n' }).run);
    expect(nowhere.problems.join(' ')).toContain('found fy at nowhere');
  });

  test('fails with a sentence when there is no ferret, the daemon is not answering, or open is refused', async () => {
    const none = fake({ ps: { code: 0, stdout: '[]' } });
    expect((await check(none.run)).problems.join(' ')).toContain('no ferret');
    expect(verbs(none.calls)).toEqual(['ps']);
    const junk = fake({ ps: { code: 0, stdout: 'not json' } });
    expect((await check(junk.run)).ok).toBe(false);

    const waits: number[] = [];
    const down = fake({ ps: { code: 1, stdout: '' } });
    const result = await check(down.run, async ms => {
      waits.push(ms);
    });
    expect(result.ok).toBe(false);
    expect(waits.length).toBe(14);
    expect(verbs(down.calls).filter(verb => verb === 'ps').length).toBe(15);
    // Without a sleep the daemon is asked once.
    const once = fake({ ps: { code: 1, stdout: '' } });
    await check(once.run);
    expect(once.calls.length).toBe(1);

    const refused = fake({ open: 2 });
    const opened = await check(refused.run);
    expect(opened.problems.join(' ')).toContain('refused to open a terminal');
    expect(verbs(refused.calls).at(-1)).toBe('close');
  });
});

describe('Nit D bash -ic is a login shell the start check probes', () => {
  test('LOGIN_SHELLS names bash -ic and a miss on it is reported', async () => {
    expect(LOGIN_SHELLS).toContainEqual({ shell: 'bash', flags: '-ic' });
    const target = '/p/preview';
    const run: Run = async (argv, env) => {
      if (argv[0] === 'bash' && argv[1] === '-ic') return { code: 0, stdout: '/h/.nix-profile/bin/fy\n' };
      if (argv[0] === 'bash' || argv[0] === 'zsh') return { code: 0, stdout: `${target}/bin/fy\n` };
      if (argv[1] === '__daemon-probe' && argv[2] === 'sh')
        return { code: 0, stdout: `${target}/${PREVIEW.xdgRunFolder}|unset` };
      void env;
      return { code: 1, stdout: '' };
    };
    const result = await startChecks({ target, v4Home: '/v4', callerEnv: { HOME: '/h', PATH: '/usr/bin' }, run });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('bash -ic');
  });
});

describe('Minor-1 prepare prints what it held and writes the report beside the home', () => {
  test('the summary names each held entry with its sentence, and the report file exists', async () => {
    const f = await twoHarnesses();
    try {
      const done = await prepare({
        v4Home: f.from,
        target: f.to,
        lock: { held: async () => false },
        now: () => new Date('2026-11-09T00:00:00Z'),
        home: join(f.root, 'home'),
      });
      expect(done.report?.complete).toBe(true);
      expect(done.summary).toContain('HELD OUT OF THE PREVIEW');
      expect(done.summary).toContain('ferret cx1 (Codex)');
      expect(done.summary).toContain('runtime codex-work (Codex)');
      expect(done.summary).toContain(CODEX_HELD_SENTENCE);
      expect(done.summary).not.toContain('ferret cl1');
      expect(done.summary).toContain(`report: ${f.to}.conversion-report.json`);
      expect(existsSync(`${f.to}.conversion-report.json`)).toBe(true);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('a home with nothing to hold says so', async () => {
    const f = await fixture();
    try {
      await write(f.from, 'layout-version', '2\n');
      const done = await prepare({
        v4Home: f.from,
        target: f.to,
        lock: { held: async () => false },
        now: () => new Date('2026-11-09T00:00:00Z'),
        home: join(f.root, 'home'),
      });
      expect(done.summary).toContain('HELD OUT OF THE PREVIEW: nothing');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe('Minor-2 Codex ferrets and routes are held in the preview', () => {
  test('a Codex ferret is held and listed, a Claude ferret is carried', async () => {
    const f = await twoHarnesses();
    try {
      const report = await ferretsStep.run(previewCtx(f));
      expect(existsSync(join(f.to, 'state/ferrets/cl1/ferret.json'))).toBe(true);
      expect(existsSync(join(f.to, 'state/ferrets/cx1/ferret.json'))).toBe(false);
      const held = report.notCarried.filter(item => item.why === CODEX_HELD_SENTENCE).map(item => item.what);
      expect(held).toEqual(['ferret cx1 (Codex)']);
      expect(JSON.stringify(report.kept)).toContain('"count":1');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('a Claude-harness ferret on a held runtime is held by the runtime name', async () => {
    const f = await twoHarnesses();
    try {
      await f.session('odd', { agent: 'codex-work', harness: 'claude' });
      const report = await ferretsStep.run(previewCtx(f));
      expect(existsSync(join(f.to, 'state/ferrets/odd/ferret.json'))).toBe(false);
      expect(report.notCarried.map(item => item.what)).toContain('ferret odd (on the held runtime codex-work)');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('without the preview every ferret is carried', async () => {
    const f = await twoHarnesses();
    try {
      await ferretsStep.run(f.ctx());
      expect(existsSync(join(f.to, 'state/ferrets/cx1/ferret.json'))).toBe(true);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('a pack run and a guide suggestion that route to a held runtime are held and listed', async () => {
    const f = await twoHarnesses();
    try {
      const RUN = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
      const KEEP = '1a1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
      await write(
        f.from,
        'config/models-guide.yaml',
        `prompt: choose well\nsuggested:\n  by: m\n  via: codex-work\n  at: "${AT}"\n`,
      );
      for (const [id, runtime] of [
        [RUN, 'codex-work'],
        [KEEP, 'claude-work'],
      ] as const)
        await f.put(`state/pack-guide/${id}/run.json`, {
          job: { id, session: 'f9', name: 'Clean up', runtime, startedAt: AT, status: 'running' },
        });
      const report = await packsStep.run(previewCtx(f));
      const held = report.notCarried.filter(item => item.why === CODEX_HELD_SENTENCE).map(item => item.what);
      expect(held.some(what => what.includes('names the held runtime codex-work') && what.includes(RUN))).toBe(true);
      expect(held.some(what => what.includes('suggested (routes to the held runtime codex-work)'))).toBe(true);
      expect(held.some(what => what.includes(KEEP))).toBe(false);
      const written = existsSync(join(f.to, 'config/packs.yaml'))
        ? await readFile(join(f.to, 'config/packs.yaml'), 'utf8')
        : '';
      expect(written).not.toContain('codex-work');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe('Minor-3 the Codex settings item reads the preview environment when the switch is on', () => {
  test('buildPlan with the switch injected on writes shell_environment_policy.set equal to the env map', async () => {
    const f = await fixture();
    try {
      const ctx = previewCtx(f);
      const plan = await buildPlan(ctx, true);
      const codexPath = (path: string) => path.includes('codex') && path.includes(PREVIEW_SETTINGS_ITEM);
      const codex = [...plan.files.entries()].find(([path]) => codexPath(path));
      expect(codex).toBeDefined();
      const document = parseYaml(String(codex?.[1].document));
      expect(document.settings.shell_environment_policy.set).toEqual(previewShellEnv(f.to, PREVIEW.port));
      // The switch off (the shipped value) writes no Codex item.
      const off = await buildPlan(ctx);
      expect([...off.files.keys()].some(codexPath)).toBe(false);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe('Nit A copyOne keeps ENOENT for a source that is gone', () => {
  test('a removed sqlite source rejects with code ENOENT', async () => {
    const home = join(root, 'home');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'a.sqlite'), 'x');
    const { Database } = await import('bun:sqlite');
    const db = new Database(join(home, 'b.sqlite'));
    db.run('create table t (x)');
    db.close();
    await rm(join(home, 'b.sqlite'));
    const error = await copyOne(home, join(root, 'staging'), 'b.sqlite').then(
      () => undefined,
      e => e as NodeJS.ErrnoException,
    );
    expect(error?.code).toBe('ENOENT');
  });

  test('a sqlite file that vanishes after the look is refused with its code kept', async () => {
    const home = join(root, 'home2');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'c.sqlite'), 'not a database');
    const error = await copyOne(home, join(root, 'staging2'), 'c.sqlite').then(
      () => undefined,
      e => e as Error,
    );
    expect(error?.message).toContain('c.sqlite was refused');
    expect((error as NodeJS.ErrnoException).code).toBeUndefined();
  });
});

describe('Nit C a sidecar that vanishes is a torn try inside the same budget', () => {
  const database = async (path: string) => {
    const { Database } = await import('bun:sqlite');
    const db = new Database(path);
    db.run('create table t (x)');
    db.run('insert into t values (1)');
    db.close();
  };
  const enoent = () => Object.assign(new Error('gone'), { code: 'ENOENT' });

  test('ENOENT on the first sidecar copy is retried and the copy succeeds', async () => {
    const from = join(root, 'a.sqlite');
    await database(from);
    await writeFile(`${from}-journal`, '');
    const attempts: number[] = [];
    let calls = 0;
    await copySqlite(from, join(root, 'out.sqlite'), {
      onAttempt: attempt => attempts.push(attempt),
      copySidecar: async () => {
        calls++;
        if (calls === 1) throw enoent();
      },
    });
    expect(attempts).toEqual([1, 2]);
    expect(existsSync(join(root, 'out.sqlite'))).toBe(true);
  });

  test('ENOENT on every try fails within three tries, and any other error is thrown at once', async () => {
    const from = join(root, 'b.sqlite');
    await database(from);
    await writeFile(`${from}-journal`, '');
    const attempts: number[] = [];
    const message = await copySqlite(from, join(root, 'out2.sqlite'), {
      onAttempt: attempt => attempts.push(attempt),
      copySidecar: async () => {
        throw enoent();
      },
    }).then(
      () => '',
      error => (error as Error).message,
    );
    expect(attempts).toEqual([1, 2, 3]);
    expect(message).toContain('failed integrity_check on 3 copies');

    const other = await copySqlite(from, join(root, 'out3.sqlite'), {
      copySidecar: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
    }).then(
      () => '',
      error => (error as Error).message,
    );
    expect(other).toBe('denied');
  });
});
