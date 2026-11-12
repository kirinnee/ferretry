import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stage } from '../../preview/stage.ts';
import { convert } from '../../src/convert.ts';
import { acceptedConfigStep } from '../../src/steps/accepted-config.ts';
import { carryAssetReferences } from '../../src/steps/component-assets.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { v5Writer } from '../../src/v5/write.ts';
import { fixture } from './ferret-fixture.ts';

/**
 * The owner's hooks component names files under v4's fleet/assets by absolute path (PreCompact `cat <v4 home>/…`,
 * SessionStart `sh <v4 home>/…`). Every path and value here is FAKE; nothing touches a real home.
 */
const REAL = '/fake-real-home/.ferretry';
const USER_HOME = '/fake-real-home';
const BEFORE = 'components/hooks/compact-before.txt';
const AFTER = 'components/hooks/compact-after.sh';
const FAKE_KEY = 'sk-ant-FAKEFAKEFAKEFAKEFAKE0123';
// 24 characters from the token alphabet, a letter and a digit, no known prefix: FAKE.
const FAKE_MIXED = 'Zx9qLm2Pw8Rt5Vb7Nc4Kabcd';
// A standard base64 body (40 characters, no known prefix) that is put after a `/`: FAKE.
const FAKE_B64 = 'Zx9qLm2Pw8Rt5Vb7Nc4Kabcd+EfGh3Jk6Mn9Pq2R';
// The owner's script reaches its home through $FY_HOME, never a literal v4 path: that must carry.
const SCRIPT = '#!/bin/sh\necho compacted\ncat "$FY_HOME/state/compact-notes.txt"\n';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const put = async (path: string, content: string | Buffer, mode = 0o600) => {
  const target = join(f.from, path);
  await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
  await writeFile(target, content, { mode });
};

const hooksJson = (before: string, after: string) =>
  JSON.stringify({
    hooks: {
      PreCompact: [{ hooks: [{ type: 'command', command: before }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: after }] }],
    },
  });

/** The component + a profile layering it, then the preview conversion of the settings step. */
const run = async (before: string, after: string, steps: Parameters<typeof convert>[0]['steps'] = [settingsStep]) => {
  await put('layout-version', '2\n');
  await put('config/components/hooks/claude-hooks.yaml', 'harness: claude\nfile: components/hooks/claude-hooks.json\n');
  await put('fleet/assets/components/hooks/claude-hooks.json', hooksJson(before, after));
  await put('config/profiles/default.yaml', 'contents:\n  - hooks/claude-hooks\n');
  const result = await convert({
    from: f.from,
    to: f.to,
    dryRun: false,
    lock: { held: async () => false },
    now: () => new Date('2026-11-09T00:00:00Z'),
    host: { homeDirectory: USER_HOME, env: {} },
    steps,
    preview: true,
    previewV4Home: REAL,
    previewUserHome: USER_HOME,
  });
  if (result.kind !== 'done') throw new Error('expected a run');
  const step = result.report.steps.find(item => item.id === 'settings');
  if (step === undefined) throw new Error('no settings step');
  return { report: result.report, step };
};

const cat = (rel = BEFORE) => `cat ${REAL}/fleet/assets/${rel}`;
const sh = (rel = AFTER) => `sh ${REAL}/fleet/assets/${rel}`;
const hooksYaml = () => readFile(join(f.to, 'config/claude-code/hooks/claude-hooks.yaml'), 'utf8');
const everyFile = async (root: string) =>
  (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name));

