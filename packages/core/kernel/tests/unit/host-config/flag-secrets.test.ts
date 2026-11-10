/**
 * CFG-LEAK-W: the write rule. A raw secret given to a FLAG (`--token <v>`, `-e API_KEY=<v>`, a URL password) is refused
 * when a text is about to be put on disk, and ONLY then: a file that already holds one keeps loading, keeps working,
 * and is shown with the value hidden. New-only: a write refuses a finding the file on disk does not already hold.
 *
 * `findFlagSecrets` is pure and is pinned on its own first; the rule at the four write sites is pinned through the real
 * writer (the other three sites: `write-all.test.ts` for the set, `held-edit-patch.test.ts` for a held file).
 *
 * Fake only: every value is shaped like a credential and is none.
 */
import { describe, expect, test } from 'bun:test';
import { findFlagSecrets } from '../../../host/config/secrets.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { captureLog, HOME, manualClock } from './support.ts';
import { mcpDef, OTHER_VALUE, SHORT_PASSWORD, VALUE } from './masked-support.ts';

const found = (document: unknown): number => findFlagSecrets(document).length;

describe('findFlagSecrets: which words are a raw secret given to a flag', () => {
  test('S6 CFG-LEAK-W a flag glued to its value (W1), the word after a flag (W2), a nested NAME=value (W3) and a URL password (W4) are found', () => {
    expect(found({ args: [`--token=${VALUE}`] })).toBe(1);
    expect(found({ args: [`--client-secret=${VALUE}`] })).toBe(1);
    expect(found({ args: [`--password=${VALUE}`] })).toBe(1);
    expect(found({ args: ['--token', VALUE] })).toBe(1);
    expect(found({ args: ['--api-key', VALUE] })).toBe(1);
    expect(found({ args: ['-e', `API_KEY=${VALUE}`] })).toBe(1);
    expect(found({ args: ['--env', `DB_PASSWORD=${VALUE}`] })).toBe(1);
    expect(found({ args: [`--header=Authorization: Bearer ${VALUE}`] })).toBe(1);
    expect(found({ args: [`--header=Cookie: ${VALUE}`] })).toBe(1);
    expect(found({ args: [`--token=Bearer ${VALUE}`] })).toBe(1);
    expect(found({ url: `https://alice:${SHORT_PASSWORD}@host.example/path` })).toBe(1);
    expect(found({ args: ['--url', `postgres://u:${SHORT_PASSWORD}@localhost/db`] })).toBe(1);
  });

  test('CFG-LEAK-W a string with blanks outside a list is read as words, and as a whole', () => {
    expect(found({ note: `srv --verbose --token ${VALUE}` })).toBe(1);
    expect(found({ note: `srv --password=${VALUE} --port 80` })).toBe(1);
    expect(found({ note: `Authorization: Bearer ${VALUE}` })).toBe(1);
    expect(found({ note: `run -e API_KEY=${VALUE}` })).toBe(1);
  });

  test('CFG-LEAK-W it finds them at any depth, under any key, in lists of lists and in maps', () => {
    const [first] = findFlagSecrets({ a: { b: [{ c: ['--token', VALUE] }] }, d: 1, e: null, f: true });
    expect(first?.path).toEqual(['a', 'b', 0, 'c', 1]);
  });

  test('CFG-LEAK-W the finding carries a digest and a place, never the value', () => {
    const findings = findFlagSecrets({ args: ['--token', VALUE] });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(findings)).not.toContain(VALUE);
    // The same name and value make the same digest wherever they sit; another value, or another name, does not.
    expect(findFlagSecrets({ note: `--token ${VALUE}` })[0]?.digest).toBe(findings[0]?.digest);
    expect(findFlagSecrets({ args: ['--token', OTHER_VALUE] })[0]?.digest).not.toBe(findings[0]?.digest);
    expect(findFlagSecrets({ args: ['--api-key', VALUE] })[0]?.digest).not.toBe(findings[0]?.digest);
  });

  test('CFG-LEAK-W --token ${secret:NAME}, --token-file ~/.x, --auth-mode browser-login, -p hunter2 are accepted', () => {
    expect(found({ args: ['--token', '${secret:GH_TOKEN}'] })).toBe(0);
    expect(found({ args: ['--token-file', '~/.config/tool/token'] })).toBe(0);
    expect(found({ args: ['--auth-mode', 'browser-login'] })).toBe(0);
    expect(found({ args: ['--auth', 'browser-login-flow-that-is-long'] })).toBe(0);
    expect(found({ args: ['-p', 'hunter2'] })).toBe(0);
    expect(found({ args: ['-p', VALUE] })).toBe(0);
    expect(found({ args: ['--header', `Bearer ${VALUE}`] })).toBe(0);
  });

  test('CFG-LEAK-W a pointer, a path, a URL, a short or low-entropy value under a credential flag is accepted', () => {
    expect(found({ args: [`--token=\${secret:GH_TOKEN}`] })).toBe(0);
    expect(found({ args: ['--token=$GH_TOKEN'] })).toBe(0);
    expect(found({ args: ['--token', '${GH_TOKEN}'] })).toBe(0);
    expect(found({ args: ['--token="${GH_TOKEN}"'] })).toBe(0);
    expect(found({ args: ['--key', '/etc/keys/id_ed25519_long_name'] })).toBe(0);
    expect(found({ args: ['--key=https://keys.example/jwks.json'] })).toBe(0);
    expect(found({ args: ['--password=short'] })).toBe(0);
    expect(found({ args: ['--token', 'aaaaaaaaaaaaaaaaaaaaaaaa'] })).toBe(0);
    expect(found({ args: [`--header=Authorization: Bearer \${secret:TOKEN}`] })).toBe(0);
    expect(found({ args: [`--header=X-Trace: ${VALUE}`] })).toBe(0);
    expect(found({ args: [`--token ${VALUE}`] })).toBe(1);
    expect(found({ args: ['--token'] })).toBe(0);
    expect(found({ args: ['--token', '--verbose'] })).toBe(0);
  });

  test('CFG-LEAK-W a URL password that points elsewhere, or is short, or is not there, is accepted', () => {
    expect(found({ url: 'https://alice:${secret:DB_PW}@host.example' })).toBe(0);
    expect(found({ url: 'https://alice:$DB_PW@host.example' })).toBe(0);
    expect(found({ url: 'https://alice:short@host.example' })).toBe(0);
    expect(found({ url: 'https://alice@host.example' })).toBe(0);
    expect(found({ url: 'https://host.example:8080/path' })).toBe(0);
  });

  test('CFG-LEAK-W anything that is not text is passed over', () => {
    expect(found(undefined)).toBe(0);
    expect(found(null)).toBe(0);
    expect(found(7)).toBe(0);
    expect(found({ args: [1, true, null, ['--token'], { x: VALUE }] })).toBe(0);
  });

  test('CFG-LEAK-W the same pair twice in one place is one finding', () => {
    expect(found({ note: `--token ${VALUE} --token ${VALUE}` })).toBe(1);
  });
});

