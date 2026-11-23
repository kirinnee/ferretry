import { describe, it } from 'bun:test';
import should from 'should';
import type { KnownHarnessKey } from '@ferretry/core-ferrets/contract';
import type { LoginView } from '@ferretry/plugin-logins/contract';
import type { ProfileFile, RuntimeFile } from '../../../contract/index.ts';
import { stableSuffix } from '../../../daemon/lib/account/derived-runtimes.ts';
import { createRuntimesApi, type RuntimesApiDeps } from '../../../daemon/lib/service/runtimes-api.ts';

const NOW = Date.parse('2026-11-08T12:00:00Z');

const runtimeFile = (over: Partial<RuntimeFile> = {}): RuntimeFile => ({
  login: 'main',
  profile: 'default',
  ...over,
});

/** The parts of a login view the runtimes read; the rest of the wire shape is not this module's. */
const loginView = (over: {
  id?: string;
  harness?: KnownHarnessKey;
  harnesses?: readonly KnownHarnessKey[];
  store?: string;
  word?: string;
  disabled?: LoginView['disabled'];
}) =>
  ({
    id: over.id ?? 'main',
    harness: over.harness ?? 'claude-code',
    harnesses: over.harnesses ?? [over.harness ?? 'claude-code'],
    ...(over.store === undefined ? {} : { store: over.store }),
    status: { word: over.word ?? 'ready' },
    ...(over.disabled === undefined ? {} : { disabled: over.disabled }),
  }) as unknown as LoginView;

interface Rig {
  runtimes?: Record<string, RuntimeFile>;
  profiles?: readonly string[];
  defaultSetting?: string;
  harnesses?: readonly KnownHarnessKey[];
  currentName?: RuntimesApiDeps['currentName'];
  installed?: RuntimesApiDeps['installed'];
  /** The ids of the environment logins whose templates Logins gives clean. */
  templated?: readonly string[];
  /** Logins cannot read the environment templates at all (the call throws). */
  templatesThrow?: boolean;
  logins?: readonly LoginView[] | 'throws';
}

const api = (rig: Rig = {}) =>
  createRuntimesApi({
    runtimes: () => new Map(Object.entries(rig.runtimes ?? { 'claude-default': runtimeFile() })),
    profiles: () => new Map((rig.profiles ?? ['default']).map(name => [name, {} as ProfileFile])),
    defaultSetting: () => rig.defaultSetting,
    harnesses: () => rig.harnesses ?? ['claude-code', 'codex'],
    logins: {
      environmentTemplates: async () => {
        if (rig.templatesThrow === true) throw new Error('templates are unreadable');
        return (rig.templated ?? []).map(id => ({ kind: 'templates', id, harness: 'claude-code' }) as never);
      },
      list: async () => {
        if (rig.logins === 'throws') throw new Error('logins are down');
        return { logins: rig.logins ?? [loginView({})] } as unknown as Awaited<
          ReturnType<RuntimesApiDeps['logins']['list']>
        >;
      },
    },
    now: () => NOW,
    ...(rig.currentName === undefined ? {} : { currentName: rig.currentName }),
    ...(rig.installed === undefined ? {} : { installed: rig.installed }),
  });

describe('createRuntimesApi — list and get', () => {
  it('should list runtimes by name with the harness their login drives and that they can launch', async () => {
    // Arrange
    const runtimes = api({
      runtimes: { zed: runtimeFile(), 'claude-default': runtimeFile({}) },
    });

    // Act
    const actual = await runtimes.list();

    // Assert
    should(actual.map(summary => summary.id)).deepEqual(['claude-default', 'zed']);
    should(actual[0]).containDeep({
      harness: 'claude-code',
      login: 'main',
      profile: 'default',
      launch: { available: true },
    });
    should(await runtimes.get('absent' as never)).be.undefined();
  });

  it('should prefer the harness a runtime file names over its login', async () => {
    // Act
    const actual = await api({
      runtimes: { work: runtimeFile({ harness: 'codex' }) },
      logins: [loginView({ harness: 'claude-code' })],
    }).list();

    // Assert
    should(actual[0]?.harness).equal('codex');
  });

  it('should leave out a runtime whose login this machine does not know and whose file names no harness', async () => {
    // Act
    const actual = await api({ runtimes: { ghost: runtimeFile({ login: 'gone' }) }, logins: [] }).list();

    // Assert
    should(actual).deepEqual([]);
  });

  it('should know no login at all when Logins cannot answer, and so list nothing', async () => {
    // Act
    const actual = await api({ logins: 'throws' }).list();

    // Assert
    should(actual).deepEqual([]);
  });

  it('should still list a runtime whose file names its harness when its login is unknown', async () => {
    // Act
    const actual = await api({ runtimes: { work: runtimeFile({ harness: 'codex' }) }, logins: [] }).list();

    // Assert
    should(actual[0]).containDeep({
      harness: 'codex',
      launch: { available: false, reason: 'Login main does not exist' },
    });
  });
});

