import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { link, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { readLoginHarnesses } from '../../preview/harness-map.ts';
import { PREVIEW } from '../../preview/plan.ts';
import { convert } from '../../src/convert.ts';
import { acceptedConfigStep } from '../../src/steps/accepted-config.ts';
import { previewProfileScopes, runtimeHarnessOf } from '../../src/steps/preview-hold.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { parseV4Yaml, quietYaml, YAML_OPTIONS } from '../../src/v4/config.ts';
import { v4Paths } from '../../src/v4/layout.ts';
import { previewShellEnv } from '../../src/v5/preview-env.ts';
import { captured } from './capture.ts';
import { fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const FAKE_KEY = 'sk-ant-FAKE-0000-not-a-real-key';
const put = async (path: string, text: string) => {
  await mkdir(join(f.from, path, '..'), { recursive: true });
  await writeFile(join(f.from, path), text);
};
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const nested = (inner: string, times: number): string => `[${Array.from({ length: times }, () => inner).join(', ')}]`;
const HOSTILE: Record<string, string> = {
  'an unresolved alias': `harness: claude\nK: *${FAKE_KEY}\n`,
  'an unknown tag': `harness: claude\nANTHROPIC_API_KEY: !weird ${FAKE_KEY}\n`,
  'a list used as a key': `harness: claude\nenv:\n  ? [${FAKE_KEY}]\n  : x\n`,
  'a duplicate key': `harness: claude\nK: ${FAKE_KEY}\nK: other\n`,
  'a bad indent': `harness: claude\nenv:\n  A: 1\n B: ${FAKE_KEY}\n`,
  'an alias bomb': [
    'harness: claude',
    `a: &a [${FAKE_KEY}, ${FAKE_KEY}]`,
    `b: &b ${nested('*a', 10)}`,
    `c: &c ${nested('*b', 10)}`,
    `d: &d ${nested('*c', 10)}`,
    `e: ${nested('*d', 10)}`,
    '',
  ].join('\n'),
};

describe('M1: a login file read says nothing, whatever it holds', () => {
  for (const [name, text] of Object.entries(HOSTILE)) {
    test(`${name}: the harness map prints nothing and keeps nothing`, async () => {
      await put('config/logins/hostile.yaml', text);
      let found: Awaited<ReturnType<typeof readLoginHarnesses>> | undefined;
      const output = await captured(async () => {
        found = await readLoginHarnesses(f.from);
      });
      expect(output).not.toContain(FAKE_KEY);
      expect(output).toBe('');
      expect(JSON.stringify([...(found ?? [])])).not.toContain('FAKE');
      // A list key and an alias bomb are valid YAML (the library only warns or refuses when turned into data, which
      // is never done here): they may be read for their harness. The rest have an error or a warning.
      if (!['an alias bomb', 'a list used as a key', 'an unresolved alias'].includes(name))
        expect(found?.has('hostile')).toBe(false);
    });

    test(`${name}: the accepted-config step prints nothing (a login in the record and on disk)`, async () => {
      await put('layout-version', '2\n');
      await put('config/logins/hostile.yaml', text);
      await put(
        'state/config-accepted.json',
        JSON.stringify({
          'logins/hostile.yaml': { etag: sha256('older'), text: `${text}budget:\n  daily:\n    hard: 1\n` },
        }),
      );
      const thrown: string[] = [];
      const output = await captured(() =>
        convert({
          from: f.from,
          to: f.to,
          dryRun: false,
          lock: { held: async () => false },
          now: () => new Date('2026-11-09T00:00:00Z'),
          host: { homeDirectory: f.root, env: {} },
          steps: [settingsStep, acceptedConfigStep],
          preview: true,
          previewV4Home: f.from,
          previewShellEnv: previewShellEnv(f.to, PREVIEW.port),
        }).then(
          result => thrown.push(JSON.stringify(result)),
          (error: unknown) => thrown.push(error instanceof Error ? error.message : String(error)),
        ),
      );
      expect(output).not.toContain(FAKE_KEY);
      // Nothing thrown or reported names the text either.
      expect(thrown.join('\n')).not.toContain('FAKE');
    });
  }
});

describe('m2: the harness map opens files as safely as the rest of the converter', () => {
  const OK = 'harness: claude\n';
  test('a symlinked login file, a hard-linked one and a linked logins folder are refused', async () => {
    await put('config/logins/real.yaml', OK);
    await symlink(join(f.from, 'config/logins/real.yaml'), join(f.from, 'config/logins/sym.yaml'));
    await link(join(f.from, 'config/logins/real.yaml'), join(f.from, 'config/logins/hard.yaml'));
    // `real` and `hard` are now one inode with two names: neither is a single-name file.
    expect([...(await readLoginHarnesses(f.from)).keys()]).toEqual([]);
    await put('other/solo.yaml', OK);
    await mkdir(join(f.root, 'v4b/config'), { recursive: true });
    await symlink(join(f.from, 'other'), join(f.root, 'v4b/config/logins'));
    expect((await readLoginHarnesses(join(f.root, 'v4b'))).size).toBe(0);
  });

  test('a FIFO named x.yaml is refused and does not hang', async () => {
    await mkdir(join(f.from, 'config/logins'), { recursive: true });
    const made = Bun.spawnSync(['mkfifo', join(f.from, 'config/logins/x.yaml')]);
    expect(made.exitCode).toBe(0);
    await put('config/logins/ok.yaml', OK);
    const found = await Promise.race([
      readLoginHarnesses(f.from),
      new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 5000)),
    ]);
    expect(found).not.toBe('hung');
    expect([...(found as Map<string, unknown>).keys()]).toEqual(['ok']);
  });
});

