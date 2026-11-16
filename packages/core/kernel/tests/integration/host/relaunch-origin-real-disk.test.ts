import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import {
  AutoResumeDecide,
  DAEMON_ORIGIN,
  FerretFiles,
  FerretsPort,
  Harnesses,
  Logins,
  type FerretId,
  RUNTIME_START_KEY,
  RuntimeStart,
  Runners,
  StartDecide,
} from '../../../../ferrets/contract/index.ts';
import {
  FakeHarness,
  FakeLoginKind,
  FakeRunner,
  FakeRuntimeStart,
} from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { type SecretName } from '../../../../vault/contract/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { testHost } from '../../../testing/index.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { bindDirectory } from '../../../host/bound-directory.ts';

/**
 * EVERY relaunch carries the authoritative caller ORIGIN, on a real temporary disk: the production `bindDirectory` over
 * `nodeFs`, the real Ferrets and Conversation halves, and a fake harness and runner. The project is swapped for a link to
 * `FY_HOME/state` BEFORE the relaunch binds it, so the folder it binds is already forbidden and re-verifying that binding
 * alone would accept it (the swap needs no race). An agent's relaunch (an immediate or a queued restart, the Warden's
 * revive through its consumer port, a send that revives) is refused with the runner untouched; the owner's is not.
 * Fixture folders only.
 */
const ferretsHalf = daemonImplementations.find(implementation => implementation.manifest.id === 'ferrets');
const conversationHalf = daemonImplementations.find(implementation => implementation.manifest.id === 'conversation');
if (ferretsHalf?.build === undefined) throw new Error('the generated registry has no ferrets half');
if (conversationHalf === undefined) throw new Error('the generated registry has no conversation half');
const buildFerrets = ferretsHalf.build;

const plugin = (id: string, hooks: ReturnType<typeof definePlugin>['hooks'], provided: Record<string, unknown>) =>
  implementDaemon(
    definePlugin({ id, title: `${id} (fake)`, version: '5.0.0', api: 5, core: false, kinds: [], hooks }),
    { build: () => ({ hooks: provided as never }) },
  );

/** The login the fixture runtime signs in with: a start by runtime resolves to it (v5), and a relaunch reads it again. */
const FIXTURE_LOGIN = 'fixture-login';

/** Runtimes' `runtime.start` for the fixture: `fixture-runtime` runs Claude Code on `FIXTURE_LOGIN`; any other is unknown. */
class FixtureRuntimeStart extends FakeRuntimeStart {
  override async resolve(runtime: string) {
    return runtime === 'fixture-runtime'
      ? ({ ok: true, harness: 'claude-code', login: FIXTURE_LOGIN } as const)
      : await super.resolve(runtime);
  }
}

let parent: string;
let home: string;
let project: string;
beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'relaunch-origin-'));
  home = join(parent, 'fy-home');
  project = join(parent, 'project');
  await mkdir(join(home, 'state'), { recursive: true, mode: 0o700 });
  await mkdir(project, { mode: 0o700 });
});
afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});

const caller = 'x-test-caller';
const asAgent = (ferret: string) => ({ [caller]: ferret });

