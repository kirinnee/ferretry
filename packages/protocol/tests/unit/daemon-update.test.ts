import { describe, it } from 'bun:test';
import should from 'should';
import * as update from '../../src/lib/daemon-update.ts';
import {
  classifyInstallMethod,
  describeInstallMethod,
  INSTALL_METHOD_LABELS,
  type InstallFacts,
  type InstallMethod,
  isUpdateAvailable,
  knownLatestRelease,
  latestReleaseApiUrl,
  parseGitHubLatestRelease,
  parseGitHubNewestTag,
  planUpdate,
  releaseDownloadBase,
  releaseFlakeReference,
  releaseTagsApiUrl,
  releaseTapName,
  releaseTapUrl,
} from '../../src/lib/daemon-update.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const STORE = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-ferretry-4.28.0';
const HOME = '/home/kirin';

const facts = (overrides: Partial<InstallFacts>): InstallFacts => ({
  product: 'ferretry',
  compiled: true,
  launchedPath: '/home/kirin/.local/bin/fyd',
  resolvedPath: '/home/kirin/.local/bin/fyd',
  homeDirectory: HOME,
  platform: 'linux',
  ...overrides,
});

const latest = { version: '4.29.0', url: 'https://github.com/kirinnee/ferretry/releases/tag/v4.29.0' };
const report = {
  from: '4.28.0',
  target: '4.29.0',
  outcome: 'succeeded',
  message: 'Updated to 4.29.0.',
  finishedAt: '2026-10-18T10:00:00.000Z',
} as const;
const view = {
  current: '4.28.0',
  method: { kind: 'nix-profile', element: 'ferretry' },
  plan: planUpdate({ kind: 'nix-profile', element: 'ferretry' }, { product: 'ferretry', clientName: 'fy' }),
  check: { state: 'ok', checkedAt: '2026-10-18T09:00:00.000Z', latest },
  available: true,
  midTurn: 0,
  autoInstall: false,
  job: null,
} as const;

const cases: SchemaCase[] = [
  { name: 'system package manager', schema: update.SystemPackageManagerSchema, value: 'dnf' },
  { name: 'nix module manager', schema: update.NixModuleManagerSchema, value: 'nix-darwin' },
  { name: 'nix system manager', schema: update.NixSystemManagerSchema, value: 'nixos' },
  { name: 'install method', schema: update.InstallMethodSchema, value: { kind: 'homebrew', cask: 'ferretry' } },
  { name: 'step', schema: update.UpdateStepSchema, value: { command: 'fy daemon restart', note: 'now' } },
  { name: 'plan', schema: update.UpdatePlanSchema, value: view.plan },
  { name: 'latest release', schema: update.LatestReleaseSchema, value: latest },
  { name: 'check', schema: update.UpdateCheckSchema, value: view.check },
  { name: 'outcome', schema: update.UpdateOutcomeSchema, value: 'rolled-back' },
  { name: 'report', schema: update.UpdateReportSchema, value: report },
  { name: 'job', schema: update.UpdateJobSchema, value: { state: 'finished', report } },
  { name: 'view', schema: update.DaemonUpdateViewSchema, value: view },
  {
    name: 'start request',
    schema: update.DaemonUpdateStartRequestSchema,
    value: { target: '4.29.0', when: 'now', confirmMidTurn: true },
  },
  { name: 'settings patch', schema: update.DaemonUpdateSettingsPatchSchema, value: { autoInstall: true } },
  {
    name: 'mid-turn body',
    schema: update.DaemonUpdateMidTurnBodySchema,
    value: { error: 'two ferrets are mid-turn', code: 'update_mid_turn', midTurn: 2 },
  },
];