describe('m3: a login that drives both CLIs is decided by the runtime profile, as in v4', () => {
  const BOTH = 'harness: claude\nstore: environment\nclaude:\n  env: {}\ncodex:\n  env: {}\n';
  const setup = async () => {
    await put('layout-version', '2\n');
    await put('config/logins/dual.yaml', BOTH);
    await put('config/logins/dual-cx.yaml', BOTH.replace('harness: claude', 'harness: codex'));
    await put('config/logins/one-half.yaml', 'harness: codex\nstore: environment\ncodex:\n  env: {}\n');
    await put('config/components/instructions/c-only.yaml', 'file: a.md\nharness: claude\n');
    await put('config/components/instructions/x-only.yaml', 'file: b.md\nharness: codex\n');
    await put('config/components/instructions/plain.yaml', 'file: c.md\n');
    await put('config/components/modelSets/ms.yaml', 'models: [m-a]\ndefault: m-a\n');
    await put('config/profiles/cl.yaml', 'contents:\n  - instructions/c-only\n  - instructions/plain\n');
    await put('config/profiles/cx.yaml', 'contents:\n  - instructions/x-only\n');
    await put('config/profiles/gen.yaml', 'contents:\n  - instructions/plain\n');
    await put('config/profiles/mixed.yaml', 'contents:\n  - instructions/c-only\n  - instructions/x-only\n');
    await put('config/profiles/ms.yaml', 'contents:\n  - instructions/c-only\n  - modelSets/ms\n');
    await put('config/profiles/via.yaml', 'contents:\n  - profile/cl\n');
    await put('config/profiles/ms-only.yaml', 'contents:\n  - modelSets/ms\n');
    await put('config/profiles/ms-cx.yaml', 'contents:\n  - instructions/x-only\n  - modelSets/ms\n');
    await put('config/profiles/ms-via.yaml', 'contents:\n  - profile/ms\n');
    const ctx = { v4: v4Paths(f.from), previewLoginHarnesses: await readLoginHarnesses(f.from) };
    return { ctx, scopes: await previewProfileScopes(ctx) };
  };

  test('a profile scoped to one CLI decides; generic, mixed or unsure profiles do not', async () => {
    const { ctx, scopes } = await setup();
    const on = (login: string, profile: string) => runtimeHarnessOf(ctx, undefined, login, scopes.get(profile));
    expect(on('dual', 'cl')).toBe('claude-code');
    expect(on('dual', 'via')).toBe('claude-code');
    expect(on('dual', 'cx')).toBe('codex');
    // Generic, mixed, or no profile: v4 falls back to the login's own harness (claude here, codex on `dual-cx`).
    expect(on('dual', 'gen')).toBe('claude-code');
    expect(on('dual', 'mixed')).toBe('claude-code');
    expect(runtimeHarnessOf(ctx, undefined, 'dual', undefined)).toBe('claude-code');
    expect(on('dual-cx', 'gen')).toBe('codex');
    expect(on('dual-cx', 'mixed')).toBe('codex');
    expect(runtimeHarnessOf(ctx, undefined, 'dual-cx', undefined)).toBe('codex');
    // A scoped profile still beats the login's harness.
    expect(on('dual-cx', 'cl')).toBe('claude-code');
    expect(on('dual', 'cx')).toBe('codex');
    // Held: a model set without a harness and nothing else saying which CLI (v4 scopes it by model ids this tool does
    // not copy).
    expect(on('dual', 'ms-only')).toBe('both');
    expect(on('dual-cx', 'ms-only')).toBe('both');
    expect([...scopes.entries()].sort()).toEqual([
      ['cl', 'claude'],
      ['cx', 'codex'],
      ['gen', 'generic'],
      ['mixed', 'generic'],
      ['ms', 'unsure-claude'],
      ['ms-cx', 'unsure-codex'],
      ['ms-only', 'unsure'],
      ['ms-via', 'unsure-claude'],
      ['via', 'claude'],
    ]);
  });

  test('c: a profile scoped to the login’s own CLI that also has a harness-less model set picks that CLI, as v4 does', async () => {
    const { ctx, scopes } = await setup();
    const on = (login: string, profile: string) => runtimeHarnessOf(ctx, undefined, login, scopes.get(profile));
    // claude layers + model set, on a login whose own harness is claude: the model set agrees or makes it mixed → claude.
    expect(on('dual', 'ms')).toBe('claude-code');
    expect(on('dual', 'ms-via')).toBe('claude-code');
    // codex layers + model set, on a login whose own harness is codex.
    expect(on('dual-cx', 'ms-cx')).toBe('codex');
    // The other CLI's login cannot tell: the model set may say the profile is codex-scoped, which then wins. Held.
    expect(on('dual-cx', 'ms')).toBe('both');
    expect(on('dual', 'ms-cx')).toBe('both');
  });

  test('a login with one half, or none, keeps its own harness whatever the profile says; a runtime harness wins', async () => {
    const { ctx, scopes } = await setup();
    // v4 checks the login first (scope.ts:205-217) and returns nothing for a login that does not exist; but v4's schema
    // refuses such a runtime, so no booted home has one, and an unreadable login (missing from the stage map) does
    // exist in v4, where the runtime's own harness is returned. This returns the runtime's own harness first (n5).
    expect(runtimeHarnessOf(ctx, 'claude', 'no-such-login', undefined)).toBe('claude-code');
    expect(runtimeHarnessOf(ctx, 'codex', undefined, undefined)).toBe('codex');
    expect(runtimeHarnessOf(ctx, undefined, 'one-half', scopes.get('cl'))).toBe('codex');
    expect(runtimeHarnessOf(ctx, 'claude', 'dual', scopes.get('cx'))).toBe('claude-code');
    expect(runtimeHarnessOf(ctx, undefined, 'no-such-login', scopes.get('cl'))).toBe('unknown');
  });
});

