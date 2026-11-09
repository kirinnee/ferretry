import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepare } from '../../preview/driver.ts';
import { readLoginHarnesses } from '../../preview/harness-map.ts';
import { PREVIEW } from '../../preview/plan.ts';
import { convert } from '../../src/convert.ts';
import {
  acceptedConfigStep,
  previewAuthoredFiles,
  previewHeldFiles,
  v4HeldFiles,
} from '../../src/steps/accepted-config.ts';
import { BOTH_HELD_SENTENCE, CODEX_HELD_SENTENCE, UNKNOWN_HELD_SENTENCE } from '../../src/steps/preview-hold.ts';
import { settingsStep } from '../../src/steps/settings.ts';
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
const accept = async (files: Record<string, string>) =>
  put(
    'state/config-accepted.json',
    JSON.stringify(Object.fromEntries(Object.entries(files).map(([k, t]) => [k, { etag: sha256(t), text: t }]))),
  );

/** Every file under a folder, as one string, to prove a fake key reached none of them. */
const everything = async (folder: string): Promise<string> => {
  const parts: string[] = [];
  for (const path of await readdir(folder, { recursive: true })) {
    const full = join(folder, path);
    if ((await stat(full)).isFile()) parts.push(await readFile(full, 'utf8').catch(() => ''));
  }
  return parts.join('\n');
};

/** A v4 home on the real shapes: runtimes carry no `harness`, the LOGIN names it. Every key here is fake. */
async function realShapes() {
  await put('layout-version', '2\n');
  await put(
    'config/logins/a-login.yaml',
    `harness: claude\nstore: environment\nenv:\n  ANTHROPIC_AUTH_TOKEN: ${FAKE_KEY}\n`,
  );
  await put('config/logins/b-login.yaml', `harness: codex\nstore: environment\nenv:\n  OPENAI_API_KEY: ${FAKE_KEY}\n`);
  await put(
    'config/logins/h-login.yaml',
    'harness: claude\nstore: environment\nclaude:\n  env: {}\ncodex:\n  env: {}\n',
  );
  await put('config/profiles/main.yaml', 'contents: []\n');
  await put('config/runtimes/claude-x.yaml', 'credential: a-login\nprofile: main\n');
  // Named like a Claude runtime, but its login is Codex: the name decides nothing.
  await put('config/runtimes/claude-liar.yaml', 'credential: b-login\nprofile: main\n');
  await put('config/runtimes/codex-y.yaml', 'credential: b-login\nprofile: main\n');
  await put('config/runtimes/both.yaml', 'credential: h-login\nprofile: main\n');
  await put('config/runtimes/ghost.yaml', 'credential: no-such-login\nprofile: main\n');
  await f.session('s1', { agent: 'claude-x', harness: 'claude' });
  await f.session('s2', { agent: 'both', harness: 'claude' });
}
const prepared = () =>
  prepare({
    v4Home: f.from,
    target: f.to,
    lock: { held: async () => false },
    now: () => new Date('2026-11-09T00:00:00Z'),
    home: join(f.root, 'home'),
  });

describe('problem 1: the harness comes from the login, through a stage map that holds that field only', () => {
  test('Claude runtimes convert, Codex ones are held with the Codex reason, unknown ones with the truthful one', async () => {
    await realShapes();
    const done = await prepared();
    expect(done.report?.complete).toBe(true);
    // Claude on a Claude login: converted, and its ferret is carried.
    expect(existsSync(join(f.to, 'config/runtimes/claude-x.yaml'))).toBe(true);
    expect(existsSync(join(f.to, 'state/ferrets/s1/ferret.json'))).toBe(true);
    for (const held of ['claude-liar', 'codex-y', 'both', 'ghost'])
      expect(existsSync(join(f.to, `config/runtimes/${held}.yaml`))).toBe(false);
    const dropped = done.report?.steps.flatMap(step => step.notCarried) ?? [];
    const why = (what: string) => dropped.find(item => item.what === what)?.why;
    expect(why('runtime claude-liar (Codex)')).toBe(CODEX_HELD_SENTENCE);
    expect(why('runtime codex-y (Codex)')).toBe(CODEX_HELD_SENTENCE);
    expect(why('runtime both (its login drives both CLIs)')).toBe(BOTH_HELD_SENTENCE);
    expect(why('runtime ghost (its harness is unknown)')).toBe(UNKNOWN_HELD_SENTENCE);
    expect(UNKNOWN_HELD_SENTENCE).toContain('its harness is unknown');
    expect(UNKNOWN_HELD_SENTENCE).toContain('so it is held like a Codex runtime');
    expect(UNKNOWN_HELD_SENTENCE.startsWith("held: a Codex ferret's")).toBe(false);
    // A ferret on an unknown runtime is held with the unknown reason, not the Codex one.
    expect(why('ferret s2 (on the held runtime both)')).toBe(BOTH_HELD_SENTENCE);
    expect(existsSync(join(f.to, 'state/ferrets/s2/ferret.json'))).toBe(false);
  });

  test('the stage map is login name to harness, and a fake key in a login file appears nowhere', async () => {
    await realShapes();
    const map = await readLoginHarnesses(f.from);
    expect([...map.entries()].sort()).toEqual([
      ['a-login', { harness: 'claude', both: false }],
      ['b-login', { harness: 'codex', both: false }],
      ['h-login', { harness: 'claude', both: true }],
    ]);
    expect(JSON.stringify([...map])).not.toContain('FAKE');
    const done = await prepared();
    expect(JSON.stringify(done.report)).not.toContain(FAKE_KEY);
    expect(done.summary).not.toContain(FAKE_KEY);
    expect(await everything(f.to)).not.toContain(FAKE_KEY);
    expect(existsSync(join(f.to, 'config/logins'))).toBe(false);
  });

  test('a login file that is not YAML, or names no harness, is left out and says nothing', async () => {
    await put('config/logins/junk.yaml', `{ not: yaml: ${FAKE_KEY}`);
    await put('config/logins/none.yaml', `store: environment\nenv:\n  K: ${FAKE_KEY}\n`);
    expect((await readLoginHarnesses(f.from)).size).toBe(0);
  });
});

