import { acceptedName } from '@ferretry/kernel/contract';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { sampleLogin } from '../../../../packages/plugins/logins/contract/testing/index.ts';
import { convert } from '../../src/convert.ts';
import { acceptedConfigStep } from '../../src/steps/accepted-config.ts';
import { conversationStep } from '../../src/steps/conversation.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { CONFIG_TARGETS } from '../../src/v5/targets.ts';
import { configPath } from '../../src/v5/write.ts';
import {
  assembleRuntimesModel,
  NO_COMPONENTS,
  type RuntimesFiles,
} from '../../../../packages/plugins/runtimes/daemon/lib/account/runtimes-model.ts';
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

const run = async (extra: { dropUncarried?: boolean } = {}) =>
  convert({
    from: f.from,
    to: f.to,
    dryRun: false,
    lock: { held: async () => false },
    now: () => new Date('2026-11-09T00:00:00Z'),
    host: { homeDirectory: f.root, env: {} },
    steps: [conversationStep, settingsStep],
    ...extra,
  });

const done = async (extra: { dropUncarried?: boolean } = {}) => {
  const result = await run(extra);
  if (result.kind !== 'done') throw new Error('expected a run');
  return result.report;
};

const settingsOf = (report: Awaited<ReturnType<typeof done>>) => {
  const step = report.steps.find(item => item.id === 'settings');
  if (step === undefined) throw new Error('no settings step');
  return step;
};
const namedIn = (step: ReturnType<typeof settingsOf>) =>
  step.notCarried.map(item => `${item.what} :: ${item.why}`).join('\n');

const readV5 = async (path: string) => readFile(join(f.to, path), 'utf8');

/** The model Runtimes assembles from the converted home's profiles and settings/hooks items: no layer may dangle. */
const profileNames = async (): Promise<string[]> =>
  (await readdir(join(f.to, 'config', 'profiles')).catch(() => [] as string[]))
    .map(name => name.replace(/\.yaml$/u, ''))
    .sort(); // readdir order differs between filesystems; the model's profile list is a set
const itemsOf = async (harness: 'claude-code' | 'codex', kind: 'settings' | 'hooks'): Promise<Map<string, unknown>> => {
  const folder = join(f.to, 'config', harness, kind);
  const found = new Map<string, unknown>();
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    const item = parse(await readFile(join(folder, name), 'utf8')) as Record<string, unknown>;
    found.set(name.replace(/\.yaml$/u, ''), {
      harness: harness === 'codex' ? 'codex' : 'claude',
      document: item[kind],
    });
  }
  return found;
};
const modelAccepts = async (): Promise<string[]> => {
  const profiles = new Map<string, { contents: string[] }>();
  for (const name of await profileNames())
    profiles.set(name, parse(await readFile(join(f.to, configPath(CONFIG_TARGETS.PROFILE_ITEMS, name)), 'utf8')));
  const merged = (kind: 'settings' | 'hooks') =>
    (async () => new Map([...(await itemsOf('claude-code', kind)), ...(await itemsOf('codex', kind))]))();
  const files = {
    runtimes: new Map([['claude-default', { login: 'claude-you', profile: 'default', agent: true }]]),
    profiles,
    modelSets: new Map(),
    settings: undefined,
    logins: [sampleLogin('claude-you', { store: 'ferretry' })],
    templates: new Map(),
    components: {
      ...NO_COMPONENTS,
      settings: { state: 'read', components: await merged('settings') },
      hooks: { state: 'read', components: await merged('hooks') },
    },
  } as unknown as RuntimesFiles;
  // `assembleRuntimesModel` parses the WHOLE model with `AccountModelSchema`; a layer that names no component throws.
  return Object.keys(assembleRuntimesModel(files).model.profiles);
};

/** A copy-shaped home: one good attachment, one manifest with no original, and the component forms plus voice. */
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
    `harness: claude\nflags: ["--disallowedTools", "Bash(rm:*)"]\nenv:\n  DISABLE_TELEMETRY: "1"\n`,
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

