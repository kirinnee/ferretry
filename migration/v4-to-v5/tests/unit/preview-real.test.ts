import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { convert } from '../../src/convert.ts';
import { conversationStep } from '../../src/steps/conversation.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { fixture } from './ferret-fixture.ts';

/**
 * The owner's REAL v4 home failed `prepare --owner` (2026-11-09): an attachment manifest whose original is gone failed
 * the conversation step, and settings/hooks components that point at a file, flags or env, and voice.yaml, left the
 * settings step pending (so no home.json). Every name below is FAKE; nothing here touches a real home.
 */
const AT = '2026-11-01T00:00:00.000Z';
const FAKE_SECRET = 'sk-ant-FAKEFAKEFAKEFAKEFAKE0123';
const OUTSIDE_MARKER = 'OUTSIDE-FILE-WAS-READ';

let f: Awaited<ReturnType<typeof fixture>>;
let outside: string;
beforeEach(async () => {
  f = await fixture();
  outside = await mkdtemp(join(tmpdir(), 'fy-outside-'));
});
afterEach(async () => {
  await f.clean();
  await rm(outside, { recursive: true, force: true });
});

const text = async (path: string, content: string | Buffer) => {
  const target = join(f.from, path);
  await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
  await writeFile(target, content, { mode: 0o600 });
};
const allFiles = async (root: string): Promise<string[]> =>
  (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name));

const attachment = (bytes: Buffer) => {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const id = `att_${sha256}`;
  return { id, manifest: { id, filename: 'a.png', mime: 'image/png', size: bytes.length, sha256, createdAt: AT } };
};

/** A copy-shaped home: one good attachment, one manifest with no original, and the three component forms plus voice. */
const build = async () => {
  await text('layout-version', '2\n');
  await f.session('f1');
  const good = attachment(Buffer.from('FAKE good bytes'));
  await f.put(`state/attachments/daemon1/f1/${good.id}/manifest.json`, good.manifest);
  await text(`state/attachments/daemon1/f1/${good.id}/original`, Buffer.from('FAKE good bytes'));
  const lost = attachment(Buffer.from('FAKE lost bytes'));
  await f.put(`state/attachments/daemon1/f1/${lost.id}/manifest.json`, lost.manifest);

  const outsidePath = join(outside, 'settings.json');
  // Readable on purpose: if the converter ever opened it, the marker would land in a v5 file and fail the test.
  await writeFile(outsidePath, JSON.stringify({ marker: OUTSIDE_MARKER }), { mode: 0o600 });
  // (a) flags + env, (b) a file inside the home, (c) a file outside the home.
  await text(
    'config/components/settings/claude-settings.yaml',
    `harness: claude\nflags: ["--verbose"]\nenv:\n  DISABLE_TELEMETRY: "1"\n`,
  );
  await text('fleet/assets/codex/config.toml', 'model = "fake-model"\n[shell_environment_policy]\ninherit = "all"\n');
  await text('config/components/settings/codex-settings.yaml', 'harness: codex\nfile: codex/config.toml\n');
  await text('config/components/settings/outside-settings.yaml', `harness: claude\nfile: ${outsidePath}\n`);
  await text('fleet/assets/hooks/hooks.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash' }] } }));
  await text('config/components/hooks/claude-hooks.yaml', 'harness: claude\nfile: hooks/hooks.json\n');
  await text('config/components/hooks/outside-hooks.yaml', `harness: claude\nfile: ${outsidePath}\n`);
  await text('config/components/hooks/scripts.yaml', 'harness: claude\ndirectory: hooks/scripts\n');
  await text(
    'config/components/settings/secretive.yaml',
    `harness: claude\nenv:\n  ANTHROPIC_AUTH_TOKEN: ${FAKE_SECRET}\n`,
  );
  await text('config/voice.yaml', 'postProcessing:\n  provider: "off"\n');
  return { good, lost, outsidePath };
};

const run = async () =>
  convert({
    from: f.from,
    to: f.to,
    dryRun: false,
    lock: { held: async () => false },
    now: () => new Date('2026-11-09T00:00:00Z'),
    host: { homeDirectory: f.root, env: {} },
    steps: [conversationStep, settingsStep],
  });

