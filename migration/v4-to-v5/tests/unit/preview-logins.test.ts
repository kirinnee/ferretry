/**
 * The preview carries each v4 login FILE as an empty, signed-out shell (`src/steps/preview-logins.ts`): harness, store,
 * label, preset and env references only. No sign-in (`fleet/credentials`) and no plain key is ever carried, `store: host`
 * becomes `store: ferretry` in the preview alone, and a Codex login stays held. Every key here is fake.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Document, parseDocument } from 'yaml';
import { heldSection, prepare } from '../../preview/driver.ts';
import { decide, DENIED } from '../../preview/plan.ts';
import { walk } from '../../preview/stage.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { loginShell } from '../../src/steps/preview-logins.ts';
import { CODEX_HELD_SENTENCE } from '../../src/steps/preview-hold.ts';
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
const everything = async (folder: string): Promise<string> => {
  const parts: string[] = [];
  for (const path of await readdir(folder, { recursive: true })) {
    const full = join(folder, path);
    if ((await stat(full)).isFile()) parts.push(await readFile(full, 'utf8').catch(() => ''));
  }
  return parts.join('\n');
};

describe('the plan', () => {
  test('a login file is copied; the sign-ins and their folder never are', () => {
    expect(decide('config/logins', true).verdict).toBe('descend');
    expect(decide('config/logins/work.yaml', false).verdict).toBe('copy');
    expect(decide('fleet/credentials', true).verdict).toBe('leave');
    expect(decide('fleet/credentials/work/.credentials.json', false).verdict).toBe('leave');
    expect(decide('fleet/credentials/work/auth.json', false).verdict).toBe('leave');
    expect(decide('fleet/homes/h1/.claude/.credentials.json', false).verdict).toBe('leave');
    expect(DENIED.some(deny => deny.pattern.test('fleet/credentials/x'))).toBe(true);
  });

  test('the walk lists the login file and nothing under fleet/credentials', async () => {
    await put('layout-version', '2\n');
    await put('config/logins/work.yaml', 'harness: claude\n');
    await put('fleet/credentials/work/.credentials.json', FAKE_KEY);
    const files = (await walk(f.from)).files.map(file => file.path);
    expect(files).toContain('config/logins/work.yaml');
    expect(files.some(path => path.startsWith('fleet/credentials'))).toBe(false);
  });
});

describe('loginShell: the fields a shell keeps', () => {
  const FULL = [
    'harness: claude',
    'store: environment',
    'label: Mine',
    'preset: zai-glm',
    'clonedFrom: x',
    'clonedFromKey: k',
    'disabled:',
    '  reason: later',
    'budget:',
    '  daily:',
    '    hard: 5',
    'cloudCredential: aws-profile:work',
    'codexProvider:',
    '  id: p',
    'env:',
    '  A: ${secret:A_KEY}',
    '  B: https://api.example.com',
    'claude:',
    '  env:',
    '    C: ${secret:C_KEY}',
    '  codexProvider:',
    '    id: p',
    'codex:',
    '  env:',
    '    D: ${secret:D_KEY}',
    '',
  ].join('\n');

  test('harness, store, label, preset and env (and a half’s env) stay; everything else is named and dropped', () => {
    const document = parseDocument(FULL);
    const shell = loginShell(document, false);
    expect(shell.kind).toBe('carried');
    const kept = document.toJS() as Record<string, unknown>;
    expect(Object.keys(kept).sort()).toEqual(['claude', 'codex', 'env', 'harness', 'label', 'preset', 'store']);
    expect(kept.claude).toEqual({ env: { C: '${secret:C_KEY}' } });
    expect(shell.kind === 'carried' ? [...shell.removed].sort() : []).toEqual(
      [
        'budget',
        'claude.codexProvider',
        'clonedFrom',
        'clonedFromKey',
        'cloudCredential',
        'codexProvider',
        'disabled',
      ].sort(),
    );
  });

  test('while Codex is held, the codex half goes and a Codex login is not carried', () => {
    const document = parseDocument(FULL);
    loginShell(document, true);
    expect(Object.keys(document.toJS() as object)).not.toContain('codex');
    expect(loginShell(parseDocument('harness: codex\n'), true)).toEqual({ kind: 'held', harness: 'codex' });
    expect(loginShell(parseDocument('store: host\n'), true)).toEqual({ kind: 'held', harness: 'unknown' });
    expect(loginShell(new Document('text'), false)).toEqual({ kind: 'held', harness: 'unknown' });
  });

  test('store: host becomes store: ferretry, and nothing else changes the store', () => {
    const host = parseDocument('harness: claude\nstore: host\n');
    expect(loginShell(host, true)).toMatchObject({ kind: 'carried', storeMoved: true });
    expect(host.get('store')).toBe('ferretry');
    const env = parseDocument('harness: claude\nstore: environment\n');
    expect(loginShell(env, true)).toMatchObject({ storeMoved: false });
    expect(env.get('store')).toBe('environment');
  });
});

describe('a prepared preview', () => {
  const home = async () => {
    await put('layout-version', '2\n');
    await put(
      'config/logins/claude-you.yaml',
      'harness: claude\nstore: host\nlabel: Me\nbudget:\n  daily:\n    hard: 20\n',
    );
    await put(
      'config/logins/glm-a.yaml',
      `harness: claude\nstore: environment\npreset: zai-glm\nenv:\n  ANTHROPIC_AUTH_TOKEN: \${secret:GLM_KEY}\n  ANTHROPIC_API_KEY: ${FAKE_KEY}\n`,
    );
    await put('config/logins/codex-login.yaml', 'harness: codex\nstore: ferretry\n');
    await put('fleet/credentials/claude-you/.credentials.json', `{"token":"${FAKE_KEY}"}`);
    await put('config/profiles/main.yaml', 'contents: []\n');
    await put('config/runtimes/claude-default.yaml', 'credential: claude-you\nprofile: main\n');
    await put('config/runtimes/glm-a.yaml', 'credential: glm-a\nprofile: main\n');
    await put('config/runtimes/codex-main.yaml', 'credential: codex-login\nprofile: main\n');
  };
  const prepared = () =>
    prepare({
      v4Home: f.from,
      target: f.to,
      lock: { held: async () => false },
      now: () => new Date('2026-11-09T00:00:00Z'),
      home: join(f.root, 'home'),
    });

  test('the shells are carried signed out; no credential path or value, and no plain key, is carried', async () => {
    await home();
    const done = await prepared();
    expect(done.report?.complete).toBe(true);

    const you = await readFile(join(f.to, 'config/logins/claude-you.yaml'), 'utf8');
    expect(you).toContain('store: ferretry');
    expect(you).not.toContain('host');
    expect(you).not.toContain('budget');
    expect(you).toContain('label: Me');

    const glm = await readFile(join(f.to, 'config/logins/glm-a.yaml'), 'utf8');
    expect(glm).toContain('${secret:GLM_KEY}');
    expect(glm).toContain('${secret:LOGIN_GLM_A_ANTHROPIC_API_KEY}');
    expect(glm).not.toContain(FAKE_KEY);

    // No sign-in folder, no credential file, no fake key anywhere in the converted home, the report or the summary.
    expect(existsSync(join(f.to, 'fleet/credentials'))).toBe(false);
    expect(existsSync(join(f.to, 'state/logins/credentials'))).toBe(false);
    expect(await everything(f.to)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(done.report)).not.toContain(FAKE_KEY);
    expect(done.summary).not.toContain(FAKE_KEY);
    // The preview vault stays EMPTY: a parked key was discarded, never sealed.
    expect(existsSync(join(f.to, 'state/vault/vault.json'))).toBe(false);
    const note = done.report?.steps.find(step => step.id === 'login-keys')?.note ?? '';
    expect(note).toContain('NOT carried');
    expect(note).toContain('LOGIN_GLM_A_ANTHROPIC_API_KEY');
    expect(note).not.toContain(FAKE_KEY);
  });

  test('Codex stays held: its login, its runtime and the line that says why', async () => {
    await home();
    const done = await prepared();
    expect(existsSync(join(f.to, 'config/logins/codex-login.yaml'))).toBe(false);
    expect(existsSync(join(f.to, 'config/runtimes/codex-main.yaml'))).toBe(false);
    expect(existsSync(join(f.to, 'config/runtimes/claude-default.yaml'))).toBe(true);
    expect(existsSync(join(f.to, 'config/runtimes/glm-a.yaml'))).toBe(true);
    const held = heldSection(done.report as never);
    expect(held).toContain('login codex-login (Codex)');
    expect(held).toContain('runtime codex-main (Codex)');
    expect(held).toContain(CODEX_HELD_SENTENCE);
  });

  test('the real converter is untouched: store: host stays host and the whole login file is carried', async () => {
    await put('layout-version', '2\n');
    await put('config/logins/claude-you.yaml', 'harness: claude\nstore: host\nbudget:\n  daily:\n    hard: 20\n');
    const report = await settingsStep.run(f.ctx());
    expect(report.status).toBe('converted');
    const text = await readFile(join(f.to, 'config/logins/claude-you.yaml'), 'utf8');
    expect(text).toContain('store: host');
    expect(text).toContain('budget');
  });
});