describe('n1/n2: the silent reader turns a document into data without printing or naming the text', () => {
  for (const [name, text] of Object.entries(HOSTILE)) {
    test(`${name}: quietYaml, parseV4Yaml().toJS() and a raw toJS print nothing, and quietYaml throws one fixed message`, async () => {
      let thrown = '';
      const output = await captured(async () => {
        try {
          quietYaml(text);
        } catch (error) {
          thrown = error instanceof Error ? error.message : String(error);
        }
        // `toJS` is where the library emits its warnings (an unresolved tag, a collection used as a key).
        for (const read of [() => parseV4Yaml('x.yaml', text).toJS(), () => parseDocument(text, YAML_OPTIONS).toJS()]) {
          try {
            read();
          } catch {
            // The thrown text of the raw library call is not what is under test; only what is printed is.
          }
        }
      });
      expect(output).toBe('');
      expect(thrown).not.toContain('FAKE');
      if (thrown !== '') expect(thrown).toBe('not valid YAML');
    });
  }

  test('an unresolved alias (K: *<FAKE>) makes quietYaml throw the fixed message, not the library one naming the alias', () => {
    expect(() => quietYaml(`K: *${FAKE_KEY}\n`)).toThrow(new Error('not valid YAML'));
  });
});

describe('m: the yaml library token dumps (LOG_TOKENS, LOG_STREAM) never reach a login file with a key in it', () => {
  const LOGIN = `harness: claude\nstore: environment\nenv:\n  ANTHROPIC_API_KEY: ${FAKE_KEY}\n`;
  const toolDir = join(import.meta.dir, '../..');
  /** Runs a real entry file as its own process, with the variable set, and returns everything it printed. */
  const spawned = (entry: string, args: string[], variable: string): string => {
    const run = Bun.spawnSync(['bun', entry, ...args], {
      cwd: toolDir,
      env: { PATH: process.env.PATH ?? '', HOME: f.root, [variable]: '1' },
    });
    return `${run.stdout.toString()}\n${run.stderr.toString()}`;
  };
  for (const variable of ['LOG_TOKENS', 'LOG_STREAM']) {
    test(`${variable}=1: the converter entry reads a login file and prints no key`, async () => {
      await put('layout-version', '2\n');
      await put('config/logins/with-key.yaml', LOGIN);
      const printed = spawned('src/main.ts', ['--from', f.from, '--to', f.to, '--dry-run'], variable);
      expect(printed).not.toContain('FAKE');
      expect(printed).toContain('dry run');
    });

    test(`${variable}=1: the preview entry reads a login file and prints no key`, async () => {
      await put('layout-version', '2\n');
      await put('config/logins/with-key.yaml', LOGIN);
      await put('config/runtimes/r.yaml', 'credential: with-key\nprofile: main\n');
      await put('config/profiles/main.yaml', 'contents: []\n');
      const printed = spawned(
        'preview/main.ts',
        ['prepare', '--v4', f.from, '--target', join(f.root, 'preview-home')],
        variable,
      );
      expect(printed).not.toContain('FAKE');
      expect(printed.length).toBeGreaterThan(1);
    });
  }
});
