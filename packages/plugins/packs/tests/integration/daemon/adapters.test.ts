/**
 * Packs' adapters. The three that keep documents (the clean-up runs, the replaced routing prompt, each ferret's own
 * switch) run over the kernel's REAL state port and a temp folder; the three that read other plugins (Ferrets, Runtimes,
 * Usage) are handed those plugins' own contract stand-ins, which pass the same conformance suites as the real ones.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { state } from '@ferretry/kernel/host';
import { fakeRuntimes } from '@ferretry/plugin-runtimes/contract/testing';
import { RuntimeIdSchema, type RuntimeSummary, type RuntimesApi } from '@ferretry/plugin-runtimes/contract';
import { instantFromEpochMs } from '@ferretry/std';
import should from 'should';
import {
  PACK_CLEAN_UP_PACK,
  type PackCredentialFacts,
  type RuntimeFactsApi,
  type PackQuotaSource,
} from '../../../contract/index.ts';
import { PackFerrets } from '../../../daemon/adapters/ferrets.ts';
import { FleetFacts } from '../../../daemon/adapters/fleet-facts.ts';
import { RuntimeLaunchProbe } from '../../../daemon/adapters/launch-probe.ts';
import { StateReplacedRouting } from '../../../daemon/adapters/replaced.ts';
import { StateCleanUpRunStore } from '../../../daemon/adapters/run-store.ts';
import { StatePackSwitches } from '../../../daemon/adapters/switches.ts';
import type { CleanUpRun } from '../../../daemon/lib/cleanup/service.ts';
import manifest from '../../../manifest.ts';

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function disk() {
  const home = await mkdtemp(join(tmpdir(), 'fy-packs-state-'));
  homes.push(home);
  const port = state.createStatePort({
    home,
    pluginId: 'packs',
    files: manifest.data.state,
    fs: state.createNodeHostFs(),
  });
  return { home, port, file: (name: string) => join(home, 'state', 'packs', name) };
}

const at = (iso: string) => instantFromEpochMs(Date.parse(iso));

const run = (id: string, startedAt: string, status: 'running' | 'suggested' = 'running'): CleanUpRun => ({
  job: { id, ferret: `ferret-${id}`, name: `clean ${id}`, runtime: 'claude-auto', startedAt: at(startedAt), status },
});

describe('the clean-up run store on disk', () => {
  it('should save a run and load it back, newest first when listed, and forget a run with all its files', async () => {
    const { port } = await disk();
    const store = new StateCleanUpRunStore(port);
    await store.save(run('older', '2026-10-18T08:00:00Z', 'suggested'));
    await store.save(run('newer', '2026-10-18T09:00:00Z'));
    await store.writeFile('older', 'rough.txt', 'a rough prompt');

    const loaded = await store.load('older');
    const listed = await store.list();
    const rough = await store.readFile('older', 'rough.txt');
    await store.remove('older');

    should(loaded).deepEqual(run('older', '2026-10-18T08:00:00Z', 'suggested'));
    should(listed.map(each => each.job.id)).deepEqual(['newer', 'older']);
    should(rough).equal('a rough prompt');
    should(await store.load('older')).be.undefined();
    should(await store.readFile('older', 'rough.txt')).be.undefined();
    should((await store.list()).map(each => each.job.id)).deepEqual(['newer']);
  });

  it('should read a run that was never written, or whose file is damaged, as no run', async () => {
    const { port } = await disk();
    const store = new StateCleanUpRunStore(port);
    await store.save(run('good', '2026-10-18T08:00:00Z'));
    await store.writeFile('broken', 'run.json', '{ not json');
    await store.writeFile('wrong-shape', 'run.json', JSON.stringify({ format: 1, job: { id: 5 } }));

    should(await store.load('missing')).be.undefined();
    should(await store.load('broken')).be.undefined();
    should(await store.load('wrong-shape')).be.undefined();
    should((await store.list()).map(each => each.job.id)).deepEqual(['good']);
  });
});

describe('the replaced routing prompt on disk', () => {
  const replaced = { format: 1 as const, savedAt: at('2026-10-18T08:00:00Z'), source: 'file' as const, text: 'old' };

  it('should keep what the last accepted clean-up replaced, and forget it once written empty', async () => {
    const { port } = await disk();
    const store = new StateReplacedRouting(port);

    const before = await store.read();
    await store.write(replaced);
    const kept = await store.read();
    await store.write(undefined);
    const after = await store.read();

    should(before).be.undefined();
    should(kept).deepEqual(replaced);
    should(after).be.undefined();
  });

  it('should read a damaged document as nothing to undo, never a guess', async () => {
    const { port, file } = await disk();
    const store = new StateReplacedRouting(port);
    await store.write(replaced);
    await writeFile(file('replaced.json'), '{ not json');

    should(await store.read()).be.undefined();
  });
});

describe('each ferret’s own Pack switch on disk', () => {
  it('should answer nothing until a switch is recorded, then what was recorded for each ferret', async () => {
    const { port } = await disk();
    const switches = new StatePackSwitches(port);

    const none = await switches.get('f1');
    await switches.set('f1', false, '2026-10-18T08:00:00Z');
    await switches.set('f2', true, '2026-10-18T08:05:00Z');

    should(none).be.undefined();
    should(await switches.get('f1')).equal(false);
    should(await switches.get('f2')).equal(true);
    should(await switches.get('f3')).be.undefined();
  });

  it('should read a damaged document as no switch recorded, which leaves Pack mode on', async () => {
    const { port, file } = await disk();
    const switches = new StatePackSwitches(port);
    await switches.set('f1', false, '2026-10-18T08:00:00Z');
    await writeFile(file('switches.json'), '{ not json');

    should(await switches.get('f1')).be.undefined();
  });
});

describe('Pack mode’s view of Ferrets', () => {
  function world() {
    const ferrets = new FakeFerrets();
    ferrets.add({ id: ferretId('lead') });
    ferrets.add({ id: ferretId('child'), parent: ferretId('lead'), role: 'helper' });
    ferrets.add({ id: ferretId('grandchild'), parent: ferretId('child'), role: 'helper', mode: 'auto' });
    ferrets.add({ id: ferretId('done'), parent: ferretId('lead'), role: 'helper', state: 'stopped' });
    return { ferrets, view: new PackFerrets(() => ferrets) };
  }

  it('should say how deep a ferret sits and whether Pack mode applies to it', async () => {
    const { view } = world();

    should(await view.depth('lead')).equal(0);
    should(await view.depth('grandchild')).equal(2);
    should(await view.eligible('child')).equal(true);
    should(await view.eligible('missing')).equal(false);
  });

  it('should describe a parent as admission needs it: its depth, whether it is a person’s terminal, and its running helpers', async () => {
    const { view } = world();

    should(await view.parent('lead')).deepEqual({ id: 'lead', interactive: true, depth: 0, runningChildren: 1 });
    should(await view.parent('grandchild')).containDeep({ id: 'grandchild', interactive: false, depth: 2 });
    should(await view.parent('missing')).be.undefined();
  });

  it('should start the hidden builder under its own pack, in the folder it was given, and name it', async () => {
    const { ferrets, view } = world();

    const started = await view.startBuilder({
      runtime: 'claude-auto',
      wrapper: 'claude-auto',
      harness: 'claude-code',
      mode: 'auto',
      prompt: 'rewrite this',
      pack: '',
      name: 'Clean up',
      cwd: '/home/ferretry',
      model: 'opus',
    });

    should(started.id).equal('f1');
    should(ferrets.starts[0]).containDeep({
      role: 'helper',
      by: 'pack',
      pack: PACK_CLEAN_UP_PACK,
      folder: '/home/ferretry',
      prompt: 'rewrite this',
      options: { title: 'Clean up', model: 'opus' },
    });
  });

  it('should report a ferret’s state and stop it with a reason', async () => {
    const { ferrets, view } = world();

    should(await view.state('child')).equal('idle');
    should(await view.state('missing')).be.undefined();
    await view.stop('child', 'it has been read');
    should(ferrets.stops).deepEqual([{ ferret: 'child', how: 'now', reason: 'it has been read' }]);
  });

  it('should raise the refusal sentence when Ferrets will not start the builder', async () => {
    const { ferrets, view } = world();
    ferrets.start = async () => ({ ok: false, error: { code: 'failed', reason: 'no slot is free' } }) as never;

    await view
      .startBuilder({
        runtime: 'r',
        wrapper: 'r',
        harness: 'claude-code',
        mode: 'auto',
        prompt: 'p',
        pack: PACK_CLEAN_UP_PACK,
        name: 'n',
        cwd: '/',
      })
      .then(
        () => should.fail(undefined, undefined, 'the start should have been refused'),
        (error: unknown) => should((error as Error).message).equal('no slot is free'),
      );
  });
});

describe('the start check and the fleet facts, from the Runtimes provider', () => {
  const summary = (id: string, extra: Partial<RuntimeSummary> = {}): RuntimeSummary => ({
    id: RuntimeIdSchema.parse(id),
    harness: 'claude-code',
    login: 'main',
    profile: 'default',
    agent: true,
    launch: { available: true },
    ...extra,
  });
  const runtimes = (...rows: RuntimeSummary[]): RuntimesApi => {
    const fake = fakeRuntimes();
    fake.setRuntimes(rows);
    return fake;
  };
  const clock = (...ticks: number[]) => {
    const rest = [...ticks];
    return () => rest.shift() ?? ticks[ticks.length - 1] ?? 0;
  };
  const request = (wrapper: string) => ({
    wrapper,
    harness: 'claude-code' as const,
    model: 'opus',
    cwd: '/work',
    timeoutMs: 5_000,
  });

  it('should pass a runtime that resolves, timing the check', async () => {
    const probe = new RuntimeLaunchProbe(() => runtimes(summary('claude-auto')), clock(100, 140));

    should(await probe.probe(request('claude-auto'))).deepEqual({ ok: true, ms: 40 });
  });

  it('should say why a runtime cannot be launched, with a code only for a missing sign-in', async () => {
    const signedOut = summary('needs-login', { launch: { available: false, reason: 'Sign in to launch' } });
    const switchedOff = summary('off', { disabled: { reason: 'paused' } });
    const probe = new RuntimeLaunchProbe(() => runtimes(signedOut, switchedOff), clock(0, 5));

    should(await probe.probe(request('needs-login'))).deepEqual({
      ok: false,
      ms: 5,
      reason: 'it cannot be launched: Sign in to launch',
      code: 'not_logged_in',
    });
    const off = await new RuntimeLaunchProbe(() => runtimes(signedOut, switchedOff), clock(0, 0)).probe(request('off'));
    should(off).deepEqual({ ok: false, ms: 0, reason: 'it cannot be launched: off is switched off.' });
  });

  it('should refuse a missing provider and a name that is no runtime, and map a missing login to the same code', async () => {
    should(await new RuntimeLaunchProbe(() => undefined, clock(0, 1)).probe(request('x'))).deepEqual({
      ok: false,
      ms: 1,
      reason: 'Runtimes is off, so nothing can be launched',
    });
    should(await new RuntimeLaunchProbe(() => runtimes(), clock(0, 2)).probe(request('Not A Runtime!'))).deepEqual({
      ok: false,
      ms: 2,
      reason: 'it cannot be launched: no such runtime',
    });
    const noLogin: RuntimesApi = {
      ...runtimes(),
      resolve: async () => ({ ok: false, refusal: 'no_login', sentence: 'There is no login.' }),
    };
    should(await new RuntimeLaunchProbe(() => noLogin, clock(0, 3)).probe(request('any'))).containDeep({
      code: 'not_logged_in',
    });
  });

  const view = (id: string, agent = true) =>
    ({ id, name: id, wrapper: `${id}-wrapper`, harness: 'claude-code', agent }) as never;
  const factsApi = (rows: readonly unknown[]): RuntimeFactsApi => ({
    catalog: async () => rows as never,
    tools: async () => [{ name: 'claude', installed: true }] as never,
  });
  const usage: PackQuotaSource = {
    credentials: async () =>
      [
        { id: 'main', status: { word: 'ready' }, usage: { fiveHour: {}, weekly: {} } },
      ] as readonly PackCredentialFacts[],
    paneLimits: async () => new Map([['main', { notice: 'limit', spend: false }]]),
  };

  it('should gather the catalog, tools, logins and pane limits, naming the runtimes a start would refuse', async () => {
    const launchable = summary('launchable');
    const broken: RuntimesApi = {
      ...runtimes(launchable),
      resolve: async id =>
        id === 'launchable'
          ? { ok: true, runtime: launchable }
          : id === 'unbuildable'
            ? { ok: false, refusal: 'no_profile', sentence: 'unbuildable has no profile.' }
            : id === 'paused'
              ? { ok: false, refusal: 'disabled', sentence: 'paused is switched off.' }
              : { ok: false, refusal: 'not_signed_in', sentence: 'Sign in first.' },
    };
    const facts = await new FleetFacts(
      () => broken,
      () =>
        factsApi([view('launchable'), view('unbuildable'), view('paused'), view('Bad Name!'), view('chore', false)]),
      () => usage,
      () => '2026-10-18T08:00:00Z',
    ).facts();

    should(facts.runtimes.length).equal(5);
    should(facts.tools).deepEqual([{ name: 'claude', installed: true }]);
    should(facts.credentials.map(login => login.id)).deepEqual(['main']);
    should([...(facts.paneLimits?.keys() ?? [])]).deepEqual(['main']);
    should(facts.now).equal('2026-10-18T08:00:00Z');
    should(facts.unlaunchable).deepEqual({
      'unbuildable-wrapper': 'unbuildable has no profile.',
      'Bad Name!-wrapper': 'Bad Name! is not a runtime name',
    });
  });

  it('should offer no runtime, and no quota, when the providers are off', async () => {
    const facts = await new FleetFacts(
      () => undefined,
      () => factsApi([view('ignored')]),
      () => undefined,
      () => '2026-10-18T08:00:00Z',
    ).facts();

    should(facts).deepEqual({
      runtimes: [],
      credentials: [],
      tools: [],
      unlaunchable: {},
      paneLimits: new Map(),
      now: '2026-10-18T08:00:00Z',
    });
  });
});