describe('daemon update schemas', () => {
  it('covers every exported schema', () => assertCoversEverySchema(update, cases));
  it('round-trips every case', () => assertRoundTrips(cases));
  it('refuses what the contract does not allow', () =>
    assertRejects([
      { name: 'extra key', schema: update.DaemonUpdateSettingsPatchSchema, value: { autoInstall: true, x: 1 } },
      { name: 'bad target', schema: update.DaemonUpdateStartRequestSchema, value: { target: 'latest', when: 'now' } },
      {
        name: 'empty self plan',
        schema: update.UpdatePlanSchema,
        value: { kind: 'self', steps: [], rollback: 'none' },
      },
    ]));
});

describe('classifyInstallMethod', () => {
  const classify = (overrides: Partial<InstallFacts>): InstallMethod => classifyInstallMethod(facts(overrides));

  it('calls a source run a development build', () => {
    should(classify({ compiled: false }).kind).equal('unknown');
  });

  it('recognises a Homebrew cask by its Caskroom', () => {
    should(
      classify({
        platform: 'darwin',
        launchedPath: '/opt/homebrew/bin/fyd',
        resolvedPath: '/opt/homebrew/Caskroom/ferretry/4.28.0/fyd',
      }),
    ).deepEqual({ kind: 'homebrew', cask: 'ferretry' });
  });

  it('recognises a file a system package manager owns', () => {
    should(classify({ launchedPath: '/usr/bin/fyd', resolvedPath: '/usr/bin/fyd', systemPackage: 'apt' })).deepEqual({
      kind: 'system-package',
      manager: 'apt',
    });
  });

  it('calls a launched store path an ephemeral nix shell', () => {
    should(classify({ launchedPath: `${STORE}/bin/fyd`, resolvedPath: `${STORE}/bin/fyd` })).deepEqual({
      kind: 'nix-shell',
      storePath: STORE,
    });
  });

  it('calls a system profile a module of the platform’s system manager', () => {
    should(
      classify({
        launchedPath: '/run/current-system/sw/bin/fyd',
        resolvedPath: `${STORE}/bin/fyd`,
        platform: 'darwin',
      }),
    ).deepEqual({ kind: 'nix-module', manager: 'nix-darwin' });
    should(
      classify({ launchedPath: '/etc/profiles/per-user/kirin/bin/fyd', resolvedPath: `${STORE}/bin/fyd` }),
    ).deepEqual({ kind: 'nix-module', manager: 'nixos' });
  });

  it('calls a per-user system profile home-manager when home-manager built it', () => {
    const perUser = { launchedPath: '/etc/profiles/per-user/kirin/bin/fyd', resolvedPath: `${STORE}/bin/fyd` };
    should(classify({ ...perUser, platform: 'darwin', viaHomeManagerPath: true })).deepEqual({
      kind: 'nix-module',
      manager: 'home-manager',
      via: 'nix-darwin',
    });
    should(classify({ ...perUser, viaHomeManagerPath: true })).deepEqual({
      kind: 'nix-module',
      manager: 'home-manager',
      via: 'nixos',
    });
    should(classify({ ...perUser, platform: 'darwin', viaHomeManagerPath: false })).deepEqual({
      kind: 'nix-module',
      manager: 'nix-darwin',
    });
    // The user's own nix profile having a home-manager element says nothing about a system profile.
    should(classify({ ...perUser, homeManagerProfile: true })).deepEqual({ kind: 'nix-module', manager: 'nixos' });
  });

  it('decides a user profile path by what holds it', () => {
    const viaProfile = { launchedPath: `${HOME}/.nix-profile/bin/fyd`, resolvedPath: `${STORE}/bin/fyd` };
    should(classify({ ...viaProfile, nixProfileElement: 'ferretry' })).deepEqual({
      kind: 'nix-profile',
      element: 'ferretry',
    });
    should(classify({ ...viaProfile, homeManagerProfile: true })).deepEqual({
      kind: 'nix-module',
      manager: 'home-manager',
    });
    should(classify({ ...viaProfile, viaHomeManagerPath: true })).deepEqual({
      kind: 'nix-module',
      manager: 'home-manager',
    });
    should(classify(viaProfile).kind).equal('unknown');
    should(
      classify({
        ...viaProfile,
        homeDirectory: `${HOME}/`,
        launchedPath: `${HOME}/.local/state/nix/profiles/profile/bin/fyd`,
      }),
    ).deepEqual({ kind: 'unknown', reason: 'this nix profile has no element for it; it may have come from nix-env' });
  });

  it('refuses to guess at a store path reached some other way', () => {
    should(classify({ launchedPath: '/usr/local/bin/fyd', resolvedPath: `${STORE}/bin/fyd` }).kind).equal('unknown');
  });

  it('calls anything else a standalone binary in its directory', () => {
    should(classify({})).deepEqual({ kind: 'standalone', directory: '/home/kirin/.local/bin' });
    should(classify({ launchedPath: '/fyd', resolvedPath: '/fyd' })).deepEqual({ kind: 'standalone', directory: '/' });
  });
});