test("the owner's shape: both files are carried byte for byte, the script stays executable, the commands name the v5 copies", async () => {
  await put(`fleet/assets/${BEFORE}`, 'FAKE compact notes\n');
  await put(`fleet/assets/${AFTER}`, SCRIPT, 0o700);
  const { report, step } = await run(cat(), sh());
  expect(step.status).toBe('converted');
  expect(report.complete).toBe(true);
  expect(await readFile(join(f.to, 'fleet/assets', BEFORE), 'utf8')).toBe('FAKE compact notes\n');
  expect(await readFile(join(f.to, 'fleet/assets', AFTER), 'utf8')).toBe(SCRIPT);
  expect((await stat(join(f.to, 'fleet/assets', AFTER))).mode & 0o777).toBe(0o700);
  expect((await stat(join(f.to, 'fleet/assets', BEFORE))).mode & 0o777).toBe(0o600);
  const text = await hooksYaml();
  expect(text).toContain(`cat ${f.to}/fleet/assets/${BEFORE}`);
  expect(text).toContain(`sh ${f.to}/fleet/assets/${AFTER}`);
  for (const file of await everyFile(f.to)) expect((await readFile(file, 'utf8')).includes(REAL)).toBe(false);
  // The report names each carried file by its fleet/assets path, nothing else.
  expect(step.kept.map(item => item.what)).toContain(`component file fleet/assets/${BEFORE}`);
  expect(step.kept.map(item => item.what)).toContain(`component file fleet/assets/${AFTER}`);
  expect(JSON.stringify(report)).not.toContain(REAL);
});