describe('createRuntimesApi — why a start cannot happen', () => {
  const reasonOf = async (rig: Rig): Promise<string | undefined> => {
    const [summary] = await api(rig).list();
    return summary !== undefined && !summary.launch.available ? summary.launch.reason : undefined;
  };

  it('should name the runtime when its own file switches it off, with the reason and the day', async () => {
    // Act
    const reason = await reasonOf({
      runtimes: { 'claude-default': runtimeFile({ disabled: { reason: 'billing', until: '2026-12-01' } }) },
    });

    // Assert
    should(reason).equal('claude-default is switched off (billing) until 2026-12-01T00:00:00.000Z');
  });

  it('should name the login when only the login is switched off', async () => {
    // Act
    const reason = await reasonOf({ logins: [loginView({ disabled: { source: 'login' } })] });

    // Assert
    should(reason).equal('Its login main is switched off');
  });

  it('should treat a switch-off whose until has passed as gone', async () => {
    // Act
    const [summary] = await api({
      runtimes: { 'claude-default': runtimeFile({ disabled: { reason: 'old', until: '2026-01-01' } }) },
    }).list();

    // Assert
    should(summary?.launch).deepEqual({ available: true });
    should(summary?.disabled).be.undefined();
  });

  it('should say the profile is missing', async () => {
    should(await reasonOf({ profiles: [] })).equal('Profile default does not exist');
  });

  it('should say a login that needs sign-in does', async () => {
    should(await reasonOf({ logins: [loginView({ word: 'needs_sign_in' })] })).equal('Login main needs sign-in');
  });

  it('should say the harness is not on this machine', async () => {
    should(await reasonOf({ harnesses: ['codex'] })).equal('claude-code is not on this machine');
  });
});

describe('createRuntimesApi — default runtime', () => {
  it('should use the named default over everything', async () => {
    should(
      await api({ defaultSetting: 'zed', runtimes: { zed: runtimeFile(), 'claude-default': runtimeFile() } }).default(),
    ).equal('zed');
  });

  it('should read a saved default that is no longer a runtime as unset (2 logins, the saved one needs sign-in)', async () => {
    // Arrange — "claude-out" was a derived runtime; its login now needs sign-in, so nothing derives it any more.
    const logins = [loginView({ id: 'claude-two' }), loginView({ id: 'claude-out', word: 'needs_sign_in' })];

    // Act
    const actual = await api({ runtimes: {}, logins, defaultSetting: 'claude-out' }).default();

    // Assert — the first runtime that can start, not the dangling name
    should(actual).equal('claude-two');
  });

  it('should fall back to claude-default, else the first runtime that can launch, else nothing', async () => {
    should(await api().default()).equal('claude-default');
    // No runtime file: the ready login's own runtime is the default.
    should(await api({ runtimes: {} }).default()).equal('main');
    should(await api({ runtimes: {}, logins: [] }).default()).be.undefined();
  });
});