describe('planUpdate', () => {
  const context = { product: 'ferretry', clientName: 'fy' };
  const plan = (method: InstallMethod) => planUpdate(method, context);

  it('self-updates only what needs no sudo and changes no configuration', () => {
    const kinds = (
      [
        { kind: 'homebrew', cask: 'ferretry' },
        { kind: 'nix-profile', element: 'ferretry' },
        { kind: 'nix-shell', storePath: STORE },
        { kind: 'nix-module', manager: 'home-manager' },
        { kind: 'nix-module', manager: 'nix-darwin' },
        { kind: 'nix-module', manager: 'nixos' },
        { kind: 'nix-module', manager: 'home-manager', via: 'nix-darwin' },
        { kind: 'system-package', manager: 'apt' },
        { kind: 'system-package', manager: 'dnf' },
        { kind: 'standalone', directory: '/opt/fy' },
        { kind: 'unknown', reason: 'x' },
      ] satisfies InstallMethod[]
    ).map(method => [method.kind, plan(method).kind]);
    should(kinds).deepEqual([
      ['homebrew', 'self'],
      ['nix-profile', 'self'],
      ['nix-shell', 'switch'],
      ['nix-module', 'manual'],
      ['nix-module', 'manual'],
      ['nix-module', 'manual'],
      ['nix-module', 'manual'],
      ['system-package', 'manual'],
      ['system-package', 'manual'],
      ['standalone', 'self'],
      ['unknown', 'manual'],
    ]);
  });

  it('names the exact commands', () => {
    const commands = (method: InstallMethod) => plan(method).steps.map(step => step.command);
    should(commands({ kind: 'homebrew', cask: 'ferretry' })).deepEqual([
      'brew upgrade --cask ferretry',
      'fy daemon restart',
    ]);
    should(plan({ kind: 'homebrew', cask: 'ferretry' })).have.property('rollback', 'none');
    should(commands({ kind: 'nix-profile', element: 'ferretry' })[0]).equal('nix profile upgrade ferretry');
    should(commands({ kind: 'nix-shell', storePath: STORE })).deepEqual([
      'nix profile install github:kirinnee/ferretry',
      'fy daemon install',
    ]);
    should(commands({ kind: 'nix-module', manager: 'home-manager' })[1]).equal('home-manager switch --flake .');
    should(commands({ kind: 'nix-module', manager: 'nix-darwin' })[1]).equal('darwin-rebuild switch --flake .');
    should(commands({ kind: 'nix-module', manager: 'nixos' })[1]).equal('sudo nixos-rebuild switch --flake .');
    should(commands({ kind: 'nix-module', manager: 'home-manager', via: 'nix-darwin' })).deepEqual([
      'nix flake update ferretry',
      'darwin-rebuild switch --flake .',
      'fy daemon restart',
    ]);
    should(commands({ kind: 'nix-module', manager: 'home-manager', via: 'nixos' })[1]).equal(
      'sudo nixos-rebuild switch --flake .',
    );
    should(commands({ kind: 'system-package', manager: 'apt' })[0]).equal(
      'sudo apt-get update && sudo apt-get install --only-upgrade fy',
    );
    should(commands({ kind: 'system-package', manager: 'yum' })[0]).equal('sudo yum upgrade fy');
    should(commands({ kind: 'standalone', directory: '/opt/fy' })).deepEqual(['fy daemon update']);
    should(commands({ kind: 'unknown', reason: 'x' })).deepEqual([]);
  });
  it('says which system manager applies a home-manager install, in the step text', () => {
    const inside = plan({ kind: 'nix-module', manager: 'home-manager', via: 'nix-darwin' });
    should(inside)
      .have.property('explanation')
      .match(/home-manager configuration, which nix-darwin applies/u);
    should(inside.steps.map(step => step.note)).deepEqual([
      'in the flake that holds your home-manager configuration; the input may have another name',
      'home-manager is applied by this nix-darwin rebuild; there is no separate home-manager switch',
      undefined,
    ]);
    const standalone = plan({ kind: 'nix-module', manager: 'home-manager' });
    should(standalone)
      .have.property('explanation')
      .match(/from your home-manager configuration, which pins/u);
    should(plan({ kind: 'nix-module', manager: 'nixos' }))
      .have.property('explanation')
      .match(/your nixos configuration/u);
  });
});

