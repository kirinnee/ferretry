import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { Harnesses, type FerretId, Runners, StartDecide } from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { testHost } from '../../../testing/index.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { bindDirectory } from '../../../host/bound-directory.ts';

/**
 * An agent's RESUME binds its folder under the state-home policy, on a real temporary disk: the production
 * `bindDirectory` over `nodeFs`, the real Ferrets half, and a fake harness and runner. The project is swapped for a link
 * to `FY_HOME/state` BEFORE the resume binds it, so the folder the resume binds is already forbidden and re-verifying
 * that binding alone would accept it (the swap needs no race). Fixture folders only.
 */
const ferretsHalf = daemonImplementations.find(implementation => implementation.manifest.id === 'ferrets');
if (ferretsHalf?.build === undefined) throw new Error('the generated registry has no ferrets half');
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
  parent = await mkdtemp(join(tmpdir(), 'agent-resume-'));
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

async function stoppedHelper() {
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
  const stopped = await h.request('POST', `/v1/ferrets/${childId}/stop`, {
    headers: asAgent(leadId),
    query: { how: 'now' },
    body: {},
  });
  expect(stopped.status).toBe(200);
  await h.settle();
  await rename(project, `${project}-old`);
  await symlink(join(home, 'state'), project);
  return { h, runner, harness, leadId, childId };
}

test('an agent’s resume into a folder that is the state home at bind time is refused, and the runner starts nothing', async () => {
  const { h, runner, harness, leadId, childId } = await stoppedHelper();
  const before = runner.starts;
  try {
    const resumed = await h.request('POST', `/v1/ferrets/${childId}/resume`, { headers: asAgent(leadId), body: {} });

    expect(resumed.status).toBeGreaterThanOrEqual(400);
    expect(resumed.body).toContain('state home');
    expect(runner.starts).toBe(before);
    expect(harness.launched).toHaveLength(2);
  } finally {
    await h.stop();
  }
});

test('the owner’s resume of the same folder is not fenced out, and launches in the state home as before', async () => {
  const { h, runner, harness, childId } = await stoppedHelper();
  const before = runner.starts;
  try {
    const resumed = await h.request('POST', `/v1/ferrets/${childId}/resume`, { body: {} });

    expect(resumed.status).toBe(200);
    expect(runner.starts).toBe(before + 1);
    expect(await realpath(harness.launched.at(-1)?.folder as string)).toBe(await realpath(join(home, 'state')));
  } finally {
    await h.stop();
  }
});