/** The real writer over a memory disk, as a plugin that owns `mcp/<name>.yaml` sees it. */
function harness(seed?: Readonly<Record<string, string>>) {
  const fs = createMemoryHostFs();
  for (const [path, text] of Object.entries(seed ?? {})) fs.seed(`${HOME}/config/${path}`, text);
  const log = captureLog();
  const make = () =>
    createConfigFiles({
      home: HOME,
      fs,
      clock: manualClock(),
      log,
      binary: 'fy',
      defs: [{ plugin: 'mcp', def: mcpDef }],
    });
  const files = make();
  const port = files.port('mcp');
  const disk = (path: string): string | undefined => fs.snapshot().get(`${HOME}/config/${path}`);
  return { fs, files, port, disk, restart: make };
}

const WITH_TOKEN = `command: srv\nargs:\n  - --token\n  - ${VALUE}\n`;

describe('the write rule at the first write site: a text put on disk', () => {
  test('S6 CFG-LEAK-W R-0419 a new --token <v> / --password=<v> / -e API_KEY=<v> is refused raw_secret; the issue never repeats the value', async () => {
    const h = harness();
    await h.files.reload();
    for (const args of [['--token', VALUE], [`--password=${VALUE}`], ['-e', `API_KEY=${VALUE}`]]) {
      const text = `args:\n${args.map(word => `  - ${word}`).join('\n')}\n`;
      const outcome = await h.port.write(mcpDef, 'srv', text);
      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') return;
      expect(outcome.reason).toBe('raw_secret');
      expect(JSON.stringify(outcome)).not.toContain(VALUE);
      expect(outcome.issues[0]).toMatchObject({
        path: 'mcp/srv.yaml',
        severity: 'error',
        message: expect.stringContaining(
          'this looks like a raw secret given to a flag (an API key, token or password)',
        ),
        fix: expect.stringContaining('fy secret set NAME'),
      });
      expect(outcome.issues[0]?.line).toBeGreaterThan(1);
      expect(h.disk('mcp/srv.yaml')).toBeUndefined();
    }
  });

  test('CFG-LEAK-W --token ${secret:NAME}, --token-file ~/.x, --auth-mode browser-login, -p hunter2 are accepted', async () => {
    const h = harness();
    await h.files.reload();
    const text =
      'args:\n  - --token\n  - ${secret:SRV_TOKEN}\n  - --token-file\n  - ~/.config/srv/token\n  - --auth-mode\n  - browser-login\n  - -p\n  - hunter2\n';
    const outcome = await h.port.write(mcpDef, 'srv', text);
    expect(outcome.kind).toBe('written');
    expect(h.disk('mcp/srv.yaml')).toBe(text);
  });

  test('CFG-LEAK-W an existing file holding --token <v> RELOADS valid and stays in effect after a restart', async () => {
    const h = harness({ 'mcp/srv.yaml': WITH_TOKEN });
    await h.files.reload();
    expect(h.port.fileState(mcpDef, 'srv')).toMatchObject({ state: 'valid', inEffect: true });
    expect(h.port.collection(mcpDef).get('srv')?.args).toEqual(['--token', VALUE]);
    // A restart is a new writer over the same disk: the file is valid and in effect again, nothing was refused or held.
    const again = h.restart();
    await again.reload();
    const port = again.port('mcp');
    expect(port.fileState(mcpDef, 'srv')).toMatchObject({ state: 'valid', inEffect: true });
    expect(port.collection(mcpDef).get('srv')?.args).toEqual(['--token', VALUE]);
    expect(again.status().issues).toEqual([]);
    expect(h.disk('mcp/srv.yaml')).toBe(WITH_TOKEN);
  });

  test('CFG-LEAK-W a patch of another key of that file is applied (new-only)', async () => {
    const h = harness({ 'mcp/srv.yaml': WITH_TOKEN });
    await h.files.reload();
    const outcome = await h.port.write(mcpDef, 'srv', { patch: { note: 'hello' } });
    expect(outcome.kind).toBe('written');
    expect(h.port.collection(mcpDef).get('srv')).toMatchObject({ note: 'hello', args: ['--token', VALUE] });
    expect(h.disk('mcp/srv.yaml')).toContain('note: hello');
    // …and the same text written whole, with the same pair kept, is accepted just as well.
    const whole = await h.port.write(mcpDef, 'srv', `${WITH_TOKEN}limit: 3\n`);
    expect(whole.kind).toBe('written');
  });

  test('CFG-LEAK-W the same value moved to another file, or changed, is refused', async () => {
    const h = harness({ 'mcp/srv.yaml': WITH_TOKEN });
    await h.files.reload();
    const moved = await h.port.write(mcpDef, 'other', WITH_TOKEN);
    expect(moved).toMatchObject({ kind: 'refused', reason: 'raw_secret' });
    expect(h.disk('mcp/other.yaml')).toBeUndefined();
    const changed = await h.port.write(mcpDef, 'srv', WITH_TOKEN.replace(VALUE, OTHER_VALUE));
    expect(changed).toMatchObject({ kind: 'refused', reason: 'raw_secret' });
    // The name is part of what is kept: the same value under another flag is a new finding.
    const renamed = await h.port.write(mcpDef, 'srv', WITH_TOKEN.replace('--token', '--api-key'));
    expect(renamed).toMatchObject({ kind: 'refused', reason: 'raw_secret' });
    expect(h.disk('mcp/srv.yaml')).toBe(WITH_TOKEN);
    // The same pair kept where it was but at another place in the same file is the same finding: accepted.
    const movedWithin = await h.port.write(mcpDef, 'srv', `note: "--token ${VALUE}"\n`);
    expect(movedWithin.kind).toBe('written');
  });

  test('CFG-LEAK-W a prior that does not parse, or is not there, holds none: every finding is new', async () => {
    const h = harness({ 'mcp/srv.yaml': 'args: [unclosed\n' });
    await h.files.reload();
    const outcome = await h.port.write(mcpDef, 'srv', WITH_TOKEN);
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'raw_secret' });
  });

  test('CFG-LEAK-W the refusals are capped, and one sentence counts the rest', async () => {
    const h = harness();
    await h.files.reload();
    const items = Array.from(
      { length: 60 },
      (_, index) => `  - --token\n  - Qv${String(index).padStart(3, '0')}xLmN7rTzK9pW\n`,
    );
    const outcome = await h.port.write(mcpDef, 'srv', `args:\n${items.join('')}`);
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(outcome.issues).toHaveLength(51);
    expect(outcome.issues[50]?.message).toBe('and 10 more problems not listed here');
  });

  test('CFG-LEAK-W a text that was refused for another reason says that reason, not the flag rule', async () => {
    const h = harness();
    await h.files.reload();
    const outcome = await h.port.write(mcpDef, 'srv', `limit: many\nargs: [--token, ${VALUE}]\n`);
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'schema' });
  });
});