test('the real-run shapes convert completely: home.json written, every case named, the outside file never read', async () => {
  const { good, lost } = await build();
  const report = await done();
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

  // Settings: (a) flags and env carried; (b) the inside file inlined; (c) the outside file not carried.
  const claude = await readV5('config/claude-code/settings/claude-settings.yaml');
  expect(claude).toContain('DISABLE_TELEMETRY');
  expect(claude).toContain('Bash(rm:*)');
  expect(await readV5('config/codex/settings/codex-settings.yaml')).toContain('fake-model');
  expect((await readV5('config/claude-code/hooks/claude-hooks.yaml')).includes('PreToolUse')).toBe(true);
  const named = namedIn(settingsOf(report));
  expect(named).toContain('config/components/settings/outside-settings.yaml');
  expect(named).toContain('config/components/hooks/outside-hooks.yaml');
  expect(named).toContain('config/components/hooks/scripts.yaml');
  expect(named).toContain('this may have restricted what the agent could do');
  expect(named).toContain('config/components/settings/secretive.yaml');
  // voice.yaml is carried now (Voice declares VOICE_CONFIG), not named as left behind.
  expect(await readV5('config/voice.yaml')).toContain('postProcessing');

  // The outside file was never opened (its marker is in no v5 file either).
  // And no plain secret is in any v5 file or in the report.
  for (const path of await allFiles(f.to)) {
    const body = await readFile(path).catch(() => Buffer.alloc(0));
    expect(body.includes(OUTSIDE_MARKER)).toBe(false);
    expect(body.includes(FAKE_SECRET)).toBe(false);
  }
  expect(JSON.stringify(report)).not.toContain(FAKE_SECRET);
});

const STRAY_MARKER = 'STRAY-TOML-BESIDE-THE-YAML';

test('the owner shape: file: components/<kind>/<name>.<ext> under fleet/assets carries; a stray .toml beside the YAMLs is ignored', async () => {
  await text('layout-version', '2\n');
  await text(
    'config/components/hooks/claude-hooks.yaml',
    'harness: claude\nfile: components/hooks/claude-hooks.json\n',
  );
  await text(
    'fleet/assets/components/hooks/claude-hooks.json',
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] }] } }),
  );
  await text(
    'config/components/settings/claude-settings.yaml',
    'harness: claude\nfile: components/settings/claude-settings.json\n',
  );
  await text(
    'fleet/assets/components/settings/claude-settings.json',
    JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] }, model: 'fake' }),
  );
  await text(
    'config/components/settings/codex-settings.yaml',
    'harness: codex\nfile: components/settings/codex-settings.toml\n',
  );
  await text('fleet/assets/components/settings/codex-settings.toml', 'model = "fake-codex"\n');
  // v4 ignored this one: it sits beside the YAMLs, is no component, and is never carried.
  await text('config/components/settings/codex-settings.toml', `model = "${STRAY_MARKER}"\n`);
  await text(
    'config/profiles/default.yaml',
    'contents:\n  - settings/claude-settings\n  - settings/codex-settings\n  - hooks/claude-hooks\n',
  );
  const report = await done();
  expect(report.complete).toBe(true);
  expect(settingsOf(report).status).toBe('converted');
  expect((await stat(join(f.to, 'home.json'))).isFile()).toBe(true);
  expect(await readV5('config/claude-code/settings/claude-settings.yaml')).toContain('Bash(rm:*)');
  expect(await readV5('config/codex/settings/codex-settings.yaml')).toContain('fake-codex');
  expect(await readV5('config/claude-code/hooks/claude-hooks.yaml')).toContain('PreToolUse');
  expect(await modelAccepts()).toEqual(['default']);
  for (const path of await allFiles(f.to)) expect((await readFile(path)).includes(STRAY_MARKER)).toBe(false);
  expect(JSON.stringify(report)).not.toContain(STRAY_MARKER);
});

test('a bare name under fleet/assets and components/<kind>/<name> both carry', async () => {
  await text('layout-version', '2\n');
  await text('fleet/assets/bare.json', JSON.stringify({ model: 'bare-model' }));
  await text('config/components/settings/bare.yaml', 'harness: claude\nfile: bare.json\n');
  const report = await done();
  expect(settingsOf(report).status).toBe('converted');
  expect(await readV5('config/claude-code/settings/bare.yaml')).toContain('bare-model');
});

