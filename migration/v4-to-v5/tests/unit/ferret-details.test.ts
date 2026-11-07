import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ferretsStep } from '../../src/steps/ferrets.ts';
import { agentHomesRoot } from '../../src/v5/harness-paths.ts';
import { AT, FAKE_HASH, fixture, RUNTIME } from './ferret-fixture.ts';

type Json = Record<string, unknown>;
type V5Read = { formatFirst: boolean; value: Json } | null;
const REPO = resolve(import.meta.dir, '../../../..');
const LATER = '2026-11-02T00:00:00.000Z';
const PIN_A = '22222222-2222-4222-8222-222222222222';
const PIN_B = '33333333-3333-4333-8333-333333333333';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

/** A whole v4.291.5 `config.json` (SessionConfigSchema + the lifecycle fields), fake values only. */
const v4Config = (id: string, extra: Json = {}): Json => ({
  id,
  incarnation: 'inc-fake-1',
  runtimeGeneration: 2,
  name: 'Fix the fake parser',
  nameSource: 'owner',
  teammate: 'quill',
  label: 'fake-label',
  agent: 'claude-work',
  command: [join(f.from, 'fleet/bin/claude-work'), '--session-id', 'resume-fake'],
  prompt: 'FAKE task brief',
  harness: 'claude',
  modelHint: 'opus',
  model: 'claude-opus-fake',
  launchReasoningEffort: 'high',
  launchFast: false,
  launchSettings: 'digest-fake',
  mode: 'auto',
  remoteControl: false,
  harnessFlags: ['--verbose'],
  cwd: '/work/project',
  tmuxSession: `fy-${id}`,
  createdAt: AT,
  updatedAt: LATER,
  turn: 3,
  intervalSeconds: 30,
  timeoutSeconds: 0,
  nudgeAfterSeconds: 600,
  killAfterSeconds: 0,
  directSendMaxChars: 4000,
  resumeMenuChoice: 'full',
  maxSnapshots: 10,
  retry: { transientAttempts: 3, stalledAttempts: 1, waitForQuotaReset: true, allowAccountFailover: false },
  hypermedia: true,
  pack: true,
  agenda: true,
  compactAt: 'auto',
  focusTask: { id: 'F12' },
  focusAnchor: { id: 'F7' },
  boardSkip: { reason: 'fake skip', at: AT },
  migration: { from: 'claude-old', to: 'claude-work', at: AT },
  migrations: [{ from: 'claude-old', to: 'claude-work', at: AT }],
  conversion: {
    v: 1,
    converter: 1,
    fromHarness: 'codex',
    fromConversation: 'thread-fake',
    fromFile: join(f.from, 'fleet/shared/codex/sessions/2026/11/01/rollout-fake.jsonl'),
    toHarness: 'claude',
    toConversation: 'resume-fake',
    at: AT,
    keptTurns: 2,
    omittedTurns: 0,
  },
  transcript: {
    v: 1,
    identity: 'minted',
    home: join(f.from, 'fleet/homes', RUNTIME),
    file: join(f.from, 'fleet/shared/claude/projects/project/resume-fake.jsonl'),
    harnessSessionId: 'resume-fake',
  },
  sessionCapabilityHash: FAKE_HASH,
  ...extra,
});

const v4State = (id: string, extra: Json = {}): Json => ({
  id,
  status: 'awaiting_user',
  turn: 3,
  pid: 4242,
  startedAt: AT,
  lastActivityAt: LATER,
  turnState: 'your-turn',
  turnStateAt: LATER,
  launchInstructions: { sections: [{ id: 'tools', chars: 10, digest: 'abc' }], mode: 'auto', questions: true },
  queue: [{ internal: 'a key v5 does not list' }],
  ...extra,
});

const pin = (id: string, blockId: string) => ({
  id,
  at: 1,
  kind: 'message',
  blockId,
  blockKind: 'assistant',
  preview: 'fake preview',
  by: 'human',
  createdBy: null,
  createdByName: null,
});

const note = (id: string) => ({
  id,
  at: 2,
  kind: 'note',
  text: 'fake note',
  source: { blockId: 'b1' },
  by: 'agent',
  createdBy: 'lead',
  createdByName: 'Quill',
});

