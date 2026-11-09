import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { acceptedName } from '@ferretry/kernel/contract';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ownerNote, prepare, writeReport } from '../../preview/driver.ts';
import { PREVIEW } from '../../preview/plan.ts';
import { CHECK_TERMINAL, terminalCheck, terminalsFileState, type Run } from '../../preview/start-checks.ts';
import { acceptedConfigStep } from '../../src/steps/accepted-config.ts';
import { ferretsStep } from '../../src/steps/ferrets.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { previewShellEnv } from '../../src/v5/preview-env.ts';
import { fixture } from './ferret-fixture.ts';

const REPO = resolve(import.meta.dir, '../../../..');
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fy-fix7-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const write = async (base: string, path: string, text: string) => {
  await mkdir(join(base, path, '..'), { recursive: true });
  await writeFile(join(base, path), text);
};

describe('MAJOR-1 the terminal check against a fresh preview', () => {
  const target = '/p/preview';
  const shim = `${target}/bin/fy`;
  const callerEnv = { HOME: '/h', USER: 'u', PATH: '/usr/bin' };
  const verb = (argv: readonly string[]) => (argv[1] === 'terminal' ? argv[2] : argv[1]);

  const fake = (options: { ps: string; open?: number }) => {
    const calls: string[][] = [];
    const run: Run = async argv => {
      calls.push([...argv]);
      if (verb(argv) === 'ps') return { code: 0, stdout: options.ps };
      if (verb(argv) === 'open') return { code: options.open ?? 0, stdout: '' };
      if (verb(argv) === 'read') return { code: 0, stdout: `fy=${shim}\nhome=${target}\n` };
      return { code: 0, stdout: '' };
    };
    return { run, calls };
  };

  test('lists every record with ps -a, and a fake whose only ferret is stopped passes', async () => {
    const { run, calls } = fake({ ps: JSON.stringify([{ id: 'only-one', state: 'stopped' }]) });
    const result = await terminalCheck({ target, v4Home: '/v4', callerEnv, run });
    expect(result.ok).toBe(true);
    expect(calls[0]?.slice(1)).toEqual(['ps', '-a', '--json']);
    expect(calls[1]?.slice(2, 6)).toEqual(['open', CHECK_TERMINAL, '--ferret', 'only-one']);
  });

  const files = (over: { yaml?: string; accepted?: string | null }) => {
    const env = previewShellEnv(target, PREVIEW.port);
    const yaml =
      over.yaml ??
      `environment:\n${Object.entries(env)
        .map(([k, v]) => `  ${k}: "${v}"`)
        .join('\n')}\n`;
    const accepted =
      over.accepted === undefined
        ? JSON.stringify({ format: 1, etag: sha256(yaml), text: yaml, plugin: 'terminals' })
        : over.accepted;
    return async (path: string): Promise<string | undefined> =>
      path === join(target, 'config/terminals.yaml')
        ? yaml
        : path === join(target, `state/kernel/accepted-config/${acceptedName('terminals.yaml')}.json`)
          ? (accepted ?? undefined)
          : undefined;
  };

  test('with no ferret record it proves the file live, and says the live proof runs on the next terminal-check', async () => {
    const { run, calls } = fake({ ps: '[]' });
    const result = await terminalCheck({ target, v4Home: '/v4', callerEnv, run, readText: files({}) });
    expect(result.ok).toBe(true);
    expect(result.passed.join(' ')).toContain('next preview.sh terminal-check');
    expect(calls.map(call => verb(call))).toEqual(['ps']);
  });

  test('with no ferret record, a held, invalid, wrong or missing terminals.yaml is a miss that names its state', async () => {
    const miss = async (readText: (path: string) => Promise<string | undefined>) =>
      (await terminalCheck({ target, v4Home: '/v4', callerEnv, run: fake({ ps: '[]' }).run, readText })).problems.join(
        ' ',
      );
    expect(await miss(files({ accepted: null }))).toContain('is held');
    // 5.0 has no `fy config` verb: the sentence names the app's Confirm, never a command that does not exist.
    expect(await miss(files({ accepted: null }))).toContain('Settings, configuration file, Confirm');
    expect(await miss(files({ accepted: null }))).not.toContain('config confirm');
    expect(await miss(files({ yaml: 'environment:\n  PATH: /evil\n' }))).toContain('is invalid');
    expect(await miss(files({ yaml: 'environment:\n  A: "1"\n' }))).toContain('not the preview');
    expect(await miss(files({ accepted: null }))).toContain('prepare --owner');
    expect(await miss(async () => undefined)).toContain('is missing');
    const wrongText = 'environment:\n  A: "1"\n';
    const wrong = files({
      yaml: wrongText,
      accepted: JSON.stringify({ format: 1, etag: sha256(wrongText), text: wrongText, plugin: 'terminals' }),
    });
    expect((await terminalsFileState(target, wrong)).state).toBe('wrong');
  });

  test('a record the kernel would not read is held: a format other than 1, or an etag that is not the text', async () => {
    const env = previewShellEnv(target, PREVIEW.port);
    const yaml = `environment:\n${Object.entries(env)
      .map(([k, v]) => `  ${k}: "${v}"`)
      .join('\n')}\n`;
    for (const record of [
      { format: 2, etag: sha256(yaml), text: yaml, plugin: 'terminals' },
      { format: 1, etag: 'x', text: yaml, plugin: 'terminals' },
    ])
      expect((await terminalsFileState(target, files({ accepted: JSON.stringify(record) }))).state).toBe('held');
  });

  test('no sentence tells the owner to start a ferret first', async () => {
    const down: Run = async () => ({ code: 1, stdout: '' });
    const none = await terminalCheck({ target, v4Home: '/v4', callerEnv, run: down });
    expect(none.problems.join(' ')).not.toMatch(/start a (claude )?ferret/iu);
    const noFile = await terminalCheck({ target, v4Home: '/v4', callerEnv, run: fake({ ps: '[]' }).run });
    expect(noFile.problems.join(' ')).not.toMatch(/start a (claude )?ferret/iu);
  });

  test('a miss on the pane names the file state instead of "check environment"', async () => {
    const run: Run = async argv =>
      verb(argv) === 'read'
        ? { code: 0, stdout: 'fy=/h/.nix-profile/bin/fy\nhome=\n' }
        : { code: 0, stdout: verb(argv) === 'ps' ? '[{"id":"f"}]' : '' };
    const result = await terminalCheck({ target, v4Home: '/v4', callerEnv, run, readText: files({ accepted: null }) });
    expect(result.ok).toBe(false);
    const sentence = result.problems.join(' ');
    expect(sentence).toContain('is held');
    expect(sentence).not.toContain('Check `environment`');
  });

  test('Nit 2: a refused open closes nothing, and a successful one closes the terminal it opened', async () => {
    const refused = fake({ ps: '[{"id":"f"}]', open: 1 });
    expect((await terminalCheck({ target, v4Home: '/v4', callerEnv, run: refused.run })).ok).toBe(false);
    expect(refused.calls.map(call => verb(call))).toEqual(['ps', 'open']);
    const good = fake({ ps: '[{"id":"f"}]' });
    await terminalCheck({ target, v4Home: '/v4', callerEnv, run: good.run });
    expect(good.calls.map(call => verb(call)).at(-1)).toBe('close');
  });
});