describe('createRuntimesApi — resolve', () => {
  it('should refuse with unknown when nothing is named and the machine has no default', async () => {
    // Act
    const actual = await api({ runtimes: {}, logins: [] }).resolve(undefined);

    // Assert
    should(actual).deepEqual({
      ok: false,
      refusal: 'unknown',
      sentence: 'no runtime was named, and this machine has no default runtime for new agents',
    });
  });

  it('should resolve the default runtime when nothing is named', async () => {
    // Act
    const actual = await api().resolve(undefined);

    // Assert
    should(actual.ok).be.true();
    if (actual.ok) should(actual.runtime.id).equal('claude-default');
  });

  it('should refuse with unknown for a runtime that does not exist', async () => {
    should(await api().resolve('nope' as never)).deepEqual({
      ok: false,
      refusal: 'unknown',
      sentence: 'no runtime nope exists on this machine',
    });
  });

  it('should resolve a name a runtime was renamed from to the runtime it is now', async () => {
    const actual = await api({
      runtimes: { play: runtimeFile() },
      currentName: async former => (former === 'work' ? 'play' : undefined),
    }).resolve('work' as never);

    should(actual.ok).be.true();
    if (actual.ok) should(actual.runtime.id).equal('play');
  });

  it('should refuse a former name whose current runtime is no longer configured, or that cannot be read', async () => {
    const gone = await api({ runtimes: {}, currentName: async () => 'play' }).resolve('work' as never);
    const unreadable = await api({
      runtimes: { play: runtimeFile() },
      currentName: async () => {
        throw new Error('ids.json could not be read');
      },
    }).resolve('work' as never);

    should(gone).containDeep({ ok: false, refusal: 'unknown' });
    should(unreadable).containDeep({ ok: false, refusal: 'unknown' });
  });

  it('should refuse with no_login when no harness can be named for the runtime', async () => {
    // Act
    const actual = await api({ runtimes: { ghost: runtimeFile({ login: 'gone' }) }, logins: [] }).resolve(
      'ghost' as never,
    );

    // Assert
    should(actual).containDeep({ ok: false, refusal: 'no_login' });
    if (!actual.ok)
      should(actual.sentence).containEql('ghost runs on the login gone, which this machine does not know');
  });

  it('should refuse with no_login when the harness is named but the login is not there', async () => {
    // Act
    const actual = await api({ runtimes: { work: runtimeFile({ harness: 'codex' }) }, logins: [] }).resolve(
      'work' as never,
    );

    // Assert
    should(actual).deepEqual({ ok: false, refusal: 'no_login', sentence: 'Login main does not exist' });
  });

  it('should refuse with disabled and the reason it was switched off', async () => {
    // Act
    const actual = await api({
      runtimes: { 'claude-default': runtimeFile({ disabled: { reason: 'billing' } }) },
    }).resolve('claude-default' as never);

    // Assert
    should(actual).deepEqual({
      ok: false,
      refusal: 'disabled',
      sentence: 'claude-default is switched off (billing)',
    });
  });

  it('should refuse with no_profile when the profile is missing', async () => {
    should(await api({ profiles: [] }).resolve('claude-default' as never)).deepEqual({
      ok: false,
      refusal: 'no_profile',
      sentence: 'Profile default does not exist',
    });
  });

  it('should refuse with not_signed_in when the login needs sign-in or the harness is off the machine', async () => {
    should(await api({ logins: [loginView({ word: 'needs_sign_in' })] }).resolve('claude-default' as never)).deepEqual({
      ok: false,
      refusal: 'not_signed_in',
      sentence: 'Login main needs sign-in',
    });
    should(await api({ harnesses: [] }).resolve('claude-default' as never)).deepEqual({
      ok: false,
      refusal: 'not_signed_in',
      sentence: 'claude-code is not on this machine',
    });
  });
});