describe('v4 fence: a component file carries only when it resolves under fleet/assets/', () => {
  const KEY = 'FAKE-PRIVATE-KEY-MATERIAL-NOT-REAL';
  const notCarried = async (
    yaml: string,
    extra: () => Promise<void> = async () => {},
    wording = 'v4 would not have read it either',
  ) => {
    await text('layout-version', '2\n');
    await text('state/daemon-identity.json', JSON.stringify({ schemaVersion: 1, privateKeyPem: KEY }));
    await extra();
    await text('config/components/settings/probe.yaml', yaml);
    const report = await done({ dropUncarried: true });
    const named = namedIn(settingsOf(report));
    expect(named).toContain('config/components/settings/probe.yaml');
    expect(named).toContain(wording);
    await expect(stat(join(f.to, 'config/claude-code/settings/probe.yaml'))).rejects.toThrow();
    for (const path of await allFiles(f.to)) expect((await readFile(path)).includes(KEY)).toBe(false);
    expect(JSON.stringify(report)).not.toContain(KEY);
    return named;
  };

  test('P1 a `..` climb out of fleet/assets to a key file is not carried', async () => {
    const named = await notCarried('harness: claude\nfile: ../../state/daemon-identity.json\n');
    expect(named).toContain('outside fleet/assets');
  });
  test('P2 an absolute path into the home, outside fleet/assets, is not carried', async () => {
    await notCarried(`harness: claude\nfile: ${f.from}/state/daemon-identity.json\n`);
  });
  test('P3 a ~/ path into the home, outside fleet/assets, is not carried', async () => {
    // The user home is the fixture root, so `~/<v4 dir>/state/...` lands in the v4 home.
    const rel = f.from.slice(f.root.length + 1);
    await notCarried(`harness: claude\nfile: ~/${rel}/state/daemon-identity.json\n`);
  });
  test('P3b a $HOME/ path into the home, outside fleet/assets, is not carried', async () => {
    const rel = f.from.slice(f.root.length + 1);
    await notCarried(`harness: claude\nfile: $HOME/${rel}/config/components/settings/x.json\n`, () =>
      text('config/components/settings/x.json', JSON.stringify({ model: 'x' })),
    );
  });
  test('a path outside the v4 home says v4 read it from outside its home', async () => {
    const named = await notCarried(
      'harness: claude\nfile: ~/notes.json\n',
      () => Promise.resolve(),
      'v4 read this file from outside its home; the preview carries only files under fleet/assets; copy it there to carry it',
    );
    expect(named).not.toContain('would not have read it either');
  });
  test('an absolute path outside the v4 home says the same', async () => {
    await notCarried(
      `harness: claude\nfile: ${outside}/notes.json\n`,
      () => Promise.resolve(),
      'v4 read this file from outside its home',
    );
  });
  test('a path inside the v4 home but outside fleet/assets says v4 would not have read it either', async () => {
    const named = await notCarried('harness: claude\nfile: ../../state/daemon-identity.json\n');
    expect(named).toContain('inside the v4 home but outside fleet/assets');
    expect(named).not.toContain('read this file from outside its home');
  });
  test('a trailing-slash file: is not carried', async () => {
    await notCarried(
      'harness: claude\nfile: ok.json/\n',
      () => text('fleet/assets/ok.json', JSON.stringify({ model: 'ok' })),
      'not a plain file in fleet/assets',
    );
  });
  test('H1 a hard link in fleet/assets to a key file is not carried through a settings component', async () => {
    await notCarried(
      'harness: claude\nfile: h.json\n',
      async () => {
        await mkdir(join(f.from, 'fleet/assets'), { recursive: true });
        await link(join(f.from, 'state/daemon-identity.json'), join(f.from, 'fleet/assets/h.json'));
      },
      'a hard link (v4 refused it)',
    );
  });
  test('H2 a hard link in fleet/assets to a key file is not copied through an instructions component', async () => {
    await text('layout-version', '2\n');
    await text('state/daemon-identity.json', JSON.stringify({ schemaVersion: 1, privateKeyPem: KEY }));
    await mkdir(join(f.from, 'fleet/assets'), { recursive: true });
    await link(join(f.from, 'state/daemon-identity.json'), join(f.from, 'fleet/assets/i.md'));
    await text('config/components/instructions/i.yaml', 'file: i.md\n');
    const report = await done({ dropUncarried: true });
    for (const path of await allFiles(f.to)) expect((await readFile(path)).includes(KEY)).toBe(false);
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(JSON.stringify(report)).toContain('a hard link (v4 refused it)');
    await expect(stat(join(f.to, 'config/instructions/i.md'))).rejects.toThrow();
  });
  test('a bare name present only beside the YAML is not carried', async () => {
    await notCarried(
      'harness: claude\nfile: beside.json\n',
      () => text('config/components/settings/beside.json', JSON.stringify({ model: 'beside' })),
      'not a plain file in fleet/assets',
    );
  });
  test('a components/<kind>/<name> value with the document only beside the YAML is not carried', async () => {
    await notCarried(
      'harness: claude\nfile: components/settings/beside.json\n',
      () => text('config/components/settings/beside.json', JSON.stringify({ model: 'beside' })),
      'not a plain file in fleet/assets',
    );
  });
  test('an absolute or ~/ path that lands UNDER fleet/assets of the home is carried', async () => {
    await text('layout-version', '2\n');
    const rel = f.from.slice(f.root.length + 1);
    await text('fleet/assets/in.json', JSON.stringify({ model: 'in-abs' }));
    await text('config/components/settings/abs.yaml', `harness: claude\nfile: ${f.from}/fleet/assets/in.json\n`);
    await text('config/components/settings/tilde.yaml', `harness: claude\nfile: ~/${rel}/fleet/assets/in.json\n`);
    const report = await done();
    expect(settingsOf(report).status).toBe('converted');
    expect(await readV5('config/claude-code/settings/abs.yaml')).toContain('in-abs');
    expect(await readV5('config/claude-code/settings/tilde.yaml')).toContain('in-abs');
  });
});

