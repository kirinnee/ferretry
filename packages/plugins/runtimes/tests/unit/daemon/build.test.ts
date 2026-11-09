/**
 * `runtimesDaemon().build()` and the `runtimes` port it provides, through the kernel's test host (§7.8).
 *
 * The config is the test host's (`config/runtimes/*.yaml` and friends, parsed with the declared schemas); Ferrets is the
 * contract's fake; Logins is a stub of the one shape Runtimes reads (GAP(logins)); the catalogue and setup services are
 * stubs, because what is under test is the assembly: that every route key has a handler, that the port answers over the
 * files, and that a change to the files wakes the views.
 */
import { describe, it } from 'bun:test';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { DaemonImplementation } from '@ferretry/kernel/manifest';
import { type DrivenClock, fixedClock, type TestHost, testHost } from '@ferretry/kernel/testing';
import type { Instant } from '@ferretry/std';
import should from 'should';
import {
  type CatalogInstallChange,
  RuntimeIdSchema,
  RuntimesChanged,
  RuntimesDefaultChanged,
  RuntimesPort,
} from '../../../contract/index.ts';
import { runtimesConformance } from '../../../contract/testing/index.ts';
import { type RuntimesAssembly, runtimesDaemon, unavailableAssembly } from '../../../daemon/index.ts';
import { UNAVAILABLE } from '../../../daemon/lib/service/assembly.ts';
import { LoginChanged, type LoginView } from '@ferretry/plugin-logins/contract';
import { type FakeLogins, fakeLoginChanges, fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import manifest from '../../../manifest.ts';

const login = sampleLogin;

const FILES = {
  runtimes: {
    'claude-default': { login: 'claude-you', profile: 'default', agent: true },
    'codex-work': { login: 'codex-work', profile: 'default' },
  },
  profiles: { default: { contents: [] } },
};

interface Built {
  readonly host: TestHost;
  readonly ferrets: FakeFerrets;
  readonly installs: CatalogInstallChange[];
  readonly logins: ProjectedLogins;
}

interface ProjectedLogins extends FakeLogins {
  /** Make every list read throw (a Logins that cannot answer), or answer again. */
  failReads(failing: boolean): void;
  /** Hold every list read until the answer is released: a slow read, projected at the instant it is released. */
  holdReads(): () => void;
}

/**
 * The contract's fake, read the way the real Logins projects its list: a login's `disabled` is dropped once its
 * `until` has passed (`activeDisable` in Logins' credentials service), so a read at the expiry instant no longer names
 * the block that just ended. A read can also be made to throw.
 */
function projectedLogins(inner: FakeLogins, nowMs: () => number): ProjectedLogins {
  let failing = false;
  let held: Promise<void> | undefined;
  const active = (view: LoginView): LoginView => {
    const until = view.disabled?.until;
    if (until === undefined || Date.parse(until) > nowMs()) return view;
    const { disabled: _expired, ...rest } = view;
    return rest as LoginView;
  };
  return {
    ...inner,
    list: async () => {
      if (held !== undefined) await held;
      if (failing) throw new Error('the logins cannot be read right now');
      const list = await inner.list();
      return { ...list, logins: list.logins.map(active) };
    },
    failReads: next => {
      failing = next;
    },
    holdReads: () => {
      let release = (): void => undefined;
      held = new Promise(resolve => {
        release = () => {
          held = undefined;
          resolve();
        };
      });
      return release;
    },
  };
}

async function build(
  options: {
    readonly config?: Record<string, unknown>;
    readonly logins?: readonly LoginView[];
    readonly assembled?: boolean;
    readonly clock?: DrivenClock;
  } = {},
): Promise<Built> {
  const ferrets = new FakeFerrets();
  const installs: CatalogInstallChange[] = [];
  const logins = projectedLogins(
    fakeLogins(options.logins ?? [login('claude-you'), login('codex-work', { harness: 'codex' })]),
    () => options.clock?.nowMs() ?? Date.now(),
  );
  const assembly = (): RuntimesAssembly => ({
    catalog: {
      installCatalogItem: async (change: CatalogInstallChange) => {
        installs.push(change);
        return {
          outcome: {
            outcome: 'applied',
            apply: {
              outcome: 'committed',
              result: {
                accountCount: 0,
                operationCount: 0,
                manifestPath: '/fy',
                prunedWrappers: [],
                sharedHistory: [],
              },
            },
          },
        };
      },
    } as unknown as RuntimesAssembly['catalog'],
    setup: {} as RuntimesAssembly['setup'],
  });
  const daemon = (
    options.assembled === false ? runtimesDaemon(unavailableAssembly) : runtimesDaemon(assembly)
  ) as DaemonImplementation<any>;
  const host = await testHost({
    plugins: [daemon],
    fakes: { ferrets, logins, loginChanges: fakeLoginChanges() },
    gate: new StandInAdmission(() => ownerStanding()),
    config: options.config ?? FILES,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  return { host, ferrets, installs, logins };
}

describe('the runtimes daemon', () => {
  it('should answer a handler for every route the manifest declares', async () => {
    // Arrange
    const { host } = await build();
    const missing: string[] = [];

    // Act — a handler that exists answers something other than 404 (a refusal or a 200), never "no such route".
    for (const route of manifest.actions.routes) {
      const [method, path] = route.key.split(' ') as [string, string];
      const concrete = path.replace(':proposalId', 'fy_fprop_abcdefghijklmnopqrstuv').replace(':id', 'f-1');
      const response = await host.request(method, concrete, method === 'POST' ? { body: {} } : {});
      if (response.status === 404 && response.json<{ code?: string }>().code !== 'fleet_change_unknown')
        missing.push(route.key);
    }

    // Assert
    should(manifest.actions.routes).have.length(16);
    should(missing).deepEqual([]);
  });

  it('should answer a read in a sentence, not a stack, while the host seams are not wired', async () => {
    // Arrange
    const { host } = await build({ assembled: false });

    // Act
    const machine = await host.request('GET', '/v1/runtimes/machine');

    // Assert
    should(machine.status).equal(409);
    should(machine.json<{ error: string }>().error).containEql(UNAVAILABLE);
  });

  it('should provide a runtimes port that passes the conformance suite', async () => {
    // Arrange
    const { host } = await build();

    // Act
    const result = await runtimesConformance(() => host.provided(RuntimesPort));

    // Assert
    should(result.ok).be.true();
  });

  it('should list the runtimes in name order, each on the harness its login drives', async () => {
    // Arrange
    const { host } = await build();

    // Act
    const list = await host.provided(RuntimesPort).list();

    // Assert
    should(list.map(runtime => [runtime.id, runtime.harness, runtime.agent, runtime.launch.available])).deepEqual([
      ['claude-default', 'claude-code', true, true],
      ['codex-work', 'codex', false, true],
    ]);
  });

  it('should resolve the default setting, else claude-default when it is an agent runtime here', async () => {
    // Arrange
    const unset = await build();
    const named = await build({ config: { ...FILES, 'runtimes.yaml': { defaultRuntime: 'codex-work' } } });
    const noAgent = await build({
      config: { ...FILES, runtimes: { 'claude-default': { login: 'claude-you', profile: 'default' } } },
    });

    // Act / Assert
    should(await unset.host.provided(RuntimesPort).default()).equal('claude-default');
    should(await named.host.provided(RuntimesPort).default()).equal('codex-work');
    should(await noAgent.host.provided(RuntimesPort).default()).be.undefined();
  });

  it('should refuse a start in a sentence for each reason it cannot happen', async () => {
    // Arrange
    const { host } = await build({
      config: {
        runtimes: {
          'claude-default': { login: 'claude-you', profile: 'default', agent: true },
          off: { login: 'claude-you', profile: 'default', disabled: { reason: 'quota' } },
          orphan: { login: 'nobody', profile: 'default', harness: 'codex' },
          headless: { login: 'claude-you', profile: 'ghost' },
        },
        profiles: FILES.profiles,
      },
    });
    const port = host.provided(RuntimesPort);
    const refusal = async (name: string) => {
      const result = await port.resolve(RuntimeIdSchema.parse(name));
      return result.ok ? 'ok' : result.refusal;
    };

    // Act / Assert
    should(await refusal('claude-default')).equal('ok');
    should(await refusal('off')).equal('disabled');
    should(await refusal('orphan')).equal('no_login');
    should(await refusal('headless')).equal('no_profile');
    should(await refusal('missing')).equal('unknown');
    should(await port.resolve()).match({ ok: true });
  });

  it('should not offer a runtime whose login needs sign-in, or whose harness is not on the machine', async () => {
    // Arrange
    const { host } = await build({
      logins: [
        login('claude-you', { status: { ...sampleLogin('claude-you').status, word: 'needs_sign_in' } }),
        login('codex-work', { harness: 'codex' }),
      ],
    });

    // Act
    const list = await host.provided(RuntimesPort).list();
    const blocked = await host.provided(RuntimesPort).resolve(RuntimeIdSchema.parse('claude-default'));

    // Assert
    should(list[0]?.launch).match({ available: false, reason: 'Login claude-you needs sign-in' });
    should(blocked).match({ ok: false, refusal: 'not_signed_in' });
    should(list[1]?.launch.available).be.true();
  });

  it('should expire a block that has an end, with no edit', async () => {
    // Arrange
    const { host } = await build({
      config: {
        ...FILES,
        runtimes: {
          'claude-default': {
            login: 'claude-you',
            profile: 'default',
            disabled: { until: '2000-01-01T00:00:00.000Z' },
          },
        },
      },
    });

    // Act
    const [runtime] = await host.provided(RuntimesPort).list();

    // Assert
    should(runtime?.disabled).be.undefined();
    should(runtime?.launch.available).be.true();
  });

  it('should wake the views once, naming what moved, when a runtime file changes', async () => {
    // Arrange
    const { host } = await build();
    const before = host.published.length;

    // Act
    host.setConfig('runtimes', { ...FILES.runtimes, extra: { login: 'claude-you', profile: 'default' } });
    host.setConfig('runtimes', { ...FILES.runtimes, extra: { login: 'claude-you', profile: 'default' } });

    // Assert — the second write changed nothing, so it says nothing.
    should(host.published.slice(before)).deepEqual([
      { event: RuntimesChanged.name, payload: { runtimes: ['extra'], profiles: [], modelSets: [] } },
    ]);
  });

  it('should wake the views when the default moves, naming the resolved one', async () => {
    // Arrange
    const { host } = await build();
    const before = host.published.length;

    // Act
    host.setConfig('runtimes.yaml', { defaultRuntime: 'codex-work' });
    await host.settle();
    await Promise.resolve();

    // Assert
    should(host.published.slice(before)).deepEqual([
      { event: RuntimesDefaultChanged.name, payload: { defaultRuntime: 'codex-work' } },
    ]);
  });

  it('should publish the profile an installed catalog item landed in', async () => {
    // Arrange
    const { host, installs } = await build();
    const before = host.published.length;
    const change = { kind: 'catalog.install', profile: 'work' } as unknown as CatalogInstallChange;

    // Act
    const outcome = await host.provided(RuntimesPort).installCatalogItem(change);

    // Assert
    should(outcome.outcome).equal('committed');
    should(installs).deepEqual([change]);
    should(host.published.slice(before)).deepEqual([
      { event: RuntimesChanged.name, payload: { runtimes: [], profiles: ['work'], modelSets: [] } },
    ]);
  });

  it('should wake the views at the instant a runtime switched off until a time comes back on (docs/disabling.md)', async () => {
    // Arrange: codex-work is off until 09:30; the clock reads 09:00.
    const clock = fixedClock('2026-11-08T09:00:00.000Z');
    const { host } = await build({
      clock,
      config: {
        ...FILES,
        runtimes: {
          ...FILES.runtimes,
          'codex-work': {
            ...FILES.runtimes['codex-work'],
            disabled: { reason: 'cooling off', until: '2026-11-08T09:30:00Z' },
          },
        },
      },
    });
    await host.settle();
    const before = host.published.length;
    const changed = () => host.published.slice(before).filter(entry => entry.event === RuntimesChanged.name);

    // Act: a minute short, nothing; at 09:30 it is on again and the views hear it.
    await clock.advance(29 * 60_000);
    should(changed()).deepEqual([]);
    await clock.advance(60_000);
    await host.settle();

    // Assert
    should(changed()).deepEqual([
      { event: RuntimesChanged.name, payload: { runtimes: ['codex-work'], profiles: [], modelSets: [] } },
    ]);
  });

  /** Every `runtimes.changed` published after the mark, so a test reads only what its act caused. */
  const changesSince = (host: TestHost) => {
    const before = host.published.length;
    return () => host.published.slice(before).filter(entry => entry.event === RuntimesChanged.name);
  };
  const offUntil = (until: string) => ({ disabled: { reason: 'cooling off', until } });
  const loginOffUntil = (until: string) => ({
    disabled: { reason: 'cooling off', until: until as Instant, source: 'login' as const },
  });
  /** The timer is set after an async read (the logins): a real turn of the event loop lets it land. */
  const quiet = async (host: TestHost) => {
    await host.settle();
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  const named = (...runtimes: string[]) => [
    { event: RuntimesChanged.name, payload: { runtimes, profiles: [], modelSets: [] } },
  ];

  it('should wake the views for every runtime on a login switched off until a time, at that instant', async () => {
    // Arrange: the login codex-work is off until 09:30; the clock reads 09:00.
    const clock = fixedClock('2026-11-08T09:00:00.000Z');
    const { host } = await build({
      clock,
      logins: [
        login('claude-you'),
        login('codex-work', { harness: 'codex', ...loginOffUntil('2026-11-08T09:30:00Z') }),
      ],
    });
    await quiet(host);
    const changed = changesSince(host);

    // Act
    await clock.advance(29 * 60_000);
    should(changed()).deepEqual([]);
    await clock.advance(60_000);
    await quiet(host);

    // Assert
    should(changed()).deepEqual(named('codex-work'));
  });

  it('should move the timer when a runtime file changes its until', async () => {
    // Arrange: codex-work is off until 09:30, then the owner moves it to 09:10.
    const clock = fixedClock('2026-11-08T09:00:00.000Z');
    const runtimesWith = (until: string) => ({
      ...FILES.runtimes,
      'codex-work': { ...FILES.runtimes['codex-work'], ...offUntil(until) },
    });
    const { host } = await build({ clock, config: { ...FILES, runtimes: runtimesWith('2026-11-08T09:30:00Z') } });
    await quiet(host);
    host.setConfig('runtimes', runtimesWith('2026-11-08T09:10:00Z'));
    await quiet(host);
    const changed = changesSince(host);

    // Act
    await clock.advance(10 * 60_000);
    await quiet(host);

    // Assert: it came back at 09:10, and 09:30 brings nothing more.
    should(changed()).deepEqual(named('codex-work'));
    await clock.advance(20 * 60_000);
    await quiet(host);
    should(changed()).deepEqual(named('codex-work'));
  });

  it('should set the timer again when Logins says a login changed', async () => {
    // Arrange: nothing is off at start; then the login codex-work is switched off until 09:30.
    const clock = fixedClock('2026-11-08T09:00:00.000Z');
    const { host, logins } = await build({ clock });
    await quiet(host);
    logins.setLogins([
      login('claude-you'),
      login('codex-work', { harness: 'codex', ...loginOffUntil('2026-11-08T09:30:00Z') }),
    ]);
    host.emit(LoginChanged, { loginId: 'codex-work' as LoginView['id'], change: 'disabled' });
    await quiet(host);
    const changed = changesSince(host);

    // Act
    await clock.advance(30 * 60_000);
    await quiet(host);

    // Assert
    should(changed()).deepEqual(named('codex-work'));
  });

  it('should still wake the views for a runtime switched off until a time while the logins cannot be read', async () => {
    // Arrange: codex-work's own file is off until 09:30, and every read of the logins throws.
    const clock = fixedClock('2026-11-08T09:00:00.000Z');
    const runtimes = {
      ...FILES.runtimes,
      'codex-work': { ...FILES.runtimes['codex-work'], ...offUntil('2026-11-08T09:30:00Z') },
    };
    const { host, logins } = await build({ clock, config: { ...FILES, runtimes }, logins: [] });
    logins.failReads(true);
    host.setConfig('runtimes', { ...runtimes });
    await quiet(host);
    const changed = changesSince(host);

    // Act
    await clock.advance(30 * 60_000);
    await quiet(host);

    // Assert: the runtime still came back, and the operator is told why a login's timed switch is not watched.
    should(changed()).deepEqual(named('codex-work'));
    const warned = host.logs.filter(
      entry => entry.level === 'warn' && entry.message.includes('the logins could not be read'),
    );
    should(warned.length).be.above(0);
    should(warned.every(entry => entry.fields === undefined)).be.true();
  });

  it('should still wake the views for a login whose until passed while a re-read of the logins was in flight', async () => {
    // Arrange: the login codex-work is off until 09:30; the clock reads 09:00 and the timer is set for 09:30.
    const clock = fixedClock('2026-11-08T09:00:00.000Z');
    const { host, logins } = await build({
      clock,
      logins: [
        login('claude-you'),
        login('codex-work', { harness: 'codex', ...loginOffUntil('2026-11-08T09:30:00Z') }),
      ],
    });
    await quiet(host);
    await clock.advance(29 * 60_000);
    const changed = changesSince(host);

    // Act: at 09:29 a runtime file is saved (a re-arm), which drops the timer and reads the logins slowly; the read
    // answers at 09:30, after the until, so Logins no longer names the block.
    const release = logins.holdReads();
    host.setConfig('runtimes', { ...FILES.runtimes });
    await quiet(host);
    await clock.advance(60_000);
    release();
    await quiet(host);
    await clock.advance(0);
    await quiet(host);

    // Assert: the expiry that passed during the read is still published, naming codex-work.
    should(changed()).deepEqual(named('codex-work'));
  });

  it('should publish nothing once the daemon stops, and set no timer for a file change after it', async () => {
    // Arrange: codex-work is off until 09:30.
    const clock = fixedClock('2026-11-08T09:00:00.000Z');
    const runtimesWith = (until: string) => ({
      ...FILES.runtimes,
      'codex-work': { ...FILES.runtimes['codex-work'], ...offUntil(until) },
    });
    const { host } = await build({ clock, config: { ...FILES, runtimes: runtimesWith('2026-11-08T09:30:00Z') } });
    await quiet(host);

    // Act: stop; a file change still arrives during shutdown (moving the until to 09:20); then the hour passes.
    await host.stop();
    host.setConfig('runtimes', runtimesWith('2026-11-08T09:20:00Z'));
    await quiet(host);
    const changed = changesSince(host);
    await clock.advance(60 * 60_000);
    await quiet(host);

    // Assert: no timer survived the stop, and the late change set none.
    should(changed()).deepEqual([]);
  });
});
