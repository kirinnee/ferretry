import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { settingsStep } from '../../src/steps/settings.ts';
import { documentCredentialPaths, quietYaml, rawSecretPaths, textLooksLikeCredential } from '../../src/v4/config.ts';
import { needlesFor, valueHits } from '../../src/v4/homes.ts';
import { fixture } from './ferret-fixture.ts';

// B04: the converter's secret and home gates must not be walked around by a spelling. Every value here is a FIXED FAKE.
const FAKE = 'Zx9qLm2Pw8Rt5Vb7Nc4K';
const FAKE_SK = 'sk-ant-FAKEFAKEFAKEFAKEFAKE0123';

describe('structured values: the shared secret rules apply to a parsed document', () => {
  test('a default inside a shell reference is a value, not a reference', () => {
    expect(rawSecretPaths({ env: { API_TOKEN: `\${API_TOKEN:-${FAKE}}` } })).toEqual(['env.API_TOKEN']);
    expect(rawSecretPaths({ env: { API_TOKEN: `\${API_TOKEN:=${FAKE}}` } })).toEqual(['env.API_TOKEN']);
    expect(rawSecretPaths({ env: { API_TOKEN: `\${API_TOKEN:+${FAKE}}` } })).toEqual(['env.API_TOKEN']);
    expect(rawSecretPaths({ env: { run: `TOKEN=\${TOKEN:-${FAKE}} ./go.sh` } })).toEqual(['env.run']);
    // plain references and an empty default are still references
    expect(
      rawSecretPaths({ env: { API_TOKEN: '${API_TOKEN}', API_KEY: '$API_KEY', K: '${secret:FAKE_KEY}' } }),
    ).toEqual([]);
    expect(rawSecretPaths({ env: { API_TOKEN: '${API_TOKEN:-}' } })).toEqual([]);
  });

  test('a YAML folded or literal block value under a credential name is judged without its line breaks', () => {
    const folded = quietYaml(`env:\n  API_KEY: >\n    Zx9qLm2Pw8Rt\n    5Vb7Nc4KabcdEfGh\n`);
    expect(rawSecretPaths(folded)).toEqual(['env.API_KEY']);
    const literal = quietYaml(`env:\n  API_KEY: |\n    Zx9qLm2Pw8Rt\n    5Vb7Nc4KabcdEfGh\n`);
    expect(rawSecretPaths(literal)).toEqual(['env.API_KEY']);
  });

  test('a URL-encoded known key shape is a key', () => {
    expect(rawSecretPaths({ note: 'sk%2Dant%2DFAKEFAKEFAKEFAKEFAKE0123' })).toEqual(['note']);
    expect(rawSecretPaths({ note: '%73k-ant-FAKEFAKEFAKEFAKEFAKE0123' })).toEqual(['note']);
    expect(rawSecretPaths({ note: 'hello%20world' })).toEqual([]);
  });

  test('a credential in a URL query or a URL user is refused; an ordinary query is not', () => {
    expect(rawSecretPaths({ endpoint: `https://example.com/v1?api_key=${FAKE}` })).toEqual(['endpoint']);
    expect(rawSecretPaths({ endpoint: `https://example.com/v1?model=x&access_token=${FAKE}` })).toEqual(['endpoint']);
    expect(rawSecretPaths({ endpoint: `https://example.com/v1?api%5Fkey=${FAKE}` })).toEqual(['endpoint']);
    expect(rawSecretPaths({ endpoint: `https://bob:${FAKE}@example.com/v1` })).toEqual(['endpoint']);
    expect(rawSecretPaths({ endpoint: 'https://example.com/v1?model=gpt-4o&stream=true' })).toEqual([]);
    expect(rawSecretPaths({ endpoint: 'https://example.com/v1?api_key=${secret:FAKE_KEY}' })).toEqual([]);
  });

  test('JSON inside a string is read as the document it is, escaped keys included', () => {
    const escaped = `{"env":{"API\\u005fKEY":"${FAKE}"}}`;
    expect(rawSecretPaths({ settings: escaped })).toEqual(['settings']);
    expect(rawSecretPaths({ settings: `{"env":{"API_KEY":"${FAKE}"}}` })).toEqual(['settings']);
    expect(rawSecretPaths({ settings: '{"env":{"LOG_LEVEL":"debug"}}' })).toEqual([]);
  });

  test('a key shaped like a token is refused even when its value is harmless', () => {
    expect(rawSecretPaths({ env: { [FAKE_SK]: true } })).toEqual(['env.<key>']);
  });

  test('the component rule (documentCredentialPaths) inherits all of it', () => {
    expect(documentCredentialPaths({ env: { API_TOKEN: `\${API_TOKEN:-${FAKE}}` } })).toContain('env.API_TOKEN');
  });
});