describe('m1 flag values never reach the report', () => {
  const SENTINEL = 'SENTINEL-FLAG-VALUE-DO-NOT-ECHO';
  const shapes: [string, string, string][] = [
    ['codex -cKEY=VALUE', 'codex', `  - -cfoo.${'bar'}=${SENTINEL}\n  - --verbose\n`],
    ['claude -k=VALUE', 'claude', `  - -k=${SENTINEL}\n`],
    ['claude --flag=VALUE', 'claude', `  - --flag=${SENTINEL}\n`],
    ['a value starting with -', 'claude', `  - --header\n  - -${SENTINEL}\n`],
  ];
  for (const [label, harness, flags] of shapes)
    test(label, async () => {
      await text('layout-version', '2\n');
      await text('config/components/settings/odd.yaml', `harness: ${harness}\nflags:\n${flags}`);
      await text('config/profiles/default.yaml', 'contents:\n  - settings/odd\n');
      const report = await done();
      const step = settingsOf(report);
      expect(JSON.stringify(report)).not.toContain(SENTINEL);
      expect(namedIn(step)).toContain('config/components/settings/odd.yaml');
      if (label !== 'codex -cKEY=VALUE') expect(step.status).toBe('pending');
    });
});

describe('m2 a cloud voice provider v4 never confirmed stays held', () => {
  const runAccepted = async () => {
    const result = await convert({
      from: f.from,
      to: f.to,
      dryRun: false,
      lock: { held: async () => false },
      now: () => new Date('2026-11-09T00:00:00Z'),
      host: { homeDirectory: f.root, env: {} },
      steps: [settingsStep, acceptedConfigStep],
    });
    if (result.kind !== 'done') throw new Error('expected a run');
    return result.report;
  };
  const records = async () =>
    (await readdir(join(f.to, 'state/kernel/accepted-config')).catch(() => [] as string[])).sort();
  const recordText = async () =>
    (
      JSON.parse(
        await readFile(join(f.to, 'state/kernel/accepted-config', `${acceptedName('voice.yaml')}.json`), 'utf8'),
      ) as { text: string }
    ).text;

  test('P9 the file says groq, v4 enforced off: the v5 file carries groq, the accepted record says off', async () => {
    await text('layout-version', '2\n');
    const live = 'postProcessing:\n  provider: groq\n';
    const enforced = 'postProcessing:\n  provider: "off"\n';
    await text('config/voice.yaml', live);
    await text(
      'state/config-accepted.json',
      JSON.stringify({
        'voice.yaml': { etag: createHash('sha256').update(enforced, 'utf8').digest('hex'), text: enforced },
      }),
    );
    await runAccepted();
    expect(await readV5('config/voice.yaml')).toContain('groq');
    const recorded = await recordText();
    expect(recorded).toContain('off');
    expect(recorded).not.toContain('groq');
  });

  test('P10 a voice.yaml v4 never accepted gets no record, so its groq is judged against the default', async () => {
    await text('layout-version', '2\n');
    await text('config/voice.yaml', 'postProcessing:\n  provider: groq\n');
    await runAccepted();
    expect(await readV5('config/voice.yaml')).toContain('groq');
    expect(await records()).toEqual([]);
  });
});

