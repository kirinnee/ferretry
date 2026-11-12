import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { FerretsPort, Harnesses, type FerretId, Runners, StartDecide } from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
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
async function swappedHelper(stopped: boolean) {
  const runner = new FakeRunner();
  const harness = new FakeHarness();
  const disk = nodeFs(() => crypto.randomUUID());
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
      plugin('packs', { takes: [{ hook: StartDecide }] }, { 'start.decide': async () => ({ allow: true }) }),
    ],
    gate: new StandInAdmission(request => {
      const raw = request.headers.get(caller);
      return raw ? ferretStanding(raw as FerretId) : ownerStanding();
    }),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });
  const lead = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'lead' },
    body: { folder: project },
  });
  expect(lead.status).toBe(201);
  const leadId = lead.json<{ id: string }>().id;
  const child = await h.request('POST', '/v1/ferrets', {
    headers: { ...asAgent(leadId), 'x-fy-request-id': 'child' },
    body: { folder: project },
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

test('the owner’s immediate restart of the same folder is not fenced out', async () => {
  const { h, runner, harness, childId } = await swappedHelper(false);
  try {
    await waiting(h, childId);
    const before = runner.starts;
    const answer = await h.request('POST', '/v1/restarts', { body: { scope: 'ids', ids: [childId] } });
    expect(answer.json<{ restarted: unknown[]; failed: unknown[] }>().restarted).toHaveLength(1);
    expect(runner.starts).toBe(before + 1);
    expect(await stateHome(harness)).toBe(await realpath(join(home, 'state')));
  } finally {
    await h.stop();
  }
});

test('the owner’s QUEUED restart is drained as the owner’s', async () => {
  const { h, runner, childId } = await swappedHelper(false);
  try {
    const queued = await h.request('POST', '/v1/restarts', { body: { scope: 'ids', ids: [childId] } });
    expect(queued.json<{ queued: unknown[] }>().queued).toHaveLength(1);
    await waiting(h, childId);
    const before = runner.starts;
    await h.runJob('restart-drain');
    expect(runner.starts).toBe(before + 1);
  } finally {
    await h.stop();
  }
});

test('a revive through the consumer port as a person is not fenced out', async () => {
  const { h, runner, childId } = await swappedHelper(true);
  try {
    const before = runner.starts;
    const answer = await h
      .provided(FerretsPort, 'warden')
      .resume(childId as FerretId, undefined, { origin: { kind: 'person' } });
    expect(answer.ok).toBe(true);
    expect(runner.starts).toBe(before + 1);
  } finally {
    await h.stop();
  }
});

test('the owner’s send that revives a stopped ferret is not fenced out', async () => {
  const { h, runner, childId } = await swappedHelper(true);
  try {
    const before = runner.starts;
    const answer = await h.request('POST', `/v1/ferrets/${childId}/send`, {
      headers: { 'x-fy-request-id': 'fixture-owner-send-revive' },
      body: { message: 'fixture message' },
    });
    expect(answer.status).toBe(200);
    expect(runner.starts).toBe(before + 1);
  } finally {
    await h.stop();
  }
});