describe('createRuntimesApi — adding an account makes its runtime (runtimes plan U3)', () => {
  it('should list a runtime for a login the moment it is added, named after it, on the profile of its harness', async () => {
    // Arrange — the same files, read before and after a login is added
    const before = api({ runtimes: {}, logins: [loginView({ id: 'atomi' })] });
    const after = api({
      runtimes: {},
      logins: [
        loginView({ id: 'atomi' }),
        loginView({ id: 'kimi', store: 'environment', harnesses: ['claude-code', 'codex'] }),
      ],
      templated: ['kimi'],
    });

    // Act
    const [listedBefore, listedAfter] = [await before.list(), await after.list()];

    // Assert — nothing was written: the files are empty both times
    should(listedBefore.map(summary => summary.id)).deepEqual(['atomi']);
    should(listedAfter.map(summary => summary.id)).deepEqual(['atomi', 'kimi']);
    should(listedAfter[1]).containDeep({ login: 'kimi', profile: 'ferretry-claude', harness: 'claude-code' });
  });

  it('should name a clashing login by its id and a suffix of that id alone, the same on every read in any order', async () => {
    // Arrange — the owner already has a runtime called "work" on another login
    const runtimes = { work: runtimeFile({ login: 'other' }) };
    const logins = [loginView({ id: 'other' }), loginView({ id: 'work' })];
    const clashing = `work-${stableSuffix('work')}`;

    // Act
    const first = await api({ runtimes, logins }).list();
    const second = await api({ runtimes, logins: [...logins].reverse() }).list();

    // Assert
    should(first.map(summary => summary.id)).deepEqual(second.map(summary => summary.id));
    should(first.map(summary => summary.id).toSorted()).deepEqual(['work', clashing].toSorted());
    should(first.find(summary => summary.id === clashing)?.login).equal('work');
  });

  it('should never re-point a name when another login is deleted: the survivors keep their names, the deleted one is not found', async () => {
    // Arrange — logins work and work-2, and an owner runtime "work" that clashes with the first
    const runtimes = { work: runtimeFile({ login: 'other' }) };
    const other = loginView({ id: 'other' });
    const [work, work2] = [loginView({ id: 'work' }), loginView({ id: 'work-2' })];
    const clashing = `work-${stableSuffix('work')}`;
    const before = api({ runtimes, logins: [other, work, work2] });
    const after = api({ runtimes, logins: [other, work2] });

    // Act
    const resolvedBefore = await before.resolve(clashing as never);
    const resolvedAfter = await after.resolve(clashing as never);
    const survivor = await after.resolve('work-2' as never);

    // Assert — the saved name found login work, then finds nothing (never login work-2)
    should(resolvedBefore.ok).be.true();
    if (resolvedBefore.ok) should(resolvedBefore.runtime.login).equal('work');
    should(resolvedAfter).containDeep({ ok: false, refusal: 'unknown' });
    should(survivor.ok).be.true();
    if (survivor.ok) should(survivor.runtime.login).equal('work-2');
  });

  it('should run a login that drives both CLIs on the first one installed here', async () => {
    // Arrange
    const both = loginView({ id: 'gateway', store: 'environment', harnesses: ['claude-code', 'codex'] });

    // Act
    const codexOnly = await api({
      runtimes: {},
      logins: [both],
      templated: ['gateway'],
      installed: () => ['codex'],
    }).list();
    const none = await api({ runtimes: {}, logins: [both], templated: ['gateway'], installed: () => [] }).list();

    // Assert
    should(codexOnly[0]).containDeep({ id: 'gateway', harness: 'codex', profile: 'ferretry-codex' });
    // Nothing installed: no runtime for it at all (the login stays, and needs the CLI)
    should(none).deepEqual([]);
  });
});

describe('createRuntimesApi — an environment login Logins withheld', () => {
  it('should not list a runtime for it: it would stand in for variables nobody read', async () => {
    // Arrange — a key login whose file is not a clean, checked version (no templates for it)
    const key = loginView({ id: 'kimi', store: 'environment' });

    // Act
    const actual = await api({ runtimes: {}, logins: [key], templated: [] }).list();

    // Assert
    should(actual).deepEqual([]);
  });

  it('should list no runtime for it, and not fail, when Logins cannot read the templates at all', async () => {
    // Arrange — the same key login, but the template read itself throws
    const key = loginView({ id: 'kimi', store: 'environment' });

    // Act
    const actual = await api({ runtimes: {}, logins: [key], templatesThrow: true }).list();

    // Assert
    should(actual).deepEqual([]);
  });
});

describe('createRuntimesApi — a login whose CLI is not installed', () => {
  it('should list NO runtime for a Claude-only key login when only Codex is installed', async () => {
    // Arrange
    const key = loginView({ id: 'kimi', store: 'environment' });

    // Act
    const actual = await api({ runtimes: {}, logins: [key], templated: ['kimi'], installed: () => ['codex'] }).list();
    const launchable = await api({
      runtimes: {},
      logins: [key],
      templated: ['kimi'],
      installed: () => ['claude'],
    }).list();

    // Assert
    should(actual).deepEqual([]);
    should(launchable.map(summary => summary.id)).deepEqual(['kimi']);
  });
});