test('a flags-only component carries Codex -c and Claude --disallowedTools; v4-superseded flags are named, never carried', async () => {
  await text('layout-version', '2\n');
  await text(
    'config/components/settings/deny.yaml',
    'harness: claude\nflags:\n  - --disallowedTools\n  - "Bash(git push:*) Edit"\n  - --disallowed-tools=Write\n  - --permission-mode\n  - bypassPermissions\n',
  );
  await text(
    'config/components/settings/net.yaml',
    'harness: codex\nflags:\n  - -c\n  - sandbox_workspace_write.network_access=false\n  - --config\n  - shell_environment_policy.inherit="core"\n  - -c\n  - sandbox_mode="danger-full-access"\n  - --full-auto\n',
  );
  await text('config/profiles/default.yaml', 'contents:\n  - settings/deny\n  - settings/net\n');
  const report = await done();
  expect(report.complete).toBe(true);
  const deny = parse(await readV5('config/claude-code/settings/deny.yaml')) as {
    settings: { permissions: { deny: string[] } };
  };
  expect(deny.settings.permissions.deny.sort()).toEqual(['Bash(git push:*)', 'Edit', 'Write']);
  const net = parse(await readV5('config/codex/settings/net.yaml')) as { settings: Record<string, unknown> };
  expect(net.settings).toEqual({
    sandbox_workspace_write: { network_access: false },
    shell_environment_policy: { inherit: 'core' },
  });
  // The loosening flags v4 itself discarded are never carried.
  expect(JSON.stringify(net)).not.toContain('danger-full-access');
  expect(JSON.stringify(deny)).not.toContain('bypassPermissions');
  expect(namedIn(settingsOf(report))).toContain('--permission-mode');
  expect(await modelAccepts()).toEqual(['default']);
});

test('an outside-file component: the Settings step is pending by default, naming the component, flag names and profiles', async () => {
  await text('layout-version', '2\n');
  const outsidePath = join(outside, 'settings.json');
  await writeFile(outsidePath, JSON.stringify({ marker: OUTSIDE_MARKER }), { mode: 0o600 });
  await text(
    'config/components/settings/outside.yaml',
    `harness: claude\nfile: ${outsidePath}\nflags:\n  - --strict-mcp-config\n  - --verbose\n  - FAKE-FLAG-VALUE-9\n`,
  );
  await text('config/profiles/careful.yaml', 'contents:\n  - settings/outside\n');
  await text('config/profiles/other.yaml', 'contents:\n  - settings/outside\n');
  await text('config/profiles/unrelated.yaml', 'contents: []\n');
  const report = await done();
  const step = settingsOf(report);
  expect(step.status).toBe('pending');
  expect(report.complete).toBe(false);
  await expect(stat(join(f.to, 'home.json'))).rejects.toThrow();
  const named = namedIn(step);
  expect(named).toContain('config/components/settings/outside.yaml');
  expect(named).toContain('--strict-mcp-config');
  expect(named).toContain('--verbose');
  expect(named).toContain('careful');
  expect(named).toContain('other');
  expect(named).not.toContain('unrelated');
  expect(named).toContain('this may have restricted what the agent could do');
  expect(JSON.stringify(report)).not.toContain('FAKE-FLAG-VALUE-9');
  expect(step.note).toContain('--drop-uncarried');
  expect(step.note).toContain('fix it in v4');
  expect(JSON.stringify(report)).not.toContain(OUTSIDE_MARKER);
  // Nothing is written for the component, and no profile was quietly changed.
  await expect(stat(join(f.to, 'config/claude-code/settings/outside.yaml'))).rejects.toThrow();
  expect(await readV5('config/profiles/careful.yaml').catch(() => '')).toContain('settings/outside');
});