describe('MAJOR-2 the preview records its own files as accepted', () => {
  const previewCtx = (f: Awaited<ReturnType<typeof fixture>>, owner = true) => ({
    ...f.ctx(),
    preview: true,
    ...(owner ? { previewOwner: true } : {}),
    previewV4Home: f.from,
    previewShellEnv: previewShellEnv(f.to, PREVIEW.port),
  });

  test('a v4 home with one unaccepted config file still yields an accepted terminals.yaml, and a boot puts it in effect', async () => {
    const f = await fixture();
    try {
      await write(f.from, 'config/limits.yaml', 'enabled: true\n');
      const ctx = previewCtx(f);
      expect((await settingsStep.run(ctx)).status).toBe('converted');
      const report = await acceptedConfigStep.run(ctx);
      expect(report.notCarried.map(item => item.what).join('\n')).toContain('limits.yaml');
      expect(JSON.stringify(report.kept)).toContain('"count":2');

      const dir = join(f.to, 'state/kernel/accepted-config');
      const recordPath = join(dir, `${acceptedName('terminals.yaml')}.json`);
      const record = JSON.parse(await readFile(recordPath, 'utf8')) as { text: string; plugin: string };
      expect(record.plugin).toBe('terminals');
      expect(record.text).toBe(await readFile(join(f.to, 'config/terminals.yaml'), 'utf8'));
      // limits.yaml, which v4 had not accepted, stays unrecorded; the preview's Claude settings item is recorded.
      await expect(stat(join(dir, `${acceptedName('limits.yaml')}.json`))).rejects.toThrow();
      const settings = acceptedName('claude-code/settings/fy-preview.yaml');
      expect(JSON.parse(await readFile(join(dir, `${settings}.json`), 'utf8')).plugin).toBe('claude-code');

      // A boot-style evaluate on the real config service with the real def.
      // Run in a subprocess that imports nothing from this tool (the converter is outside the workspace), over the
      // converter's own output on disk.
      const script = join(f.root, 'boot-evaluate.ts');
      await writeFile(
        script,
        `
const [repo, home] = process.argv.slice(2);
const { config, state } = await import(repo + '/packages/core/kernel/host/index.ts');
const { fixedClock } = await import(repo + '/packages/core/kernel/testing/index.ts');
const manifest = (await import(repo + '/packages/plugins/terminals/manifest.ts')).default;
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };
const [def] = manifest.data.config;
const files = config.createConfigFiles({
  home, fs: state.createNodeHostFs(), clock: fixedClock('2026-11-09T09:00:00.000Z'), log: quiet, binary: 'fy',
  defs: [{ plugin: 'terminals', def }], judge: () => false,
});
await files.reload();
const port = files.port('terminals');
console.log(JSON.stringify({ state: port.fileState(def).state, environment: port.file(def)?.environment }));
`,
      );
      const child = Bun.spawn(['bun', script, REPO, f.to], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' });
      const [text, error] = [await new Response(child.stdout).text(), await new Response(child.stderr).text()];
      expect({ code: await child.exited, error }).toEqual({ code: 0, error: '' });
      expect(JSON.parse(text)).toEqual({ state: 'valid', environment: previewShellEnv(f.to, PREVIEW.port) });
    } finally {
      await f.clean();
    }
  });

  test('without the owner flag nothing of the preview is recorded, and prepare names both files and the confirm step', async () => {
    const f = await fixture();
    try {
      await write(f.from, 'config/limits.yaml', 'enabled: true\n');
      const ctx = previewCtx(f, false);
      expect((await settingsStep.run(ctx)).status).toBe('converted');
      await acceptedConfigStep.run(ctx);
      await expect(stat(join(f.to, 'state/kernel/accepted-config'))).rejects.toThrow();

      const note = ownerNote(false);
      expect(note).toContain('config/terminals.yaml');
      expect(note).toContain('config/claude-code/settings/fy-preview.yaml');
      expect(note).toContain('Settings, configuration file, Confirm');
      expect(note).not.toContain('config confirm');
      expect(note).toContain('--owner');
      expect(ownerNote(true)).toContain('recorded as accepted');
    } finally {
      await f.clean();
    }
  });

  test('prepare prints the note for the flag it was given', async () => {
    for (const owner of [false, true]) {
      const f = await fixture();
      try {
        await write(f.from, 'layout-version', '2\n');
        const done = await prepare({
          v4Home: f.from,
          target: f.to,
          lock: { held: async () => false },
          now: () => new Date('2026-11-09T00:00:00Z'),
          home: join(f.root, 'home'),
          ...(owner ? { owner: true } : {}),
        });
        expect(done.summary).toContain(owner ? 'recorded as accepted (--owner)' : 'NOT ACCEPTED (no --owner)');
        // A record for either preview file exists only with the owner's flag: without it the record is ABSENT.
        const dir = join(f.to, 'state/kernel/accepted-config');
        for (const name of ['terminals.yaml', 'claude-code/settings/fy-preview.yaml']) {
          const text = await readFile(join(dir, `${acceptedName(name)}.json`), 'utf8').catch(() => undefined);
          if (owner)
            expect(JSON.parse(text ?? 'null').plugin).toBe(name === 'terminals.yaml' ? 'terminals' : 'claude-code');
          else expect(text).toBeUndefined();
        }
      } finally {
        await f.clean();
      }
    }
  });

  test('a home whose v4 files were held and not a preview run records nothing', async () => {
    const f = await fixture();
    try {
      await write(f.from, 'config/limits.yaml', 'enabled: true\n');
      const ctx = f.ctx();
      expect((await settingsStep.run(ctx)).status).toBe('converted');
      await acceptedConfigStep.run(ctx);
      await expect(stat(join(f.to, 'state/kernel/accepted-config'))).rejects.toThrow();
    } finally {
      await f.clean();
    }
  });

  const previewRecords = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const dir = join(f.to, 'state/kernel/accepted-config');
    return {
      terminals: await stat(join(dir, `${acceptedName('terminals.yaml')}.json`)).then(
        () => true,
        () => false,
      ),
      settings: await stat(join(dir, `${acceptedName('claude-code/settings/fy-preview.yaml')}.json`)).then(
        () => true,
        () => false,
      ),
    };
  };

  test('MAJOR-1 no flag, every v4 file in effect: neither preview file has a record', async () => {
    const f = await fixture();
    try {
      const text = 'enabled: true\n';
      await write(f.from, 'config/limits.yaml', text);
      await write(
        f.from,
        'state/config-accepted.json',
        JSON.stringify({ 'limits.yaml': { etag: sha256(text), text } }),
      );
      const ctx = previewCtx(f, false);
      expect((await settingsStep.run(ctx)).status).toBe('converted');
      const report = await acceptedConfigStep.run(ctx);
      expect(JSON.stringify(report.kept)).toContain('v4 config files in effect as written');
      expect(await previewRecords(f)).toEqual({ terminals: false, settings: false });
    } finally {
      await f.clean();
    }
  });

  test('MAJOR-1 no flag, no v4 config files: neither preview file has a record; with the flag both do', async () => {
    for (const owner of [false, true]) {
      const f = await fixture();
      try {
        const ctx = previewCtx(f, owner);
        expect((await settingsStep.run(ctx)).status).toBe('converted');
        const report = await acceptedConfigStep.run(ctx);
        expect(await previewRecords(f)).toEqual({ terminals: owner, settings: owner });
        // The report counts only the files actually recorded.
        const recorded = report.kept.find(item => item.what === 'v5 config files recorded as accepted')?.count;
        // The two files the preview forces tight (limits.yaml, runtimes.yaml) are recorded either way; the preview's two
        // are the flag's.
        expect(recorded).toBe(owner ? 4 : 2);
      } finally {
        await f.clean();
      }
    }
  });
});