test('the real-run shapes convert completely: home.json written, every case named, the outside file never read', async () => {
  const { good, lost } = await build();
  const result = await run();
  if (result.kind !== 'done') throw new Error('expected a run');
  const { report } = result;
  expect(report.complete).toBe(true);
  expect((await stat(join(f.to, 'home.json'))).isFile()).toBe(true);
  const states = Object.fromEntries(report.steps.map(step => [step.id, step.status]));
  expect(states).toEqual({ conversation: 'converted', settings: 'converted' });

  // Conversation: the lost original is counted and named; the good attachment is carried.
  const conversation = report.steps.find(step => step.id === 'conversation');
  expect(conversation?.note).toContain('1 attachments with no original file');
  expect(conversation?.note).toContain(`state/attachments/<daemonId>/f1/${lost.id}`);
  expect(conversation?.note).not.toContain('daemon1');
  expect((await readdir(join(f.to, 'state/conversation/attachments'))).sort()).toEqual([
    `f1~${good.id}.manifest`,
    `f1~${good.id}.original`,
  ]);

  // Settings: (a) inline env, flags named; (b) the inside file inlined; (c) the outside file not carried.
  const claude = await readFile(join(f.to, 'config/claude-code/settings/claude-settings.yaml'), 'utf8');
  expect(claude).toContain('DISABLE_TELEMETRY');
  const codex = await readFile(join(f.to, 'config/codex/settings/codex-settings.yaml'), 'utf8');
  expect(codex).toContain('fake-model');
  expect(
    (await readFile(join(f.to, 'config/claude-code/hooks/claude-hooks.yaml'), 'utf8')).includes('PreToolUse'),
  ).toBe(true);
  const settings = report.steps.find(step => step.id === 'settings');
  const named = (settings?.notCarried ?? []).map(item => `${item.what} :: ${item.why}`).join('\n');
  expect(named).toContain('config/components/settings/claude-settings.yaml flags');
  expect(named).toContain('config/components/settings/outside-settings.yaml file');
  expect(named).toContain('config/components/hooks/outside-hooks.yaml file');
  expect(named).toContain('config/components/hooks/scripts.yaml directory');
  expect(named).toContain('re-create it in v5 Settings; v5 holds');
  expect(named).toContain('config/components/settings/secretive.yaml');
  expect(named).toContain('config/voice.yaml');
  expect(named).toContain('re-enter your voice settings');

  // The outside file was never opened (mode 000 would refuse a reader; its marker is in no v5 file either).
  // And no plain secret is in any v5 file or in the report.
  for (const path of await allFiles(f.to)) {
    const body = await readFile(path).catch(() => Buffer.alloc(0));
    expect(body.includes(OUTSIDE_MARKER)).toBe(false);
    expect(body.includes(FAKE_SECRET)).toBe(false);
  }
  expect(JSON.stringify(report)).not.toContain(FAKE_SECRET);
});

test('a settings file inside the home that is secret-shaped is held by name, never written plain', async () => {
  await text('layout-version', '2\n');
  await text('fleet/assets/s.json', JSON.stringify({ env: { MY_API_KEY: FAKE_SECRET } }));
  await text('config/components/settings/leaky.yaml', 'harness: claude\nfile: s.json\n');
  const result = await run();
  if (result.kind !== 'done') throw new Error('expected a run');
  const settings = result.report.steps.find(step => step.id === 'settings');
  expect(settings?.status).toBe('converted');
  expect((settings?.notCarried ?? []).map(item => item.what)).toContain('config/components/settings/leaky.yaml');
  for (const path of await allFiles(f.to)) expect((await readFile(path)).includes(FAKE_SECRET)).toBe(false);
});

test('preview.sh installs the converter dependencies when node_modules is missing, and names the command when that fails', async () => {
  const script = resolve(import.meta.dir, '../../preview/preview.sh');
  const root = await mkdtemp(join(tmpdir(), 'fy-sh-'));
  try {
    // A copy of the tool tree shape: <root>/tool/preview/preview.sh, no node_modules, a stub bun on PATH.
    const tool = join(root, 'tool');
    await mkdir(join(tool, 'preview'), { recursive: true });
    await writeFile(join(tool, 'preview/preview.sh'), await readFile(script, 'utf8'), { mode: 0o755 });
    const bin = join(root, 'bin');
    await mkdir(bin);
    const stub = (body: string) => writeFile(join(bin, 'bun'), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
    const go = () =>
      spawnSync(
        'bash',
        [join(tool, 'preview/preview.sh'), 'dry-run', '--v4', join(root, 'v4'), '--target', join(root, 'v5')],
        {
          env,
          encoding: 'utf8',
        },
      );

    await stub(
      'if [ "$1" = install ]; then mkdir -p node_modules; echo "$@" >> "${INSTALL_LOG:-/dev/null}"; exit 0; fi\necho "bun $*" >&2\nexit 7',
    );
    const ok = go();
    expect(ok.stdout).toContain("installing the converter's dependencies");
    expect((await stat(join(tool, 'node_modules'))).isDirectory()).toBe(true);

    await rm(join(tool, 'node_modules'), { recursive: true });
    await stub('if [ "$1" = install ]; then exit 3; fi\nexit 7');
    const bad = go();
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('bun install --frozen-lockfile');
    expect(bad.stderr).toContain(tool);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