const refusedCases: readonly (readonly [string, () => Promise<void>])[] = [
  [
    'a hard link',
    async () => {
      await put('state/elsewhere.txt', 'FAKE other file\n');
      await link(join(f.from, 'state/elsewhere.txt'), join(f.from, 'fleet/assets', BEFORE));
    },
  ],
  ['a file over 1 MiB', async () => put(`fleet/assets/${BEFORE}`, Buffer.alloc(1024 * 1024 + 1, 'a'))],
  ['a file holding a secret', async () => put(`fleet/assets/${BEFORE}`, `token ${FAKE_KEY}\n`)],
  ['a file whose content names the v4 home', async () => put(`fleet/assets/${BEFORE}`, `cat ${REAL}/state/x\n`)],
  [
    'a file whose content names the v4 home as ~/.ferretry',
    async () => put(`fleet/assets/${BEFORE}`, 'cat ~/.ferretry/x\n'),
  ],
  [
    'a file whose content names the v4 home as $HOME/.ferretry',
    async () => put(`fleet/assets/${BEFORE}`, 'cat $HOME/.ferretry/state/x\n'),
  ],
  ['a missing file', async () => undefined],
  // M1: the credential scan covers the WHOLE content, as settings documents are scanned.
  [
    'a file with a `values=1` line and a bare key word',
    async () => put(`fleet/assets/${BEFORE}`, `values=1\necho ${FAKE_KEY}\n`),
  ],
  [
    'a file that assigns a key, then reassigns it to a reference',
    async () => put(`fleet/assets/${BEFORE}`, 'API_TOKEN=Zx9qLm2Pw8Rt5Vb7Nc4K\nAPI_TOKEN=$OTHER\n'),
  ],
  [
    'a file with an Authorization: Bearer header',
    async () => put(`fleet/assets/${BEFORE}`, `Authorization: Bearer ${FAKE_MIXED}\n`),
  ],
  [
    'a file with a curl Authorization: Basic header',
    async () => put(`fleet/assets/${BEFORE}`, `curl -H "Authorization: Basic ${FAKE_MIXED}" x\n`),
  ],
  [
    'a file with a Proxy-Authorization header in any case',
    async () => put(`fleet/assets/${BEFORE}`, `proxy-authorization: Basic ${FAKE_MIXED}\n`),
  ],
  [
    // Only the header branch catches this: the value is letters only, so it is not credential-shaped on its own.
    'a file with an Authorization header whose value is letters only',
    async () => put(`fleet/assets/${BEFORE}`, 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwx" x\n'),
  ],
  [
    'a file with a token followed by a credential-shaped value',
    async () => put(`fleet/assets/${BEFORE}`, `token ${FAKE_MIXED}\n`),
  ],
  // n1/n2 narrowing keeps these: a hex value after the word, a value that merely contains a dollar, a literal header.
  [
    'a file with a token followed by a 40-hex value',
    async () => put(`fleet/assets/${BEFORE}`, 'token 0123456789abcdef0123456789abcdef01234567\n'),
  ],
  [
    'a file with an Authorization header whose value only contains a dollar',
    async () => put(`fleet/assets/${BEFORE}`, `curl -H "Authorization: Bearer ${FAKE_MIXED}$x" x\n`),
  ],
  // M1: `/` is in the base64 alphabet, so a real key can start with it; only a PATH-shaped value is exempt.
  [
    'a file with a token followed by a base64 key that starts with a slash',
    async () => put(`fleet/assets/${BEFORE}`, `token /${FAKE_B64}\n`),
  ],
  [
    'a file with a Bearer word followed by a base64 key that starts with a slash',
    async () => put(`fleet/assets/${BEFORE}`, `Bearer /${FAKE_B64}\n`),
  ],
  [
    'a file with an X-Api line naming a Bearer base64 key that starts with a slash',
    async () => put(`fleet/assets/${BEFORE}`, `X-Api: Bearer /${FAKE_B64}=\n`),
  ],
  [
    'a file with a token followed by a base64 key with slashes inside it',
    async () => put(`fleet/assets/${BEFORE}`, 'token /Zx9qLm2P/w8Rt5Vb7/Nc4Kabcd\n'),
  ],
  [
    'a file with a token followed by a key that starts with a tilde',
    async () => put(`fleet/assets/${BEFORE}`, `token ~${FAKE_MIXED}\n`),
  ],
  [
    'a file with a token followed by a key that starts with a dot',
    async () => put(`fleet/assets/${BEFORE}`, `token .${FAKE_MIXED}\n`),
  ],
  [
    'a file with a token followed by a key under a path-looking prefix',
    async () => put(`fleet/assets/${BEFORE}`, `token /home/x/${FAKE_MIXED}\n`),
  ],
  // m1: only a real variable reference is exempt in a header, never a value that merely starts with a dollar.
  [
    'a file with an Authorization header whose value is a dollar then a key',
    async () => put(`fleet/assets/${BEFORE}`, `curl -H "Authorization: Bearer $${FAKE_MIXED}" x\n`),
  ],
  [
    'a file with an Authorization header whose variable has a literal default',
    async () => put(`fleet/assets/${BEFORE}`, `curl -H "Authorization: Bearer \${API_TOKEN:-${FAKE_MIXED}}" x\n`),
  ],
  [
    'a file with an Authorization header whose reference is followed by more text',
    async () => put(`fleet/assets/${BEFORE}`, `curl -H "Authorization: Bearer \${PREFIX}${FAKE_MIXED}" x\n`),
  ],
  [
    'a file with a reference header and then a literal header',
    async () =>
      put(
        `fleet/assets/${BEFORE}`,
        `curl -H "Authorization: Bearer $FROM_THE_ENVIRONMENT" -H "Authorization: Bearer ${FAKE_MIXED}" x\n`,
      ),
  ],
  // m2: the version exemption has a bounded suffix; a key behind a version-looking prefix is still a key.
  [
    'a file with a token followed by a version then a key',
    async () => put(`fleet/assets/${BEFORE}`, `token 1.2.3-${FAKE_MIXED}\n`),
  ],
  [
    'a file with a token followed by a v-version then a key after a plus',
    async () => put(`fleet/assets/${BEFORE}`, `token v1.0.0+${FAKE_MIXED}\n`),
  ],
  [
    'a file with a token followed by a version then a key split by dashes',
    async () => put(`fleet/assets/${BEFORE}`, 'token 1.2.3-Zx9qLm2P-w8Rt5Vb7-Nc4Kabcd\n'),
  ],
  // M2: the content is held to the same homes the last gate refuses in an inline command.
  [
    "a file whose content names v4's worktree folder",
    async () => put(`fleet/assets/${BEFORE}`, `cd ${REAL}-worktrees/x\n`),
  ],
  [
    'a file whose content names ~/.ferretry-worktrees',
    async () => put(`fleet/assets/${BEFORE}`, 'cd ~/.ferretry-worktrees/x\n'),
  ],
  ['a file whose content names ~/.claude', async () => put(`fleet/assets/${BEFORE}`, 'cat ~/.claude/x\n')],
  ['a file whose content names $HOME/.codex', async () => put(`fleet/assets/${BEFORE}`, 'cat $HOME/.codex/x\n')],
  [
    'a file whose content names the user home .claude by path',
    async () => put(`fleet/assets/${BEFORE}`, `cat ${USER_HOME}/.claude/x\n`),
  ],
  ['a file whose content names ${HOME}/.codex', async () => put(`fleet/assets/${BEFORE}`, 'cat ${HOME}/.codex/x\n')],
];

test('a link inside fleet/assets REFUSES the conversion before any step, naming the link', async () => {
  await mkdir(join(f.from, 'fleet/assets/components/hooks'), { recursive: true, mode: 0o700 });
  await symlink('/etc/hostname', join(f.from, 'fleet/assets', BEFORE));
  await expect(run(cat(), sh())).rejects.toThrow('expected a run');
  expect(await stat(f.to).catch(() => undefined)).toBeUndefined();
});

for (const [name, arrange] of refusedCases)
  test(`${name} that a hook points at is not carried; the component is named by reason, never the command`, async () => {
    await mkdir(join(f.from, 'fleet/assets/components/hooks'), { recursive: true, mode: 0o700 });
    await arrange();
    await put(`fleet/assets/${AFTER}`, SCRIPT, 0o700);
    const { step } = await run(cat(), sh());
    expect(step.status).toBe('pending');
    expect(
      await readFile(join(f.to, 'config/claude-code/hooks/claude-hooks.yaml')).catch(() => undefined),
    ).toBeUndefined();
    expect(await stat(join(f.to, 'fleet/assets', BEFORE)).catch(() => undefined)).toBeUndefined();
    const named = JSON.stringify(step);
    expect(named).toContain('config/components/hooks/claude-hooks.yaml');
    expect(named).toContain('copy the file under fleet/assets in v4, or remove the hook');
    expect(named).not.toContain(`cat ${REAL}`);
    expect(named).not.toContain(REAL);
    expect(named).not.toContain(FAKE_KEY);
  });

test('a command naming a v4 path outside fleet/assets is not carried; the report names the component, not the command', async () => {
  await put(`fleet/assets/${AFTER}`, SCRIPT, 0o700);
  await put('state/secret-notes.txt', 'FAKE\n');
  const { step } = await run(`cat ${REAL}/state/OUTSIDE-CMD-MARKER.txt`, sh());
  expect(step.status).toBe('pending');
  const named = JSON.stringify(step);
  expect(named).toContain('config/components/hooks/claude-hooks.yaml');
  expect(named).toContain('outside a plain file under its fleet/assets');
  expect(named).not.toContain('OUTSIDE-CMD-MARKER');
  expect(await stat(join(f.to, 'fleet/assets', AFTER)).catch(() => undefined)).toBeUndefined();
});

test('a longer path that only starts with the v4 home is neither rewritten nor refused', async () => {
  await put(`fleet/assets/${AFTER}`, SCRIPT, 0o700);
  const other = `cat ${REAL}-old/fleet/assets/${BEFORE}`;
  const { step } = await run(other, sh());
  expect(step.status).toBe('converted');
  const text = await hooksYaml();
  expect(text).toContain(other);
  expect(text).toContain(`sh ${f.to}/fleet/assets/${AFTER}`);
  expect(await stat(join(f.to, 'fleet/assets', BEFORE)).catch(() => undefined)).toBeUndefined();
});

test('a home-relative spelling that resolves to the v4 home is carried and rewritten as a whole token', async () => {
  await put(`fleet/assets/${BEFORE}`, 'FAKE notes\n');
  await put(`fleet/assets/${AFTER}`, SCRIPT, 0o700);
  const { step } = await run(`cat "~/.ferretry/fleet/assets/${BEFORE}"`, `sh $HOME/.ferretry/fleet/assets/${AFTER}`);
  expect(step.status).toBe('converted');
  const text = await hooksYaml();
  expect(text).toContain(`${f.to}/fleet/assets/${BEFORE}`);
  expect(text).not.toContain('.ferretry');
});

test('the ${HOME}/ spelling is carried and rewritten', async () => {
  await put(`fleet/assets/${BEFORE}`, 'FAKE notes\n');
  await put(`fleet/assets/${AFTER}`, SCRIPT, 0o700);
  const { step } = await run(cat(), `sh \${HOME}/.ferretry/fleet/assets/${AFTER}`);
  expect(step.status).toBe('converted');
  expect(await hooksYaml()).toContain(`sh ${f.to}/fleet/assets/${AFTER}`);
});

test('a shell operator glued to the token does not make a false refusal', async () => {
  await put(`fleet/assets/${BEFORE}`, 'FAKE notes\n');
  await put(`fleet/assets/${AFTER}`, SCRIPT, 0o700);
  const { step } = await run(`${cat()}|head`, `${sh()};echo done`);
  expect(step.status).toBe('converted');
  const text = await hooksYaml();
  expect(text).toContain(`cat ${f.to}/fleet/assets/${BEFORE}|head`);
  expect(text).toContain(`sh ${f.to}/fleet/assets/${AFTER};echo done`);
});

describe('a path that climbs or is not a file is never carried (the rel stays inside fleet/assets)', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['a .. out of fleet/assets', `${REAL}/fleet/assets/../../state/notes.txt`],
    ['a .. out of a deeper folder', `${REAL}/fleet/assets/components/hooks/../../../../state/notes.txt`],
    ['a .. into fleet but outside assets', `${REAL}/fleet/assets/../config-x.txt`],
    ['a folder', `${REAL}/fleet/assets/components/hooks`],
    ['a folder with a trailing slash', `${REAL}/fleet/assets/components/hooks/`],
  ];
  for (const [name, path] of cases)
    test(name, async () => {
      await put('state/notes.txt', 'FAKE\n');
      await put('fleet/config-x.txt', 'FAKE\n');
      await put(`fleet/assets/${BEFORE}`, 'FAKE notes\n');
      await put(`fleet/assets/${AFTER}`, SCRIPT, 0o700);
      const { step } = await run(`cat ${path}`, sh());
      expect(step.status).toBe('pending');
      expect(JSON.stringify(step)).not.toContain(REAL);
      // Nothing was written outside fleet/assets for it: no copy of the climbed-to file, anywhere.
      for (const file of await everyFile(f.to)) expect(file.endsWith('notes.txt')).toBe(false);
    });
});