describe('Minor-3 a miss in preview.sh start stops the daemon it just started, and says so', () => {
  const script = join(import.meta.dir, '../../preview/preview.sh');

  /** A fake `bun` that records its arguments and fails `terminal-check`, and a fake `fy5` that succeeds. */
  const start = async (stopCode: number) => {
    const bin = join(root, 'fakebin');
    const target = join(root, 'v5');
    const log = join(root, 'bun.log');
    await mkdir(bin, { recursive: true });
    await mkdir(join(target, 'bin'), { recursive: true });
    await writeFile(
      join(bin, 'bun'),
      [
        '#!/bin/sh',
        'echo "$@" >> "$FAKE_LOG"',
        'case "$2" in',
        '  guard) printf "%s\\n%s\\n" "$FAKE_V4" "$FAKE_TARGET" ;;',
        '  terminal-check) exit 1 ;;',
        '  stop) exit "$FAKE_STOP_CODE" ;;',
        '  *) exit 0 ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    await writeFile(join(target, 'bin', 'fy5'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const result = Bun.spawnSync([script, 'start', '--v4', join(root, 'v4'), '--target', target], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: root,
        FAKE_LOG: log,
        FAKE_V4: join(root, 'v4'),
        FAKE_TARGET: target,
        FAKE_STOP_CODE: String(stopCode),
      },
    });
    const calls = (await readFile(log, 'utf8'))
      .split('\n')
      .filter(line => line !== '')
      .map(line => line.split(' ')[1]);
    return { result, calls };
  };

  test('the daemon is stopped, the sentence says it was, and the exit is 1', async () => {
    const { result, calls } = await start(0);
    expect(calls).toContain('terminal-check');
    expect(calls.at(-2)).toBe('terminal-check');
    expect(calls.at(-1)).toBe('stop');
    expect(calls).toContain('stop');
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('the preview daemon was stopped because the terminal proof failed');
  });

  test('when stop itself fails the sentence says the daemon could not be stopped and names the command', async () => {
    const { result, calls } = await start(1);
    expect(calls).toContain('stop');
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('could not be stopped');
    expect(result.stderr.toString()).toContain("preview.sh stop' now");
  });
});