/** A lead and its helper on a real disk; the project is then swapped for a link into the state home. */
async function swappedHelper(stopped: boolean, stopLead = false) {
  const runner = new FakeRunner();
  const harness = new FakeHarness();
  const disk = nodeFs(() => crypto.randomUUID());
  const vault = new FakeVault();
  await vault.put('LOGIN_FIXTURE_LOGIN' as SecretName, 'fixture-not-a-credential');
  const ferrets = {
    ...ferretsHalf,
    build: (ctx: Parameters<typeof buildFerrets>[0]) =>
      buildFerrets({
        ...ctx,
        kernel: {
          ...ctx.kernel,
          paths: {
            ...ctx.kernel.paths,
            bindDirectory: async (path: string) => await bindDirectory(disk, home, { files: [], recheckMs: 0 }, path),
          },
        },
      }),
  };
  const h = await testHost({
    everyDirectory: true,
    plugins: [
      ferrets as never,
      conversationHalf as never,
      // The consumers whose port is asked for: the Warden's and the Conversation's own.
      implementDaemon(
        definePlugin({
          id: 'warden',
          title: 'Warden (fixture)',
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          needs: { ferrets: FerretsPort },
        }),
        { build: () => ({}) },
      ),
      plugin('claude-code', { takes: [{ hook: Harnesses, key: 'claude-code' }] }, { 'harnesses:claude-code': harness }),
      plugin('terminals', { takes: [{ hook: Runners, key: 'tmux' }] }, { 'runners:tmux': runner }),
      // Packs' own yes on `start.decide` is what admits a helper started by a ferret.
      implementDaemon(
        definePlugin({
          id: 'packs',
          title: 'Packs (fixture)',
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          hooks: { takes: [{ hook: StartDecide }] },
          needs: { ferrets: FerretsPort },
        }),
        { build: () => ({ hooks: { 'start.decide': async () => ({ allow: true }) } as never }) },
      ),
      // The Runtimes hook that lets the boot pass relaunch what the host took down with it.
      plugin(
        'runtimes',
        {
          takes: [{ hook: AutoResumeDecide }, { hook: RuntimeStart, key: RUNTIME_START_KEY }],
        },
        { 'auto-resume.decide': async () => ({ allow: true }), 'runtime.start:runtimes': new FixtureRuntimeStart() },
      ),
      // The kind that holds the fixture login, as in production (it answers the launch environment).
      plugin(
        'logins',
        { takes: [{ hook: Logins, key: 'api-key' }] },
        {
          'logins:api-key': new FakeLoginKind('api-key', [FIXTURE_LOGIN]),
        },
      ),
    ],
    gate: new StandInAdmission(request => {
      const raw = request.headers.get(caller);
      return raw ? ferretStanding(raw as FerretId) : ownerStanding();
    }),
    fakes: { gate: new FakeGate(), vault, asks: new FakeAsks() },
  });
  const lead = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'lead' },
    body: { folder: project, runtime: 'fixture-runtime' },
  });
  expect(lead.status).toBe(201);
  const leadId = lead.json<{ id: string }>().id;
  const child = await h.request('POST', '/v1/ferrets', {
    headers: { ...asAgent(leadId), 'x-fy-request-id': 'child' },
    body: { folder: project, runtime: 'fixture-runtime' },
  });
  expect(child.status).toBe(201);
  const childId = child.json<{ id: string }>().id;
  await h.settle();
  if (stopped) {
    const stop = await h.request('POST', `/v1/ferrets/${childId}/stop`, {
      headers: asAgent(leadId),
      query: { how: 'now' },
      body: {},
    });
    expect(stop.status).toBe(200);
    await h.settle();
  }
  if (stopLead) {
    // Only the agent-created helper is left owed boot recovery: the owner-created lead was stopped on purpose.
    const stop = await h.request('POST', `/v1/ferrets/${leadId}/stop`, { query: { how: 'now' }, body: {} });
    expect(stop.status).toBe(200);
    await h.settle();
  }
  await rename(project, `${project}-old`);
  await symlink(join(home, 'state'), project);
  return { h, runner, harness, leadId, childId };
}

/** The helper declares a wait, which is a moment a restart is attempted. */
async function waiting(h: Awaited<ReturnType<typeof swappedHelper>>['h'], childId: string): Promise<void> {
  const declared = await h.request('POST', `/v1/ferrets/${childId}/signal`, {
    headers: asAgent(childId),
    body: { kind: 'waiting', condition: 'fixture' },
  });
  expect(declared.status).toBe(200);
}

const stateHome = async (harness: FakeHarness): Promise<string> =>
  await realpath(harness.launched.at(-1)?.folder as string);

