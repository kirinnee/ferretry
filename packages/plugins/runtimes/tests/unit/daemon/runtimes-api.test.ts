import { describe, it } from 'bun:test';
import should from 'should';
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import type { LoginView } from '@ferretry/plugin-logins/contract';
import type { ApplyOutcome, CatalogInstallChange, ProfileFile, RuntimeFile } from '../../../contract/index.ts';
import { createRuntimesApi, type RuntimesApiDeps } from '../../../daemon/lib/service/runtimes-api.ts';

const NOW = Date.parse('2026-11-08T12:00:00Z');

const runtimeFile = (over: Partial<RuntimeFile> = {}): RuntimeFile => ({
  login: 'main',
  profile: 'default',
  agent: true,
  ...over,
});

/** The parts of a login view the runtimes read; the rest of the wire shape is not this module's. */
const loginView = (over: { id?: string; harness?: HarnessKey; word?: string; disabled?: LoginView['disabled'] }) =>
  ({
    id: over.id ?? 'main',
    harness: over.harness ?? 'claude-code',
    status: { word: over.word ?? 'ready' },
    ...(over.disabled === undefined ? {} : { disabled: over.disabled }),
  }) as unknown as LoginView;

interface Rig {
  runtimes?: Record<string, RuntimeFile>;
  profiles?: readonly string[];
  defaultSetting?: string;
  harnesses?: readonly HarnessKey[];
  logins?: readonly LoginView[] | 'throws';
  install?: RuntimesApiDeps['install'];
}

const api = (rig: Rig = {}) =>
  createRuntimesApi({
    runtimes: () => new Map(Object.entries(rig.runtimes ?? { 'claude-default': runtimeFile() })),
    profiles: () => new Map((rig.profiles ?? ['default']).map(name => [name, {} as ProfileFile])),
    defaultSetting: () => rig.defaultSetting,
    harnesses: () => rig.harnesses ?? ['claude-code', 'codex'],
    logins: {
      list: async () => {
        if (rig.logins === 'throws') throw new Error('logins are down');
        return { logins: rig.logins ?? [loginView({})] } as unknown as Awaited<
          ReturnType<RuntimesApiDeps['logins']['list']>
        >;
      },
    },
    now: () => NOW,
    install: rig.install ?? (async () => ({ outcome: 'applied' }) as unknown as ApplyOutcome),
  });

describe('createRuntimesApi — list and get', () => {
  it('should list runtimes by name with the harness their login drives and that they can launch', async () => {
    // Arrange
    const runtimes = api({
      runtimes: { zed: runtimeFile(), 'claude-default': runtimeFile({ agent: false }) },
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
    should((await runtimes.get('zed' as never))?.agent).be.true();
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
    should(await api({ defaultSetting: 'zed' }).default()).equal('zed');
  });

  it('should fall back to claude-default only when it is an agent runtime', async () => {
    should(await api().default()).equal('claude-default');
    should(await api({ runtimes: { 'claude-default': runtimeFile({ agent: false }) } }).default()).be.undefined();
    should(await api({ runtimes: {} }).default()).be.undefined();
  });
});

describe('createRuntimesApi — resolve', () => {
  it('should refuse with unknown when nothing is named and the machine has no default', async () => {
    // Act
    const actual = await api({ runtimes: {} }).resolve(undefined);

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

describe('createRuntimesApi — installCatalogItem', () => {
  it('should hand the change to the installer and return what it answered', async () => {
    // Arrange
    const seen: CatalogInstallChange[] = [];
    const outcome = { outcome: 'applied' } as unknown as ApplyOutcome;
    const runtimes = api({
      install: async change => {
        seen.push(change);
        return outcome;
      },
    });
    const change = { profile: 'default' } as unknown as CatalogInstallChange;

    // Act
    const actual = await runtimes.installCatalogItem(change);

    // Assert
    should(actual).equal(outcome);
    should(seen).deepEqual([change]);
  });
});