test('--drop-uncarried strips the layer from every profile that names it, names each, and says the ferrets may be less restricted', async () => {
  await text('layout-version', '2\n');
  const outsidePath = join(outside, 'settings.json');
  await writeFile(outsidePath, JSON.stringify({ marker: OUTSIDE_MARKER }), { mode: 0o600 });
  await text('config/components/settings/outside.yaml', `harness: claude\nfile: ${outsidePath}\n`);
  await text('config/components/settings/fine.yaml', 'harness: claude\nenv:\n  A: "1"\n');
  await text('config/profiles/default.yaml', 'contents:\n  - settings/outside\n  - settings/fine\n');
  await text('config/profiles/other.yaml', 'contents:\n  - settings/outside\n');
  const report = await done({ dropUncarried: true });
  expect(report.complete).toBe(true);
  expect(settingsOf(report).status).toBe('converted');
  const named = namedIn(settingsOf(report));
  expect(named).toContain('config/components/settings/outside.yaml');
  expect(named).toContain('default, other');
  expect(named).toContain('LESS restricted than in v4');
  expect(await readV5('config/profiles/default.yaml')).not.toContain('settings/outside');
  expect(await readV5('config/profiles/default.yaml')).toContain('settings/fine');
  expect(await readV5('config/profiles/other.yaml')).not.toContain('settings/outside');
  expect(await modelAccepts()).toEqual(['default', 'other']);
  for (const path of await allFiles(f.to)) expect((await readFile(path)).includes(OUTSIDE_MARKER)).toBe(false);
});

test('env: a ${secret:...} value is not carried, numbers and booleans become text, other values are named; Codex semantics are said', async () => {
  await text('layout-version', '2\n');
  await text(
    'config/components/settings/mixed.yaml',
    'harness: claude\nenv:\n  GH: "${secret:GH}"\n  PORT: 8080\n  ON: true\n  NESTED:\n    a: 1\n',
  );
  await text('config/components/settings/codexenv.yaml', 'harness: codex\nenv:\n  PORT: 8080\n');
  await text('config/profiles/default.yaml', 'contents:\n  - settings/mixed\n  - settings/codexenv\n');
  const report = await done();
  const step = settingsOf(report);
  expect(step.status).toBe('pending');
  const named = namedIn(step);
  expect(named).toContain('env GH');
  expect(named).toContain('env NESTED');
  expect(named).toContain('never inside a settings document');
  expect(named).toContain('NOT the Codex process itself');
  expect(await readV5('config/codex/settings/codexenv.yaml')).toContain('PORT: "8080"');
});

test('m3: a header-shaped value in an inlined file is held, never written plain', async () => {
  await text('layout-version', '2\n');
  const bearer = 'Bearer abcdefghijklmnopqrstuvwxyz012345';
  await text(
    'fleet/assets/c.toml',
    `[mcp_servers.x]\nurl = "https://example.test"\nhttp_headers = { "Authorization" = "${bearer}" }\n`,
  );
  await text('config/components/settings/hdr.yaml', 'harness: codex\nfile: c.toml\n');
  await text('fleet/assets/d.json', JSON.stringify({ note: bearer }));
  await text('config/components/settings/val.yaml', 'harness: claude\nfile: d.json\n');
  const report = await done();
  const named = namedIn(settingsOf(report));
  expect(named).toContain('config/components/settings/hdr.yaml');
  expect(named).toContain('config/components/settings/val.yaml');
  for (const path of await allFiles(f.to))
    expect((await readFile(path)).includes('abcdefghijklmnopqrstuvwxyz')).toBe(false);
});