test('the accepted record of the item holds the rewritten command, never a v4 path', async () => {
  await put(`fleet/assets/${BEFORE}`, 'FAKE notes\n');
  await put(`fleet/assets/${AFTER}`, SCRIPT, 0o700);
  // v4 enforced this component as written: its accepted record names the component's own text.
  const component = 'harness: claude\nfile: components/hooks/claude-hooks.json\n';
  const etag = createHash('sha256').update(component, 'utf8').digest('hex');
  await put(
    'state/config-accepted.json',
    JSON.stringify({ 'components/hooks/claude-hooks.yaml': { etag, text: component } }),
  );
  const { step } = await run(cat(), sh(), [settingsStep, acceptedConfigStep]);
  expect(step.status).toBe('converted');
  const folder = join(f.to, 'state/kernel/accepted-config');
  const texts = await Promise.all(
    (await readdir(folder)).map(
      async name => (JSON.parse(await readFile(join(folder, name), 'utf8')) as { text: string }).text,
    ),
  );
  const record = texts.find(text => text.includes('PreCompact'));
  expect(record).toBeDefined();
  expect(record).toContain(`cat ${f.to}/fleet/assets/${BEFORE}`);
  expect(record).toContain(`sh ${f.to}/fleet/assets/${AFTER}`);
  expect(record).not.toContain(REAL);
});