describe('descriptions', () => {
  it('labels and describes every method', () => {
    const methods: InstallMethod[] = [
      { kind: 'homebrew', cask: 'ferretry' },
      { kind: 'nix-profile', element: 'ferretry' },
      { kind: 'nix-shell', storePath: STORE },
      { kind: 'nix-module', manager: 'nixos' },
      { kind: 'nix-module', manager: 'home-manager', via: 'nix-darwin' },
      { kind: 'system-package', manager: 'apt' },
      { kind: 'standalone', directory: '/opt/fy' },
      { kind: 'unknown', reason: 'a dev build' },
    ];
    should(methods.map(describeInstallMethod)).deepEqual([
      'Homebrew cask ferretry',
      'nix profile element ferretry',
      `nix shell store path ${STORE}`,
      'nixos module',
      'home-manager (via nix-darwin) module',
      'apt package',
      'standalone binary in /opt/fy',
      'unrecognised install (a dev build)',
    ]);
    should(Object.keys(INSTALL_METHOD_LABELS).sort()).deepEqual(
      [...new Set(methods.map(method => method.kind))].sort(),
    );
  });

  it('builds the release addresses from the product', () => {
    should(releaseFlakeReference('ferretry')).equal('github:kirinnee/ferretry');
    should(releaseTapName('ferretry')).equal('kirinnee/ferretry');
    should(releaseTapUrl('ferretry')).equal('https://github.com/kirinnee/ferretry');
    should(latestReleaseApiUrl('ferretry')).equal('https://api.github.com/repos/kirinnee/ferretry/releases/latest');
    should(releaseDownloadBase('ferretry', '4.29.0')).equal(
      'https://github.com/kirinnee/ferretry/releases/download/v4.29.0',
    );
  });
});