test('a settings file over 1 MiB is held by name and never read', async () => {
  await text('layout-version', '2\n');
  await text('fleet/assets/big.json', JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 1) }));
  await text('config/components/settings/big.yaml', 'harness: claude\nfile: big.json\n');
  const report = await done();
  expect(namedIn(settingsOf(report))).toContain('over 1 MiB');
  await expect(stat(join(f.to, 'config/claude-code/settings/big.yaml'))).rejects.toThrow();
});

test('links are never followed: a file link in fleet/assets, fleet/assets itself a link, fleet a link', async () => {
  await text('layout-version', '2\n');
  const real = join(outside, 'real.json');
  await writeFile(real, JSON.stringify({ marker: OUTSIDE_MARKER }), { mode: 0o600 });
  // 1. a file link inside fleet/assets
  await mkdir(join(f.from, 'fleet/assets'), { recursive: true });
  await symlink(real, join(f.from, 'fleet/assets/link.json'));
  await text('config/components/settings/filelink.yaml', 'harness: claude\nfile: link.json\n');
  let report = await done();
  expect(namedIn(settingsOf(report))).toContain('config/components/settings/filelink.yaml');
  for (const path of await allFiles(f.to)) expect((await readFile(path)).includes(OUTSIDE_MARKER)).toBe(false);
  await rm(f.to, { recursive: true, force: true });

  // 2. fleet/assets itself a link to a folder outside the home
  await rm(join(f.from, 'fleet/assets'), { recursive: true, force: true });
  await writeFile(join(outside, 'settings.json'), JSON.stringify({ marker: OUTSIDE_MARKER }), { mode: 0o600 });
  await symlink(outside, join(f.from, 'fleet/assets'));
  await text('config/components/settings/s.yaml', 'harness: claude\nfile: settings.json\n');
  report = await done();
  expect(namedIn(settingsOf(report))).toContain('config/components/settings/s.yaml');
  for (const path of await allFiles(f.to)) expect((await readFile(path)).includes(OUTSIDE_MARKER)).toBe(false);
  await rm(f.to, { recursive: true, force: true });

  // 3. a folder link inside fleet/assets on the way to the file
  await rm(join(f.from, 'fleet/assets'), { force: true });
  await mkdir(join(f.from, 'fleet/assets/components'), { recursive: true });
  await writeFile(join(outside, 'h.json'), JSON.stringify({ marker: OUTSIDE_MARKER }), { mode: 0o600 });
  await symlink(outside, join(f.from, 'fleet/assets/components/hooks'));
  await text('config/components/hooks/h.yaml', 'harness: claude\nfile: components/hooks/h.json\n');
  report = await done();
  expect(namedIn(settingsOf(report))).toContain('config/components/hooks/h.yaml');
  for (const path of await allFiles(f.to)) expect((await readFile(path)).includes(OUTSIDE_MARKER)).toBe(false);
});

test('an absolute path inside the real v4 home is read from the snapshot copy; one outside it is not', async () => {
  await text('layout-version', '2\n');
  const real = '/fake-real-home/.ferretry';
  await text('config/components/settings/abs.yaml', `harness: claude\nfile: ${real}/fleet/assets/abs.json\n`);
  await text('fleet/assets/abs.json', JSON.stringify({ model: 'from-copy' }));
  const report = await done();
  // The plain (non-preview) run's real home is the home itself, so a path under a DIFFERENT real home is outside.
  expect(namedIn(settingsOf(report))).toContain('config/components/settings/abs.yaml');
  await rm(f.to, { recursive: true, force: true });
  const mapped = await convert({
    from: f.from,
    to: f.to,
    dryRun: false,
    lock: { held: async () => false },
    now: () => new Date('2026-11-09T00:00:00Z'),
    host: { homeDirectory: '/fake-real-home', env: {} },
    steps: [settingsStep],
    preview: true,
    previewV4Home: real,
    previewUserHome: '/fake-real-home',
  });
  if (mapped.kind !== 'done') throw new Error('expected a run');
  expect(await readV5('config/claude-code/settings/abs.yaml')).toContain('from-copy');
});