test('an agent’s immediate restart into a folder that is the state home at bind time is refused, and the runner starts nothing', async () => {
  const { h, runner, leadId, childId } = await swappedHelper(false);
  try {
    await waiting(h, childId);
    const before = runner.starts;
    const answer = await h.request('POST', '/v1/restarts', {
      headers: asAgent(leadId),
      body: { scope: 'ids', ids: [childId] },
    });
    const result = answer.json<{ restarted: unknown[]; failed: unknown[] }>();
    expect(result.restarted).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(runner.starts).toBe(before);
  } finally {
    await h.stop();
  }
});

test('an agent’s QUEUED restart keeps the agent’s origin when the drain runs it, and the runner starts nothing', async () => {
  const { h, runner, leadId, childId } = await swappedHelper(false);
  try {
    const queued = await h.request('POST', '/v1/restarts', {
      headers: asAgent(leadId),
      body: { scope: 'ids', ids: [childId] },
    });
    expect(queued.json<{ queued: unknown[] }>().queued).toHaveLength(1);
    await waiting(h, childId);
    const before = runner.starts;
    await h.runJob('restart-drain');
    expect(runner.starts).toBe(before);
  } finally {
    await h.stop();
  }
});

test('the Warden’s revive through its consumer port runs as the origin it is given: an agent’s is refused', async () => {
  const { h, runner, childId } = await swappedHelper(true);
  try {
    const before = runner.starts;
    const answer = await h
      .provided(FerretsPort, 'warden')
      .resume(childId as FerretId, 'fixture recovery', { origin: { kind: 'agent' }, actor: 'warden', automatic: true });
    expect(answer.ok).toBe(false);
    expect(runner.starts).toBe(before);
  } finally {
    await h.stop();
  }
});

test('an agent’s send that revives a stopped ferret keeps the agent’s origin, and the runner starts nothing', async () => {
  const { h, runner, leadId, childId } = await swappedHelper(true);
  try {
    const before = runner.starts;
    const answer = await h.request('POST', `/v1/ferrets/${childId}/send`, {
      headers: { ...asAgent(leadId), 'x-fy-request-id': 'fixture-send-revive' },
      body: { message: 'fixture message' },
    });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(runner.starts).toBe(before);
  } finally {
    await h.stop();
  }
});

// ─── a ferret first started by an agent is fenced on EVERY relaunch, whoever triggers it ───────────────────────────────

test('a PERSON’s immediate restart of a ferret an agent first started is fenced, and the runner starts nothing', async () => {
  const { h, runner, childId } = await swappedHelper(false);
  try {
    await waiting(h, childId);
    const before = runner.starts;
    const answer = await h.request('POST', '/v1/restarts', { body: { scope: 'ids', ids: [childId] } });
    const result = answer.json<{ restarted: unknown[]; failed: unknown[] }>();
    expect(result.restarted).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(runner.starts).toBe(before);
  } finally {
    await h.stop();
  }
});

test('a PERSON’s QUEUED restart of a ferret an agent first started is fenced when the drain runs it', async () => {
  const { h, runner, childId } = await swappedHelper(false);
  try {
    const queued = await h.request('POST', '/v1/restarts', { body: { scope: 'ids', ids: [childId] } });
    expect(queued.json<{ queued: unknown[] }>().queued).toHaveLength(1);
    await waiting(h, childId);
    const before = runner.starts;
    await h.runJob('restart-drain');
    expect(runner.starts).toBe(before);
  } finally {
    await h.stop();
  }
});

test('a revive through the consumer port as a PERSON of a ferret an agent first started is fenced', async () => {
  const { h, runner, childId } = await swappedHelper(true);
  try {
    const before = runner.starts;
    const answer = await h
      .provided(FerretsPort, 'warden')
      .resume(childId as FerretId, undefined, { origin: { kind: 'person' } });
    expect(answer.ok).toBe(false);
    expect(runner.starts).toBe(before);
  } finally {
    await h.stop();
  }
});