describe('latest release', () => {
  const answer = {
    tag_name: 'v4.29.0',
    html_url: 'https://github.com/kirinnee/ferretry/releases/tag/v4.29.0',
    draft: false,
    prerelease: false,
    published_at: '2026-10-18T08:00:00Z',
    assets: [],
  };

  it('reads a published release', () => {
    should(parseGitHubLatestRelease(answer)).deepEqual({
      version: '4.29.0',
      url: answer.html_url,
      publishedAt: '2026-10-18T08:00:00Z',
    });
    should(parseGitHubLatestRelease({ ...answer, published_at: null })).deepEqual({
      version: '4.29.0',
      url: answer.html_url,
    });
  });

  it('refuses anything that is not a published semver release over https', () => {
    should(parseGitHubLatestRelease('nope')).be.undefined();
    should(parseGitHubLatestRelease({ ...answer, draft: true })).be.undefined();
    should(parseGitHubLatestRelease({ ...answer, prerelease: true })).be.undefined();
    should(parseGitHubLatestRelease({ ...answer, tag_name: 'nightly' })).be.undefined();
    should(parseGitHubLatestRelease({ ...answer, html_url: 'http://example.com/x' })).be.undefined();
  });

  it('reads the highest stable tag, ignoring pre-releases and names that are not versions', () => {
    should(releaseTagsApiUrl('ferretry')).equal('https://api.github.com/repos/kirinnee/ferretry/tags?per_page=30');
    const names = (...list: string[]) => list.map(name => ({ name }));
    should(
      parseGitHubNewestTag('ferretry', names('v4.29.0', 'v4.30.1', 'v4.30.0', 'v5.0.0-rc.1', 'nightly', '4.31.0')),
    ).deepEqual({
      version: '4.30.1',
      url: 'https://github.com/kirinnee/ferretry/releases/tag/v4.30.1',
    });
    should(parseGitHubNewestTag('ferretry', names('nightly', 'v5.0.0-rc.1'))).be.undefined();
    should(parseGitHubNewestTag('ferretry', 'nope')).be.undefined();
  });

  it('compares versions, and never calls an unparseable one newer', () => {
    should(isUpdateAvailable('4.28.0', latest)).be.true();
    should(isUpdateAvailable('4.29.0', latest)).be.false();
    should(isUpdateAvailable('4.30.0', latest)).be.false();
    should(isUpdateAvailable('dev', latest)).be.false();
    should(isUpdateAvailable('4.28.0', undefined)).be.false();
  });

  it('keeps the last good answer through a failed check', () => {
    should(knownLatestRelease({ state: 'never' })).be.undefined();
    should(knownLatestRelease(view.check)).deepEqual(latest);
    const failedAt = '2026-10-18T10:00:00.000Z';
    should(knownLatestRelease({ state: 'failed', checkedAt: failedAt, reason: 'offline' })).be.undefined();
    should(
      knownLatestRelease({
        state: 'failed',
        checkedAt: failedAt,
        reason: 'offline',
        lastKnown: { checkedAt: view.check.checkedAt, latest },
      }),
    ).deepEqual(latest);
  });
});

describe('parseNixProfileList', () => {
  const daemon = `${STORE}/bin/fyd`;

  it('names the version-3 element holding the executable', () => {
    should(
      update.parseNixProfileList(
        { version: 3, elements: { ripgrep: { storePaths: ['/nix/store/x-rg'] }, ferretry: { storePaths: [STORE] } } },
        [daemon],
      ),
    ).deepEqual({ element: 'ferretry', homeManager: false });
  });

  it('names a version-2 element by its index', () => {
    should(update.parseNixProfileList({ version: 2, elements: [{}, { storePaths: [STORE] }] }, [daemon])).deepEqual({
      element: '1',
      homeManager: false,
    });
  });

  it('recognises a home-manager generation', () => {
    should(
      update.parseNixProfileList(
        { elements: { 'home-manager-path': { storePaths: ['/nix/store/y-home-manager-path'] } } },
        [daemon],
      ),
    ).deepEqual({ element: undefined, homeManager: true });
    should(
      update.parseNixProfileList({ elements: [{ storePaths: ['/nix/store/y-home-manager-path'] }] }, [daemon]),
    ).have.property('homeManager', true);
  });

  it('answers no element for anything else', () => {
    should(update.parseNixProfileList('garbage', [daemon])).deepEqual({ homeManager: false });
    should(update.parseNixProfileList({ elements: { other: { storePaths: [`${STORE}-other`] } } }, [daemon])).deepEqual(
      {
        element: undefined,
        homeManager: false,
      },
    );
  });
});