describe('problem 2: held means what v4 `fy config confirm` lists', () => {
  const MACHINE = 'autoResume: true\nagentControl:\n  pageScripts: true\n';
  const run = async (owner: boolean) => {
    await put('layout-version', '2\n');
    const result = await convert({
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
      ...(owner ? { previewOwner: true } : {}),
    });
    expect(result.kind).toBe('done');
    return result.kind === 'done' ? result.report : undefined;
  };

  test('v4 would list nothing (logins are left out of the preview on purpose): both files are accepted', async () => {
    await put('config/machine.yaml', MACHINE);
    await accept({
      'machine.yaml': MACHINE,
      // The preview does not copy logins, so these look "deleted"; v4 has them and holds nothing.
      'logins/a-login.yaml': 'harness: claude\nbudget:\n  daily:\n    hard: 10\n',
      'logins/b-login.yaml': 'harness: codex\n',
    });
    // An accepted file v4 never reads (not a config path) and one on disk: neither is a held edit.
    await put('config/notes.yaml', 'whatever: true\n');
    const report = await run(true);
    const authored = previewAuthoredFiles(report?.steps ?? []);
    expect(authored).toContain('config/limits.yaml');
    expect(authored).toContain('config/runtimes.yaml');
    expect(previewHeldFiles(report?.steps ?? [])).toEqual([]);
    expect(v4HeldFiles(report?.steps ?? [])).toEqual([]);
  });

  test('v4 would list an edit: the files are not accepted and the report names the v4 file and its kind', async () => {
    await put('config/machine.yaml', MACHINE);
    await accept({ 'machine.yaml': 'autoResume: true\nagentControl:\n  pageScripts: false\n' });
    const report = await run(true);
    expect(previewHeldFiles(report?.steps ?? [])).toContain('config/limits.yaml');
    expect(v4HeldFiles(report?.steps ?? [])).toEqual(['config/machine.yaml (an unconfirmed edit)']);
  });

  test('v4 would list a deletion that loosens (a budgeted login in a real v4, not a preview): named as a deletion', async () => {
    await put('config/machine.yaml', MACHINE);
    await accept({ 'machine.yaml': MACHINE, 'warden.yaml': 'enabled: true\n' });
    const report = await run(true);
    expect(v4HeldFiles(report?.steps ?? [])).toEqual(['config/warden.yaml (a held deletion)']);
  });

  test('an edit v4 applies at once is in effect: a non-loosening runtime or profile change holds nothing', async () => {
    await put('config/machine.yaml', MACHINE);
    await put('config/profiles/main.yaml', 'contents: []\n');
    await put('config/runtimes/r.yaml', 'credential: b-login\nprofile: main\n');
    await accept({
      'machine.yaml': MACHINE,
      'profiles/main.yaml': '# older\ncontents: []\n',
      // Moved from one login to another, but the first had no budget: nothing to confirm.
      'runtimes/r.yaml': 'credential: a-login\nprofile: main\n',
      'logins/a-login.yaml': 'harness: claude\n',
    });
    const report = await run(true);
    expect(v4HeldFiles(report?.steps ?? [])).toEqual([]);
    expect(previewHeldFiles(report?.steps ?? [])).toEqual([]);
  });

  test('a runtime moved off a login whose budget was in effect is a held edit', async () => {
    await put('config/machine.yaml', MACHINE);
    await put('config/profiles/main.yaml', 'contents: []\n');
    await put('config/runtimes/r.yaml', 'credential: b-login\nprofile: main\n');
    await accept({
      'machine.yaml': MACHINE,
      'profiles/main.yaml': 'contents: []\n',
      'runtimes/r.yaml': 'credential: a-login\nprofile: main\n',
      'logins/a-login.yaml': 'harness: claude\nbudget:\n  daily:\n    hard: 10\n',
    });
    const report = await run(true);
    expect(v4HeldFiles(report?.steps ?? [])).toEqual(['config/runtimes/r.yaml (an unconfirmed edit)']);
  });
});