const out = (path: string) => join(f.to, 'state/ferrets', path);
const readJson = async (path: string) => JSON.parse(await readFile(out(path), 'utf8')) as Json;
const exists = async (path: string) => (await stat(out(path)).catch(() => undefined)) !== undefined;

/**
 * v5's REAL readers, run in a subprocess that imports nothing from this tool: each file is decoded exactly as the
 * kernel's state port decodes it (format check, then the Ferrets daemon's own declared schema).
 */
async function readWithV5(ferrets: string[]): Promise<Json> {
  const script = join(f.root, 'verify-v5.ts');
  await writeFile(
    script,
    `
const [repo, home, ...ferrets] = process.argv.slice(2);
const { decodeJson } = await import(repo + '/packages/core/kernel/host/state/format.ts');
const files = await import(repo + '/packages/core/ferrets/contract/index.ts');
const { existsSync, readFileSync } = await import('node:fs');
const read = (def, path) => {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const decoded = decodeJson(def, path, text);
  if (!decoded.ok) throw new Error(decoded.error.sentence);
  return { formatFirst: Object.keys(JSON.parse(text))[0] === 'format', value: decoded.value };
};
const result = { agentPins: read(files.AgentPinsFile, home + '/state/ferrets/agent-pins.json') };
for (const ferret of ferrets) {
  const dir = home + '/state/ferrets/' + ferret;
  result[ferret] = {
    config: read(files.FerretConfigFile, dir + '/config.json'),
    state: read(files.FerretStateFile, dir + '/state.json'),
    pins: read(files.FerretPinsFile, dir + '/pins.json'),
    details: read(files.FerretDetailsFile, dir + '/details.json'),
  };
}
console.log(JSON.stringify(result));
`,
  );
  const child = Bun.spawn(['bun', script, REPO, f.to, ...ferrets], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' });
  const [text, error] = [await new Response(child.stdout).text(), await new Response(child.stderr).text()];
  if ((await child.exited) !== 0) throw new Error(error);
  return JSON.parse(text) as Json;
}

test('config, state, pins, details and pinned ferrets are written and v5 reads every one back', async () => {
  await f.put('state/sessions/lead/config.json', v4Config('lead'));
  await f.put('state/sessions/lead/state.json', v4State('lead'));
  await f.put('state/sessions/lead/pins.json', {
    v: 1,
    sessionId: 'lead',
    pins: [pin(PIN_A, 'b1'), note(PIN_B)],
    updatedAt: AT,
  });
  await f.put('state/sessions/child/config.json', v4Config('child', { parent: 'lead', name: 'Fake helper' }));
  await f.put('state/sessions/child/state.json', v4State('child', { status: 'completed', finishedAt: LATER }));
  await f.put('state/agent-pins.json', {
    version: 1,
    pins: [
      { sessionId: 'child', pinnedAt: AT },
      { sessionId: 'gone', pinnedAt: AT },
      { sessionId: 'lead', pinnedAt: LATER },
    ],
  });
  await writeFile(join(f.from, 'state/sessions/lead/environment.json'), '{"FAKE_SECRET":"never-copied"}');

  const report = await ferretsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept).toEqual(
    expect.arrayContaining([
      { what: 'session config documents', count: 2 },
      { what: 'session state documents', count: 2 },
      { what: 'start options and titles (details.json)', count: 2 },
      { what: 'note and message pins', count: 2 },
      { what: 'pinned ferrets', count: 2 },
    ]),
  );

  const v5 = (await readWithV5(['lead', 'child'])) as Record<string, Record<string, V5Read>>;
  for (const ferret of ['lead', 'child'])
    for (const kind of ['config', 'state', 'details']) expect(v5[ferret]?.[kind]?.formatFirst).toBe(true);
  expect(v5.lead?.pins?.formatFirst).toBe(true);
  expect(v5.child?.pins).toBeNull();
  expect(v5.agentPins as unknown as V5Read).toEqual({
    formatFirst: true,
    value: {
      pins: [
        { sessionId: 'child', pinnedAt: AT },
        { sessionId: 'lead', pinnedAt: LATER },
      ],
    },
  });

  const config = v5.lead?.config?.value as Json;
  const ferret = await readJson('lead/ferret.json');
  // The renamed keys moved (the credential hash as capabilityHash: this ferret is live); every listed key is kept.
  expect(config.move).toEqual({ from: 'claude-old', to: 'claude-work', at: AT });
  expect(config.moves).toEqual([{ from: 'claude-old', to: 'claude-work', at: AT }]);
  expect(config).not.toHaveProperty('migration');
  expect(config).not.toHaveProperty('migrations');
  expect(config).not.toHaveProperty('sessionCapabilityHash');
  expect(config).toMatchObject({
    teammate: 'quill',
    prompt: 'FAKE task brief',
    focusTask: { id: 'F12' },
    boardSkip: { reason: 'fake skip', at: AT },
    capabilityHash: FAKE_HASH,
    retry: { transientAttempts: 3, stalledAttempts: 1, waitForQuotaReset: true, allowAccountFailover: false },
  });
  // Old-home paths now point into the new home; the transcript is the pointer ferret.json carries.
  expect(config.agent).toBe('claude-work');
  expect((config.command as string[])[0]).toBe(join(f.to, 'fleet/bin/claude-work'));
  expect(config.transcript).toEqual(ferret.transcript);
  expect(JSON.stringify(config)).not.toContain(f.from);
  expect((config.conversion as Json).fromFile).toBe(
    join(f.to, agentHomesRoot('codex'), '_shared', 'sessions/2026/11/01/rollout-fake.jsonl'),
  );

  // state.json keeps the v4 status ferret.json's state was decided from; a key v5 does not list (queue) is dropped.
  const state = v5.lead?.state?.value as Json;
  expect(state).toMatchObject({ status: 'awaiting_user', pid: 4242 });
  expect(state).not.toHaveProperty('queue');
  expect(ferret.state).toBe('idle');
  expect((v5.child?.state?.value as Json).status).toBe('completed');
  expect((await readJson('child/ferret.json')).state).toBe('stopped');

  expect(v5.lead?.details?.value).toEqual({
    options: {
      label: 'fake-label',
      card: 'F7',
      model: 'claude-opus-fake',
      effort: 'high',
      fast: false,
      mode: 'auto',
      intervalSeconds: 30,
      timeoutSeconds: 0,
      nudgeAfterSeconds: 600,
      killAfterSeconds: 0,
      directSendMaxChars: 4000,
      resumeMenuChoice: 'full',
      maxSnapshots: 10,
      harnessFlags: ['--verbose'],
      remoteControl: false,
    },
    title: 'Fix the fake parser',
  });
  expect((v5.child?.details?.value as Json).title).toBe('Fake helper');
  expect(((v5.lead?.pins?.value as Json).pins as Json[]).map(item => item.id)).toEqual([PIN_A, PIN_B]);

  expect(await exists('lead/environment.json')).toBe(false);
  expect(JSON.stringify(report)).not.toContain('FAKE');
});