describe('parseNixProfileList and the link chain', () => {
  const OUTER = '/nix/store/c2shzv960i5hnnspql90apvg2f2d7bah-ferretry';
  const INNER = '/nix/store/xlkmzv960i5hnnspql90apvg2f2d7bah-fyd-4.31.0';
  const HM = '/nix/store/r8lckl3m305x39jxxx5bi5vxiaav6q30-home-manager-path';
  const profile = {
    version: 3,
    elements: {
      ferretry: { storePaths: [OUTER] },
      'home-manager-path': { storePaths: [HM] },
    },
  };

  it('names the element by the OUTER store path of a symlink-join package, with a home-manager element beside it', () => {
    should(update.parseNixProfileList(profile, [`${INNER}/bin/fyd`, `${OUTER}/bin/fyd`])).deepEqual({
      element: 'ferretry',
      homeManager: true,
    });
    should(update.parseNixProfileList(profile, [`${INNER}/bin/fyd`])).deepEqual({
      element: undefined,
      homeManager: true,
    });
  });

  it('never names the home-manager element as the element', () => {
    should(update.parseNixProfileList(profile, [`${HM}/bin`])).deepEqual({ element: undefined, homeManager: true });
    should(update.parseNixProfileList({ elements: [{ storePaths: [HM] }] }, [`${HM}/bin`])).deepEqual({
      element: undefined,
      homeManager: true,
    });
  });

  it('walks the whole chain: a profile link, a symlink join, an inner derivation', async () => {
    const links: Record<string, string> = {
      '/home/kirin/.nix-profile': '/home/kirin/.local/state/nix/profiles/profile',
      '/home/kirin/.local/state/nix/profiles/profile': 'profile-7-link',
      '/home/kirin/.local/state/nix/profiles/profile-7-link': '/nix/store/00p7zv960i5hnnspql90apvg2f2d7bah-profile',
      '/nix/store/00p7zv960i5hnnspql90apvg2f2d7bah-profile/bin/fyd': `${OUTER}/bin/fyd`,
      [`${OUTER}/bin/fyd`]: `${INNER}/bin/fyd`,
    };
    const hops = await update.symlinkHops('/home/kirin/.nix-profile/bin/fyd', async path => links[path]);
    should(hops).deepEqual([
      '/home/kirin/.local/state/nix/profiles/profile',
      '/home/kirin/.local/state/nix/profiles/profile-7-link',
      '/nix/store/00p7zv960i5hnnspql90apvg2f2d7bah-profile',
      `${OUTER}/bin/fyd`,
      `${INNER}/bin/fyd`,
    ]);
    should(update.storePathHops(hops)).deepEqual([
      '/nix/store/00p7zv960i5hnnspql90apvg2f2d7bah-profile',
      `${OUTER}/bin/fyd`,
      `${INNER}/bin/fyd`,
    ]);
    should(update.passesThroughHomeManagerPath(hops)).be.false();
  });

  it('follows relative targets and dot segments, and sees a directory link into home-manager-path', async () => {
    const links: Record<string, string> = {
      '/home/kirin/.nix-profile': '../../nix/./profile',
      '/nix/profile/bin': `${HM}/bin`,
    };
    const hops = await update.symlinkHops('/home/kirin/.nix-profile/bin/fyd', async path => links[path]);
    should(hops).deepEqual(['/home/kirin/../../nix/./profile', `${HM}/bin`]);
    should(update.passesThroughHomeManagerPath(hops)).be.true();
    should(update.passesThroughHomeManagerPath([`${HM}`])).be.true();
    should(update.passesThroughHomeManagerPath(['/nix/store/zz-not-home-manager-path-2/bin'])).be.false();
  });

  it('stops on a link loop and answers no hops for a plain file', async () => {
    const loop = await update.symlinkHops('/a', async () => '/a');
    should(loop).have.length(40);
    should(await update.symlinkHops('/x/y', async () => undefined)).deepEqual([]);
    should(await update.symlinkHops('/x/..', async () => undefined)).deepEqual([]);
  });
});