test('the checked bytes are what the plan carries, with mode 0600 or 0700 only', async () => {
  await put(`fleet/assets/${BEFORE}`, 'FAKE notes\n', 0o664);
  await put(`fleet/assets/${AFTER}`, SCRIPT, 0o755);
  const ctx = { ...f.ctx(false), previewV4Home: REAL, previewUserHome: USER_HOME };
  const { assets } = await carryAssetReferences(ctx, { a: cat(), b: sh() });
  const byRel = new Map(assets.map(asset => [asset.rel, asset]));
  expect(byRel.get(BEFORE)?.bytes.toString()).toBe('FAKE notes\n');
  expect(byRel.get(BEFORE)?.mode).toBe(0o600);
  expect(byRel.get(AFTER)?.bytes.toString()).toBe(SCRIPT);
  expect(byRel.get(AFTER)?.mode).toBe(0o700);
});

test('the preview stage keeps the owner-execute bit and never group or other bits', async () => {
  await put('layout-version', '2\n');
  await put(`fleet/assets/${BEFORE}`, 'FAKE notes\n', 0o644);
  await put(`fleet/assets/${AFTER}`, SCRIPT, 0o755);
  await put('fleet/assets/components/hooks/group.sh', SCRIPT, 0o770);
  // writeFile honours the umask; set the exact modes.
  await chmod(join(f.from, 'fleet/assets', BEFORE), 0o644);
  await chmod(join(f.from, 'fleet/assets', AFTER), 0o755);
  await chmod(join(f.from, 'fleet/assets/components/hooks/group.sh'), 0o770);
  const staging = join(f.root, 'staging');
  await stage(f.from, staging);
  const modeOf = async (name: string) => (await stat(join(staging, 'fleet/assets', name))).mode & 0o777;
  expect(await modeOf(BEFORE)).toBe(0o600);
  expect(await modeOf(AFTER)).toBe(0o700);
  expect(await modeOf('components/hooks/group.sh')).toBe(0o700);
});

