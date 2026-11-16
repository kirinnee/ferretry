/**
 * The preview carries each v4 login FILE as an empty, signed-out shell BUILT from an allowlist
 * (`src/steps/preview-logins.ts`): harness, store, label, preset and env references only. No login file is staged. No
 * sign-in (`fleet/credentials`) and no literal env value is ever carried, `store: host` becomes `store: ferretry` in the
 * preview alone, and a Codex login stays held. Every key here is fake.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Document, parse, parseDocument } from 'yaml';
import { LoginKeyHold } from '../../src/steps/login-keys.ts';
import { heldSection, prepare } from '../../preview/driver.ts';
import { decide, DENIED } from '../../preview/plan.ts';
import { walk } from '../../preview/stage.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { buildShell, isPlainProviderUrl, signInIssue } from '../../src/steps/preview-logins.ts';
import { LoginFileSchema } from '@ferretry/plugin-logins/contract';
import { credentialIssues, credentialOf } from '../../../../packages/plugins/logins/daemon/lib/shared/credential.ts';
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
  test('no login file is staged; the sign-ins never are', () => {
    expect(decide('config/logins', true).verdict).toBe('leave');
    expect(decide('config/logins/work.yaml', false).verdict).toBe('leave');
    expect(decide('fleet/credentials', true).verdict).toBe('leave');
    expect(decide('fleet/credentials/work/.credentials.json', false).verdict).toBe('leave');
    expect(decide('fleet/credentials/work/auth.json', false).verdict).toBe('leave');
    expect(decide('fleet/homes/h1/.claude/.credentials.json', false).verdict).toBe('leave');
    expect(DENIED.some(deny => deny.pattern.test('config/logins/x.yaml'))).toBe(true);
    expect(DENIED.some(deny => deny.pattern.test('fleet/credentials/x'))).toBe(true);
  });

  test('the walk lists no login file and nothing under fleet/credentials', async () => {
    await put('layout-version', '2\n');
    await put('config/logins/work.yaml', 'harness: claude\n');
    await put('fleet/credentials/work/.credentials.json', FAKE_KEY);
    const files = (await walk(f.from)).files.map(file => file.path);
    expect(files.some(path => path.startsWith('config/logins'))).toBe(false);
    expect(files.some(path => path.startsWith('fleet/credentials'))).toBe(false);
  });
});

describe('buildShell: the fields a shell has', () => {
  const FULL = [
    '# a comment above everything',
    'harness: claude # a trailing comment',
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
    '  ANTHROPIC_BASE_URL: https://api.example.com/anthropic',
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
  const build = (text: string, holdCodex = false) =>
    buildShell(parseDocument(text), 'work', holdCodex, new LoginKeyHold());

  test('harness, store, label, preset and env stay (the budget moves to usage.yaml); everything else is named and dropped', () => {
    const shell = build(FULL);
    expect(shell.kind).toBe('carried');
    if (shell.kind !== 'carried') return;
    const kept = shell.document.toJS() as Record<string, unknown>;
    expect(Object.keys(kept).sort()).toEqual(['claude', 'codex', 'env', 'harness', 'label', 'preset', 'store']);
    // The budget is REBUILT from numbers (the same cap v4 enforced) and handed on for usage.yaml: the shell holds none.
    expect(kept).not.toHaveProperty('budget');
    expect(shell.budget).toEqual({ daily: { hard: 5 } });
    expect(kept.claude).toEqual({ env: { C: '${secret:C_KEY}' } });
    // A, a literal that is not a whole reference or a provider URL, is replaced; the provider URL stays.
    expect(kept.env).toEqual({
      A: '${secret:A_KEY}',
      B: '${secret:LOGIN_WORK_B}',
      ANTHROPIC_BASE_URL: 'https://api.example.com/anthropic',
    });
    expect([...shell.removed].sort()).toEqual(
      ['claude.codexProvider', 'clonedFrom', 'clonedFromKey', 'cloudCredential', 'codexProvider', 'disabled'].sort(),
    );
    expect(shell.replaced).toEqual(['B']);
    // A NEW document: not one comment of the v4 file is in it.
    expect(String(shell.document)).not.toContain('comment');
  });

  test('while Codex is held, the codex half goes and a Codex login is not carried', () => {
    const shell = build(FULL, true);
    expect(shell.kind === 'carried' ? Object.keys(shell.document.toJS() as object) : []).not.toContain('codex');
    expect(build('harness: codex\n', true)).toEqual({ kind: 'held', harness: 'codex' });
    expect(build('store: host\n', true)).toEqual({ kind: 'held', harness: 'unknown' });
    expect(buildShell(new Document('text'), 'work', false, new LoginKeyHold())).toEqual({
      kind: 'held',
      harness: 'unknown',
    });
  });

  test('store: host becomes store: ferretry, and nothing else changes the store', () => {
    const host = build('harness: claude\nstore: host\n', true);
    expect(host).toMatchObject({ kind: 'carried', storeMoved: true });
    expect(host.kind === 'carried' ? host.document.get('store') : '').toBe('ferretry');
    const env = build('harness: claude\nstore: environment\nenv:\n  A: ${secret:A_KEY}\n', true);
    expect(env).toMatchObject({ storeMoved: false });
    expect(env.kind === 'carried' ? env.document.get('store') : '').toBe('environment');
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
    // The cap v4 enforced is in usage.yaml (rebuilt from its numbers), the one place 5.0 enforces it; the shell has none.
    expect(parseDocument(you).toJS()).not.toHaveProperty('budget');
    expect(parse(await readFile(join(f.to, 'config/usage.yaml'), 'utf8'))).toMatchObject({
      budgets: { 'claude-you': { daily: { hard: 20 } } },
    });
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
    // The cap moves to usage.yaml (the only place 5.0 enforces one); the login file then carries none.
    expect(text).not.toContain('budget');
    expect(parse(await readFile(join(f.to, 'config/usage.yaml'), 'utf8'))).toMatchObject({
      budgets: { 'claude-you': { daily: { hard: 20 } } },
    });
  });
});

describe('the one plain-value exception: a provider address', () => {
  const ok = (variable: string, value: string) => isPlainProviderUrl(variable, value);

  test('a plain https address under a *_URL / *_BASE_URL name stays', () => {
    expect(ok('ANTHROPIC_BASE_URL', 'https://api.z.ai/api/anthropic')).toBe(true);
    expect(ok('OPENAI_BASE_URL', 'https://api.example.com/v1/')).toBe(true);
    expect(ok('SERVICE_URL', 'https://example.com')).toBe(true);
    expect(ok('X_BASE_URL', 'https://example.com:8443/some-long-but-hyphenated-compatible-endpoint-name')).toBe(true);
  });

  test('anything else becomes a reference: other names, other schemes, userinfo, query, fragment', () => {
    expect(ok('ANTHROPIC_ENDPOINT', 'https://api.example.com')).toBe(false);
    expect(ok('ANTHROPIC_BASE_URL', 'http://api.example.com')).toBe(false);
    expect(ok('ANTHROPIC_BASE_URL', 'https://user:pass@api.example.com')).toBe(false);
    expect(ok('ANTHROPIC_BASE_URL', 'https://user@api.example.com')).toBe(false);
    expect(ok('ANTHROPIC_BASE_URL', 'https://api.example.com/v1?key=abc')).toBe(false);
    expect(ok('ANTHROPIC_BASE_URL', 'https://api.example.com/v1#frag')).toBe(false);
    expect(ok('ANTHROPIC_BASE_URL', 'not a url')).toBe(false);
    expect(ok('ANTHROPIC_BASE_URL', 'file:///tmp/credentials.json')).toBe(false);
  });

  test('a path segment that looks like a token (20+ letters or digits, or a known secret shape) is a reference', () => {
    expect(ok('WEBHOOK_URL', 'https://hooks.example.com/services/T0KENabcdefghij1234567890WEBHOOK')).toBe(false);
    expect(ok('WEBHOOK_URL', 'https://hooks.example.com/services/T00000000/B00000000/abcdefghijklmnopqrstuvwx')).toBe(
      false,
    );
    expect(ok('WEBHOOK_URL', 'https://hooks.example.com/sk-ant-FAKE-0000-not-a-real-key')).toBe(false);
    expect(ok('WEBHOOK_URL', 'https://hooks.example.com/ghp_abcdefghijklmnopqrst')).toBe(false);
    expect(ok('WEBHOOK_URL', 'https://hooks.example.com/%54%30KENabcdefghij1234567890WEBHOOK')).toBe(false);
    expect(ok('WEBHOOK_URL', 'https://hooks.example.com/services/short/ids')).toBe(true);
  });
});

describe('the URL exception keeps only the bytes it validated (fix2, review finding 2)', () => {
  const OPAQUE = 'aB3dE5gH7jK9mN2pQ4rS6tV8';
  const bad = (value: string) => expect(isPlainProviderUrl('API_URL', value)).toBe(false);

  test('a dot segment, raw or percent-encoded in any case, is refused: normalising it would hide a discarded segment', () => {
    for (const dots of ['..', '.', '%2e%2e', '%2E%2E', '%2e.', '.%2E', '%2e', '%2E'])
      bad(`https://api.example.com/${OPAQUE}/${dots}/v1`);
    bad('https://api.example.com/v1/../v2');
    bad('https://api.example.com/v1/./v2');
    bad('https://api.example.com/v1/%2e%2e/v2');
    bad('https://api.example.com/..');
  });

  test('only a value the URL serialises as itself is kept: odd escapes, a default port or a changed host are refused', () => {
    bad('https://[not-a-host/v1');
    bad('https://api.example.com/%ff');
    bad('https://api.example.com/a b');
    bad('https://api.example.com:443/v1');
    bad('https://API.EXAMPLE.COM.evil:99999/v1');
  });

  test('ordinary provider addresses, an international host, a port and a trailing slash are kept', () => {
    for (const value of [
      'https://api.example.com/v1',
      'https://api.z.ai/api/anthropic',
      'https://open.bigmodel.cn/api/paas/v4',
      'https://api.example.com:8443/',
      'https://例え.テスト/v1/',
      'https://api.example.com',
      'https://API.example.com/v1',
    ])
      expect(isPlainProviderUrl('API_URL', value)).toBe(true);
  });
});

describe('the token rule covers the whole token alphabet (fix2, review findings 3 and 4)', () => {
  const BASE64URL = 'aB3dE5gH7jK9mN2pQ4r_S6tV8-wX0yZ2aB4cD6eF8';
  const OPAQUE = 'aB3dE5gH7jK9mN2pQ4rS6tV8';
  const base = 'harness: claude\nstore: environment\n';
  const shellOf = (text: string): string => {
    const built = buildShell(parseDocument(text), 'work', true, new LoginKeyHold());
    return built.kind === 'carried' ? String(built.document) : '';
  };

  test('a base64url path segment split by _ or - is a token; the run needs no whole-segment match', () => {
    expect(isPlainProviderUrl('API_URL', `https://api.example.com/${BASE64URL}`)).toBe(false);
    expect(isPlainProviderUrl('API_URL', `https://api.example.com/${BASE64URL.replaceAll('_', '-')}`)).toBe(false);
    expect(isPlainProviderUrl('API_URL', `https://api.example.com/v1:${OPAQUE}`)).toBe(false);
    expect(isPlainProviderUrl('API_URL', `https://${OPAQUE}.example.com/v1`)).toBe(false);
    expect(isPlainProviderUrl('API_URL', 'https://api.example.com/v1/chat-completions-endpoint')).toBe(true);
    expect(isPlainProviderUrl('API_URL', 'https://api.example.com/api/anthropic')).toBe(true);
  });

  test('a label or a preset that is credential-shaped is omitted, and no line prints it', () => {
    for (const field of ['label', 'preset']) {
      const built = buildShell(
        parseDocument(`${base}${field}: ${OPAQUE}\nenv:\n  A: \${secret:EMPTY}\n`),
        'work',
        true,
        new LoginKeyHold(),
      );
      expect(built.kind).toBe('carried');
      if (built.kind !== 'carried') continue;
      expect(String(built.document)).not.toContain(OPAQUE);
      expect(built.removed).toContain(field);
      expect(JSON.stringify(built)).not.toContain(OPAQUE);
    }
    expect(shellOf(`${base}label: sk-ant-FAKE-0000-not-a-real-key\nenv:\n  A: \${secret:EMPTY}\n`)).not.toContain(
      'sk-ant',
    );
  });

  test('an ordinary label and preset are still carried', () => {
    const out = shellOf(`${base}label: Work account\npreset: zai\nenv:\n  A: \${secret:EMPTY}\n`);
    expect(out).toContain('label: Work account');
    expect(out).toContain('preset: zai');
  });
});

describe('signInIssue agrees with the logins plugin rule (credentialIssues)', () => {
  const cases: readonly [string, Record<string, unknown>][] = [
    ['environment with env', { harness: 'claude-code', store: 'environment', env: { A: '${secret:A}' } }],
    ['environment with no env', { harness: 'claude-code', store: 'environment' }],
    ['environment with empty env', { harness: 'claude-code', store: 'environment', env: {} }],
    [
      'halves, the own half has a variable',
      { harness: 'claude-code', store: 'environment', claude: { env: { A: '${secret:A}' } } },
    ],
    [
      'halves, only the other half exists',
      { harness: 'claude-code', store: 'environment', codex: { env: { A: '${secret:A}' } } },
    ],
    ['ferretry store', { harness: 'claude-code', store: 'ferretry' }],
    ['host store', { harness: 'claude-code', store: 'host' }],
  ];
  for (const [name, shell] of cases)
    test(name, () => {
      const parsed = LoginFileSchema.parse(shell);
      const real = credentialIssues(credentialOf(parsed)).length === 0;
      expect(signInIssue(shell, shell.harness) === undefined).toBe(real);
    });
});