describe('carried text', () => {
  test('a JSON-escaped credential key, a default value and an encoded shape are credentials', () => {
    expect(textLooksLikeCredential(`{"API\\u005fKEY": "${FAKE}"}`)).toBe(true);
    expect(textLooksLikeCredential(`export TOKEN=\${TOKEN:-${FAKE}}\n`)).toBe(true);
    expect(textLooksLikeCredential('curl https://x/v1?api%5Fkey=Zx9qLm2Pw8Rt5Vb7Nc4K\n')).toBe(true);
    expect(textLooksLikeCredential('use sk%2Dant%2DFAKEFAKEFAKEFAKEFAKE0123 here\n')).toBe(true);
    expect(textLooksLikeCredential('curl "https://x/v1?api_key=Zx9qLm2Pw8Rt5Vb7Nc4K"\n')).toBe(true);
  });

  test('ordinary prose, references and defaults still carry', () => {
    expect(textLooksLikeCredential('export TOKEN=${TOKEN}\nexport LEVEL=${LEVEL:-debug}\n')).toBe(false);
    expect(textLooksLikeCredential('Basic troubleshooting of the token budget\n')).toBe(false);
  });
});

describe('the homes gate refuses a home reference it cannot resolve', () => {
  const needles = needlesFor('/home/u/.ferretry', '/home/u');
  const hit = (value: string, only: 'both' | 'harness' = 'both') => valueHits(value, needles, only);

  test.each([
    '"$HOME"/.claude/settings.json',
    '$HOME/".claude"/settings.json',
    '"${HOME}/.codex/auth.json"',
    '$HOME/.cl""aude/x',
    "$HOME/.cl'a'ude/x",
    '$HOME/.cla\\ude/x',
    '~root/.claude/x',
    '~someone/.codex/x',
    'cat $(echo ~)/.claude/x',
    'cat `echo ~`/.codex/x',
    'cat $(cd ~; pwd)/.claude/x',
    'H=$HOME; cat $H/.claude/x',
    'cat ${H}/.codex/x',
    'cat $HOME/.{claude,codex}/x',
    'cat $HOME/.cl*/x',
    'cat "$HOME"/.ferretry/fleet/x',
    'cat $HOME/".ferretry"/fleet/x',
    'cat $(echo ~)/.ferretry/x',
  ])('%s', value => {
    expect(hit(value)).toBe(true);
  });

  test('the harness-only mode still refuses a harness home and ignores the v4 home', () => {
    expect(hit('"$HOME"/.claude/x', 'harness')).toBe(true);
    expect(hit('cat $(echo ~)/.ferretry/x', 'harness')).toBe(false);
  });

  test.each([
    '$CLAUDE_PROJECT_DIR/.claude/hooks/check.sh',
    '"${CLAUDE_PROJECT_DIR}"/.claude/hooks/check.sh',
    '$PWD/.claude/hooks/check.sh',
    './.claude/hooks/check.sh',
    '.claude/hooks/check.sh',
    '/home/other/.claude/x',
    '/home/u/projects/app/.claude/x',
    'echo "$HOME" and a .claude word',
    '$HOME/projects/app',
  ])('still carries %s', value => {
    expect(hit(value)).toBe(false);
  });
});

describe('the conversion report names each refused file and never its value', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => {
    await f.clean();
  });

  const put = async (path: string, text: string) => {
    const target = join(f.from, 'config', path);
    await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
    await writeFile(target, text, { mode: 0o600 });
  };

  test.each([
    [
      'a shell default',
      `harness: claude\nstore: environment\nenv:\n  ANTHROPIC_API_KEY: \${ANTHROPIC_API_KEY:-${FAKE}}\n`,
    ],
    [
      'a URL query',
      `harness: claude\nstore: environment\nenv:\n  ANTHROPIC_BASE_URL: https://example.com/v1?api_key=${FAKE}\n`,
    ],
    [
      'a folded value',
      `harness: claude\nstore: environment\nenv:\n  ANTHROPIC_API_KEY: >\n    Zx9qLm2Pw8Rt\n    5Vb7Nc4KabcdEfGh\n`,
    ],
  ])('%s', async (_, body) => {
    await put('logins/leaky.yaml', body);
    const report = await settingsStep.run(f.ctx());
    expect(report.status).toBe('failed');
    expect(report.note).toContain('config/logins/leaky.yaml');
    expect(report.note).not.toContain(FAKE);
    expect(report.note).not.toContain('5Vb7Nc4KabcdEfGh');
  });
});