test('the Warden reviving a ferret an agent first started is fenced even when it says it acts for a person', async () => {
  const { h, runner, childId } = await swappedHelper(true);
  try {
    const before = runner.starts;
    const answer = await h.provided(FerretsPort, 'warden').resume(childId as FerretId, 'fixture recovery', {
      origin: { kind: 'person' },
      actor: 'warden',
      automatic: true,
    });
    expect(answer.ok).toBe(false);
    expect(runner.starts).toBe(before);
  } finally {
    await h.stop();
  }
});

test('the owner’s send that revives a ferret an agent first started is fenced', async () => {
  const { h, runner, childId } = await swappedHelper(true);
  try {
    const before = runner.starts;
    const answer = await h.request('POST', `/v1/ferrets/${childId}/send`, {
      headers: { 'x-fy-request-id': 'fixture-owner-send-revive' },
      body: { message: 'fixture message' },
    });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(runner.starts).toBe(before);
  } finally {
    await h.stop();
  }
});

// ─── owner-born ferrets keep working: the same four routes on the lead, whom a person started ─────────────────────────

test('the owner’s immediate restart of an owner-started ferret is not fenced out', async () => {
  const { h, runner, harness, leadId } = await swappedHelper(false);
  try {
    await waiting(h, leadId);
    const before = runner.starts;
    const answer = await h.request('POST', '/v1/restarts', { body: { scope: 'ids', ids: [leadId] } });
    expect(answer.json<{ restarted: unknown[]; failed: unknown[] }>().restarted).toHaveLength(1);
    expect(runner.starts).toBe(before + 1);
    expect(await stateHome(harness)).toBe(await realpath(join(home, 'state')));
  } finally {
    await h.stop();
  }
});

test('the owner’s QUEUED restart of an owner-started ferret is drained as the owner’s', async () => {
  const { h, runner, leadId } = await swappedHelper(false);
  try {
    const queued = await h.request('POST', '/v1/restarts', { body: { scope: 'ids', ids: [leadId] } });
    expect(queued.json<{ queued: unknown[] }>().queued).toHaveLength(1);
    await waiting(h, leadId);
    const before = runner.starts;
    await h.runJob('restart-drain');
    expect(runner.starts).toBe(before + 1);
  } finally {
    await h.stop();
  }
});

test('a revive through the consumer port as a person of an owner-started ferret is not fenced out', async () => {
  const { h, runner, leadId } = await swappedHelper(false, true);
  try {
    const before = runner.starts;
    const answer = await h
      .provided(FerretsPort, 'warden')
      .resume(leadId as FerretId, undefined, { origin: { kind: 'person' } });
    expect(answer.ok).toBe(true);
    expect(runner.starts).toBe(before + 1);
  } finally {
    await h.stop();
  }
});

test('the owner’s send that revives an owner-started ferret is not fenced out', async () => {
  const { h, runner, leadId } = await swappedHelper(false, true);
  try {
    const before = runner.starts;
    const answer = await h.request('POST', `/v1/ferrets/${leadId}/send`, {
      headers: { 'x-fy-request-id': 'fixture-owner-send-revive' },
      body: { message: 'fixture message' },
    });
    expect(answer.status).toBe(200);
    expect(runner.starts).toBe(before + 1);
  } finally {
    await h.stop();
  }
});

test('an owner-started ferret revived by an AGENT is still fenced by the call itself', async () => {
  const { h, runner, leadId } = await swappedHelper(false, true);
  try {
    const before = runner.starts;
    const answer = await h
      .provided(FerretsPort, 'warden')
      .resume(leadId as FerretId, undefined, { origin: { kind: 'agent' } });
    expect(answer.ok).toBe(false);
    expect(runner.starts).toBe(before);
  } finally {
    await h.stop();
  }
});

// ─── the host's boot recovery applies the STORED birth, not the daemon's own origin ───────────────────────────────────