describe('prose in a carried file is not a credential (m1)', () => {
  const prose: readonly (readonly [string, string])[] = [
    ['Basic as a word', 'Basic troubleshooting: restart the daemon\n'],
    ['token as a word', 'token consumption-and-budget\n'],
    ['token before a path', 'token /home/x/notes\n'],
    [
      'a compaction-guidance paragraph',
      'When compacting, keep the plan and the open questions. Basic troubleshooting steps can go. Mention the token ' +
        'budget used so far, and every file path the user named, for example token /home/user/notes/summary.md. ' +
        'Bearer of bad news: say so plainly. Keep the list of decisions and drop the chatter.\n',
    ],
    // n1: a token-like word then a long value that carries digits but is a path or a version, not a credential.
    ['token before a dated path', 'Resume from the token /home/x/notes/2026-11-09/summary.md next time\n'],
    ['token before a home-relative dated path', 'see the token ~/notes/2026-11-09/summary-final.md\n'],
    ['token before a dot-relative dated path', 'the token ./docs/2026-11-09/summary-final.md\n'],
    ['token before a version', 'token v4.291.5-rc.1+build.20261109 is the one to use\n'],
    ['Bearer before a dated path', 'Bearer /var/log/2026-11-09/session-0001.log\n'],
    // M1 keeps these: a path is a path, whatever digits it holds.
    ['token before a path with a log name', 'see the token /var/log/app/2026-11-09/worker-3.log for details\n'],
    ['token before a mixed-case but short path', 'the token /home/User/Docs/notes.md\n'],
    // M1 (round 2): a long file name is a name. Judged by its pieces, not as one 20+ character run.
    ['token before a long hyphenated image name', 'the token ./docs/brand/fleet-grid/png/logomark-16-at-12x.png\n'],
    ['token before a camera file name', 'see the token ~/Downloads/IMG_20261109_101530.jpg\n'],
    [
      'token before a long workflow file name',
      'Rotate the token /home/user/.github/workflows/migration-v4-to-v5.yaml reads.\n',
    ],
    ['Basic before a long findings file name', 'Basic /tmp/work/converter-nits-findings2.md\n'],
    ['token before a camel-case file name with a digit', 'the token /src/main/java/MyServiceImplV2Test.java\n'],
    // n1 (round 2): a Go pseudo-version is a version.
    ['token before a Go pseudo-version', 'the token v0.0.0-20261109153000-a3f9c2e1d4b5 is pinned\n'],
    // m2: a version with a short build suffix is still a version.
    ['token before a release-candidate version', 'the token 1.2.3-rc.1+build.20261109 is current\n'],
    // m1: a reference in quotes is still a reference.
    [
      'an Authorization header with a quoted variable reference',
      `curl -H 'Authorization: Bearer "\${LONG_VARIABLE_NAME_HERE}"' x\n`,
    ],
    // n2: a real header whose value is an environment reference, not a value.
    [
      'an Authorization header that reads its token from the environment',
      'curl -H "Authorization: Bearer ${FERRETRY_HOOK_TOKEN}" x\n',
    ],
    [
      'a Proxy-Authorization header on a long variable',
      'curl -H "Proxy-Authorization: Basic $PROXY_PASSWORD_FROM_THE_ENV" x\n',
    ],
  ];
  for (const [name, text] of prose)
    test(`${name} carries`, async () => {
      await put(`fleet/assets/${BEFORE}`, text);
      await put(`fleet/assets/${AFTER}`, SCRIPT, 0o700);
      const { step } = await run(cat(), sh());
      expect(step.status).toBe('converted');
      expect(await readFile(join(f.to, 'fleet/assets', BEFORE), 'utf8')).toBe(text);
    });
});

