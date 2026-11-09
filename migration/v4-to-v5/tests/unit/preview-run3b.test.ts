import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { link, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readLoginHarnesses } from '../../preview/harness-map.ts';
import { PREVIEW } from '../../preview/plan.ts';
import { convert } from '../../src/convert.ts';
import { acceptedConfigStep } from '../../src/steps/accepted-config.ts';
import { previewProfileScopes, runtimeHarnessOf } from '../../src/steps/preview-hold.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { v4Paths } from '../../src/v4/layout.ts';
import { previewShellEnv } from '../../src/v5/preview-env.ts';
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

/** Everything written to stdout, stderr, the console or `process.emitWarning` while `work` runs. */
async function captured(work: () => Promise<unknown>): Promise<string> {
  const seen: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const warn = process.emitWarning.bind(process);
  const consoleKeys = ['log', 'warn', 'error', 'info', 'debug'] as const;
  const saved = consoleKeys.map(key => console[key]);
  const record = (...parts: unknown[]) => {
    seen.push(parts.map(part => (part instanceof Error ? `${part.name}: ${part.message}` : String(part))).join(' '));
    return true;
  };
  process.stdout.write = record as never;
  process.stderr.write = record as never;
  process.emitWarning = record as never;
  for (const key of consoleKeys) console[key] = record as never;
  try {
    await work();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    process.emitWarning = warn;
    consoleKeys.forEach((key, index) => (console[key] = saved[index] as never));
  }
  return seen.join('\n');
}

const nested = (inner: string, times: number): string => `[${Array.from({ length: times }, () => inner).join(', ')}]`;
const HOSTILE: Record<string, string> = {
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
      if (!['an alias bomb', 'a list used as a key'].includes(name)) expect(found?.has('hostile')).toBe(false);
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
        }).catch(() => undefined),
      );
      expect(output).not.toContain(FAKE_KEY);
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
    const ctx = { v4: v4Paths(f.from), previewLoginHarnesses: await readLoginHarnesses(f.from) };
    return { ctx, scopes: await previewProfileScopes(ctx) };
  };

  test('a profile scoped to one CLI decides; generic, mixed or unsure profiles do not', async () => {
    const { ctx, scopes } = await setup();
    const on = (login: string, profile: string) => runtimeHarnessOf(ctx, undefined, login, scopes.get(profile));
    expect(on('dual', 'cl')).toBe('claude-code');
    expect(on('dual', 'via')).toBe('claude-code');
    expect(on('dual', 'cx')).toBe('codex');
    // The profile does not decide: held, with its own reason.
    expect(on('dual', 'gen')).toBe('both');
    expect(on('dual', 'mixed')).toBe('both');
    expect(on('dual', 'ms')).toBe('both');
    expect(runtimeHarnessOf(ctx, undefined, 'dual', undefined)).toBe('both');
  });

  test('a login with one half, or none, keeps its own harness whatever the profile says; a runtime harness wins', async () => {
    const { ctx, scopes } = await setup();
    expect(runtimeHarnessOf(ctx, undefined, 'one-half', scopes.get('cl'))).toBe('codex');
    expect(runtimeHarnessOf(ctx, 'claude', 'dual', scopes.get('cx'))).toBe('claude-code');
    expect(runtimeHarnessOf(ctx, undefined, 'no-such-login', scopes.get('cl'))).toBe('unknown');
  });
});