/** Runs the boot pass to its end: the driven clock moves while the pass is pending. */
async function bootPass(h: Awaited<ReturnType<typeof swappedHelper>>['h']): Promise<void> {
  let done = false;
  const pass = h.runJob('ferrets.auto-resume').finally(() => {
    done = true;
  });
  for (let step = 0; step < 60 && !done; step++) {
    await h.clock.advance(1000);
    for (let turn = 0; turn < 40; turn++) {
      await h.clock.advance(0);
      await Bun.sleep(0);
    }
    await h.settle();
  }
  await pass;
  await h.settle();
}

test('boot: a helper an agent first started, owed recovery, stays fenced after the host reboots', async () => {
  // The lead (a person's) is stopped on purpose, so only the agent-created helper is owed; the project is already a link
  // into the state home when the boot pass binds it.
  const f = await swappedHelper(false, true);
  let h = f.h;
  try {
    const before = f.runner.starts;
    f.runner.reboot();
    h = await h.restart();
    await bootPass(h);
    expect(f.runner.starts).toBe(before);
  } finally {
    await h.stop();
  }
});

test('boot: a ferret a person first started, owed recovery, is relaunched', async () => {
  const f = await swappedHelper(true);
  let h = f.h;
  try {
    const before = f.runner.starts;
    f.runner.reboot();
    h = await h.restart();
    await bootPass(h);
    expect(f.runner.starts).toBe(before + 1);
    expect(await stateHome(f.harness)).toBe(await realpath(join(home, 'state')));
  } finally {
    await h.stop();
  }
});

test('boot: a helper stopped on purpose is not revived merely because the daemon restarts', async () => {
  const f = await swappedHelper(true, true);
  let h = f.h;
  try {
    const before = f.runner.starts;
    f.runner.reboot();
    h = await h.restart();
    await bootPass(h);
    expect(f.runner.starts).toBe(before);
  } finally {
    await h.stop();
  }
});

// ─── a record that does not say who started it is fenced; the daemon's own starts are not ──────────────────────────────

/** The stored record of `id` with its birth erased, as a record written before births were kept. */
function eraseBirth(h: Awaited<ReturnType<typeof swappedHelper>>['h'], id: string): void {
  const folder = h.state('ferrets');
  const stored = JSON.parse(folder.raw(FerretFiles, id) as string) as Record<string, unknown>;
  expect(stored.birth).toBeDefined();
  delete stored.birth;
  folder.plant(FerretFiles, JSON.stringify(stored), id);
}

test('a record with NO birth is fenced on a person’s revive, even for the lead a person started', async () => {
  const f = await swappedHelper(false, true);
  let h = f.h;
  try {
    eraseBirth(h, f.leadId);
    f.runner.reboot();
    h = await h.restart();
    const before = f.runner.starts;
    const answer = await h
      .provided(FerretsPort, 'warden')
      .resume(f.leadId as FerretId, undefined, { origin: { kind: 'person' } });
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.error.reason).toContain('does not say who first started it');
    expect(f.runner.starts).toBe(before);
  } finally {
    await h.stop();
  }
});

test('a start the daemon made itself (Packs’ clean-up) is born unfenced and every relaunch stays unfenced', async () => {
  const { h, runner, harness } = await swappedHelper(true);
  try {
    const packs = h.provided(FerretsPort, 'packs');
    const before = runner.starts;
    const started = await packs.start(
      {
        role: 'helper',
        by: 'pack',
        pack: 'clean-up' as never,
        harness: 'claude-code',
        runtime: 'fixture-runtime' as never,
        folder: project,
        prompt: 'fixture clean-up',
      },
      DAEMON_ORIGIN,
    );
    expect(started.ok).toBe(true);
    expect(runner.starts).toBe(before + 1);
    expect(await stateHome(harness)).toBe(await realpath(join(home, 'state')));
    if (!started.ok) return;
    await packs.stop(started.value, 'now');
    await h.settle();
    const revived = await h
      .provided(FerretsPort, 'warden')
      .resume(started.value, undefined, { origin: { kind: 'person' } });
    expect(revived.ok).toBe(true);
    expect(runner.starts).toBe(before + 2);
  } finally {
    await h.stop();
  }
});