test('preview.sh passes --drop-uncarried to prepare only, never to dry-run', async () => {
  const script = resolve(import.meta.dir, '../../preview/preview.sh');
  const root = await mkdtemp(join(tmpdir(), 'fy-sh-drop-'));
  try {
    const tool = join(root, 'tool');
    await mkdir(join(tool, 'preview'), { recursive: true });
    await mkdir(join(tool, 'node_modules/yaml'), { recursive: true });
    await writeFile(join(tool, 'preview/preview.sh'), await readFile(script, 'utf8'), { mode: 0o755 });
    const bin = join(root, 'bin');
    await mkdir(bin);
    const log = join(root, 'args.log');
    // A stub bun: `guard` answers two folders, everything else is logged.
    await writeFile(
      join(bin, 'bun'),
      `#!/usr/bin/env bash\nif [ "$2" = guard ]; then printf '%s\\n%s\\n' "${join(root, 'v4')}" "${join(root, 'v5')}"; exit 0; fi\necho "$*" >> "$INSTALL_LOG"\nexit 0\n`,
      { mode: 0o755 },
    );
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, INSTALL_LOG: log };
    const go = (verb: string) =>
      spawnSync(
        'bash',
        [
          join(tool, 'preview/preview.sh'),
          verb,
          '--drop-uncarried',
          '--v4',
          join(root, 'v4'),
          '--target',
          join(root, 'v5'),
        ],
        { env, encoding: 'utf8' },
      );
    go('dry-run');
    const dry = await readFile(log, 'utf8');
    expect(dry).toContain('dry-run');
    expect(dry).not.toContain('--drop-uncarried');
    await rm(log);
    go('prepare');
    expect(await readFile(log, 'utf8')).toContain('prepare --drop-uncarried');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preview.sh installs the converter dependencies when node_modules is missing or has no yaml, and names the command when that fails', async () => {
  const script = resolve(import.meta.dir, '../../preview/preview.sh');
  const root = await mkdtemp(join(tmpdir(), 'fy-sh-'));
  try {
    // A copy of the tool tree shape: <root>/tool/preview/preview.sh, no node_modules, a stub bun on PATH.
    const tool = join(root, 'tool');
    await mkdir(join(tool, 'preview'), { recursive: true });
    await writeFile(join(tool, 'preview/preview.sh'), await readFile(script, 'utf8'), { mode: 0o755 });
    const bin = join(root, 'bin');
    await mkdir(bin);
    const log = join(root, 'install.log');
    const stub = (body: string) => writeFile(join(bin, 'bun'), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, INSTALL_LOG: log };
    const go = () =>
      spawnSync(
        'bash',
        [join(tool, 'preview/preview.sh'), 'dry-run', '--v4', join(root, 'v4'), '--target', join(root, 'v5')],
        { env, encoding: 'utf8' },
      );

    await stub(
      'if [ "$1" = install ]; then mkdir -p node_modules/yaml; echo "$* in $(pwd)" >> "$INSTALL_LOG"; exit 0; fi\necho "bun $*" >&2\nexit 7',
    );
    const ok = go();
    expect(ok.stdout).toContain("installing the converter's dependencies");
    expect((await stat(join(tool, 'node_modules/yaml'))).isDirectory()).toBe(true);
    // The stub got `install --frozen-lockfile`, and ran in the converter folder.
    const logged = await readFile(log, 'utf8');
    expect(logged).toContain('install --frozen-lockfile');
    expect(logged.trim().endsWith(`in ${await realpath(tool)}`)).toBe(true);

    // A node_modules without yaml also installs.
    await rm(join(tool, 'node_modules'), { recursive: true });
    await mkdir(join(tool, 'node_modules/other'), { recursive: true });
    await rm(log);
    go();
    expect(await readFile(log, 'utf8')).toContain('install --frozen-lockfile');

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