test('strict v5 key lists: unlisted keys are dropped and named, a stopped ferret keeps no hash, state drops attention and nulls', async () => {
  await f.session('f1', { sessionCapabilityHash: FAKE_HASH, oldSetting: 'FAKE-VALUE-1', retiredFlag: true });
  await f.put('state/sessions/f1/state.json', {
    id: 'f1',
    status: 'completed',
    turn: 3,
    attention: { count: 1 },
    pid: null,
    legacyCounter: 'FAKE-VALUE-2',
  });
  const report = await ferretsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  const config = await readJson('f1/config.json');
  expect(Object.keys(config)[0]).toBe('format');
  for (const key of ['oldSetting', 'retiredFlag', 'sessionCapabilityHash', 'capabilityHash'])
    expect(config).not.toHaveProperty(key);
  const state = await readJson('f1/state.json');
  expect(state).toEqual({ format: 1, id: 'f1', status: 'completed', turn: 3 });
  const whats = report.notCarried.map(item => item.what);
  expect(whats).toContain('state/sessions/<sid>/config.json keys: oldSetting, retiredFlag');
  expect(whats).toContain('state/sessions/<sid>/state.json keys: legacyCounter');
  expect(JSON.stringify(report)).not.toContain('FAKE-VALUE');
  const v5 = await readWithV5(['f1']);
  expect((v5.f1 as Json).config).toMatchObject({ formatFirst: true });
  expect((v5.f1 as Json).state).toMatchObject({ formatFirst: true });
});