describe('the harness homes in a carried file are checked only in a preview (m2)', () => {
  const real = () => ({ ...f.ctx(false) });
  test('a real run carries a file that reads ~/.claude', async () => {
    await put(`fleet/assets/${BEFORE}`, 'cat ~/.claude/notes.txt\n');
    const out = await carryAssetReferences(real(), { a: `cat ${f.from}/fleet/assets/${BEFORE}` });
    expect(out.reasons).toEqual([]);
    expect(out.assets.map(asset => asset.rel)).toEqual([BEFORE]);
  });
  test('a real run still refuses a file that names the v4 home', async () => {
    await put(`fleet/assets/${BEFORE}`, `cat ${f.from}/state/x\n`);
    const out = await carryAssetReferences(real(), { a: `cat ${f.from}/fleet/assets/${BEFORE}` });
    expect(out.assets).toEqual([]);
    expect(out.reasons.join('\n')).toContain('names the v4 home or a harness home');
  });
  test('a preview refuses a file that reads ~/.claude', async () => {
    await put(`fleet/assets/${BEFORE}`, 'cat ~/.claude/notes.txt\n');
    const ctx = { ...f.ctx(false), previewV4Home: REAL, previewUserHome: USER_HOME };
    const out = await carryAssetReferences(ctx, { a: cat() });
    expect(out.assets).toEqual([]);
  });
});

test('a v5 copy whose path a shell would split is refused', async () => {
  await put(`fleet/assets/${BEFORE}`, 'FAKE notes\n');
  const ctx = {
    ...f.ctx(false),
    v5: v5Writer(join(f.root, 'v5 with space'), { dryRun: false }),
    previewV4Home: REAL,
    previewUserHome: USER_HOME,
  };
  const out = await carryAssetReferences(ctx, { a: cat() });
  expect(out.assets).toEqual([]);
  expect(out.reasons.join('\n')).toContain('a shell command would split');
});

describe('fleet/assets/skills has its own step (either case)', () => {
  for (const folder of ['skills', 'Skills'])
    test(`a file under ${folder}/ is refused`, async () => {
      await put(`fleet/assets/${folder}/x.sh`, SCRIPT, 0o700);
      const ctx = { ...f.ctx(false), previewV4Home: REAL, previewUserHome: USER_HOME };
      const out = await carryAssetReferences(ctx, { a: sh(`${folder}/x.sh`) });
      expect(out.assets).toEqual([]);
      expect(out.reasons.join('\n')).toContain('fleet/assets/skills');
    });
});

describe('the mode floor and an unreadable file', () => {
  const carry = async (mode: number) => {
    await put(`fleet/assets/${BEFORE}`, 'FAKE notes\n');
    await chmod(join(f.from, 'fleet/assets', BEFORE), mode);
    const ctx = { ...f.ctx(false), previewV4Home: REAL, previewUserHome: USER_HOME };
    return carryAssetReferences(ctx, { a: cat() });
  };
  test('a read-only source is written 0600', async () => {
    expect((await carry(0o400)).assets[0]?.mode).toBe(0o600);
  });
  test('a read-and-execute source is written 0700', async () => {
    expect((await carry(0o500)).assets[0]?.mode).toBe(0o700);
  });
  test.skipIf(process.getuid?.() === 0)('a file its owner cannot read is called unreadable', async () => {
    const out = await carry(0o000);
    expect(out.assets).toEqual([]);
    expect(out.reasons.join('\n')).toContain('unreadable');
  });
});