describe('Nit 3 the report is written as a new file, and never through a link', () => {
  test('a stale plain file is replaced with mode 0600; a link is refused and its target untouched', async () => {
    const path = join(root, 'v5.conversion-report.json');
    await writeFile(path, 'old', { mode: 0o644 });
    await writeReport(path, 'new');
    expect(await readFile(path, 'utf8')).toBe('new');
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const elsewhere = join(root, 'elsewhere.txt');
    await writeFile(elsewhere, 'precious');
    const link = join(root, 'linked.conversion-report.json');
    await symlink(elsewhere, link);
    await expect(writeReport(link, 'x')).rejects.toThrow('not a plain file');
    expect(await readFile(elsewhere, 'utf8')).toBe('precious');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });
});

describe('Nit 4 a dangling parent is said in the report', () => {
  test('a carried Claude helper whose lead was held names the dangling parent', async () => {
    const f = await fixture();
    try {
      await write(f.from, 'layout-version', '2\n');
      await write(f.from, 'config/runtimes/claude-work.yaml', 'credential: c\nprofile: main\nharness: claude\n');
      await write(f.from, 'config/runtimes/codex-work.yaml', 'credential: x\nprofile: main\nharness: codex\n');
      await write(f.from, 'config/profiles/main.yaml', 'contents: []\n');
      await f.session('lead1', { agent: 'codex-work', harness: 'codex' });
      await f.session('help1', { agent: 'claude-work', harness: 'claude', parent: 'lead1' });
      const report = await ferretsStep.run({
        ...f.ctx(),
        preview: true,
        previewV4Home: f.from,
        previewShellEnv: previewShellEnv(f.to, PREVIEW.port),
      });
      const what = report.notCarried.map(item => item.what);
      expect(what).toContain('ferret help1 (a helper whose parent lead1 is held out of the preview)');
    } finally {
      await f.clean();
    }
  });
});