test('a minimal v4 session gets config.json and details, and no pins or state it never had', async () => {
  await f.session('f1');
  expect((await ferretsStep.run(f.ctx())).status).toBe('converted');
  expect(await readJson('f1/config.json')).toMatchObject({ format: 1, id: 'f1', agent: 'codex-work' });
  // `name` is the title (the fixture's name is its id, a legitimate title); v4's required start facts are its options.
  const details = await readJson('f1/details.json');
  expect(details).toMatchObject({ format: 1, title: 'f1', options: { mode: 'auto', intervalSeconds: 60 } });
  for (const name of ['state.json', 'pins.json', 'agent-pins.json'])
    expect(await exists(name === 'agent-pins.json' ? name : `f1/${name}`)).toBe(false);
});

test('the bare interactive placeholder is not a title, and a refused start option stays in config.json only', async () => {
  await f.session('f1', {
    name: 'interactive',
    harnessFlags: ['--ok', 'bad\u0007flag'],
    focusAnchor: { machineId: 'other-machine', id: 'F9' },
    model: 'gpt-fake',
  });
  expect((await ferretsStep.run(f.ctx())).status).toBe('converted');
  const details = await readJson('f1/details.json');
  expect(details.title).toBeUndefined();
  expect(details.options).toMatchObject({ model: 'gpt-fake' });
  expect((details.options as Json).harnessFlags).toBeUndefined();
  expect((await readJson('f1/config.json')).harnessFlags).toEqual(['--ok', 'bad\u0007flag']);
});

test('damaged or foreign pin files read as no pins, as v4 read them, and are only counted', async () => {
  await f.session('f1');
  await f.session('f2');
  await writeFile(join(f.from, 'state/sessions/f1/pins.json'), '{FAKE-DAMAGED');
  await f.put('state/sessions/f2/pins.json', {
    v: 1,
    sessionId: 'someone-else',
    pins: [pin(PIN_A, 'b')],
    updatedAt: AT,
  });
  await f.put('state/agent-pins.json', { version: 2, pins: [{ sessionId: 'f1', pinnedAt: AT }] });
  const report = await ferretsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept).toContainEqual({ what: 'damaged pin files read as no pins, as v4 read them', count: 3 });
  expect(report.kept).toContainEqual({ what: 'note and message pins', count: 0 });
  for (const path of ['f1/pins.json', 'f2/pins.json', 'agent-pins.json']) expect(await exists(path)).toBe(false);
  expect(JSON.stringify(report)).not.toContain('FAKE');
});

test('a linked pin file is refused without following it', async () => {
  await f.session('f1');
  await symlink('/unreadable/fake-pins', join(f.from, 'state/sessions/f1/pins.json'));
  expect((await ferretsStep.run(f.ctx())).status).toBe('failed');
  expect(await stat(f.to).catch(() => undefined)).toBeUndefined();
});

test('a state.json naming another session fails the step before anything is written', async () => {
  await f.session('f1');
  await f.put('state/sessions/f1/state.json', { id: 'f1', status: 'running', turn: 0 });
  await f.put('state/sessions/f2/config.json', { ...v4Config('f2'), transcript: undefined });
  await f.put('state/sessions/f2/state.json', { id: 'other', status: 'running', turn: 0 });
  expect((await ferretsStep.run(f.ctx())).status).toBe('failed');
  expect(await stat(f.to).catch(() => undefined)).toBeUndefined();
});

test('notCarried no longer lists what config.json and state.json now carry, and still names environment.json', () => {
  const listed = ferretsStep.notCarried.map(item => item.what).join(' | ');
  for (const carried of ['nameSource', 'focusTask', 'migration/migrations', 'state.turn', 'exact v4 state.status'])
    expect(listed).not.toContain(carried);
  expect(listed).toContain('environment.json');
  expect(ferretsStep.reads.join(' ')).toContain('state/agent-pins.json');
});
