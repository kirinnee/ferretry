import { describe, it } from 'bun:test';
import should from 'should';
import {
  classifyInstall,
  commandLine,
  compareVersions,
  type InstallFacts,
  installLabel,
  knownLatestRelease,
  parseNpmLatest,
  parseVersionOutput,
  updatePlan,
  updateRecipe,
  VERIFIED_CLAUDE_CODE_VERSION,
  verification,
} from '../../../daemon/lib/update/recipes.ts';

const HOME = '/home/kirin';
const facts = (launchedPath: string, resolvedPath = launchedPath, more: Partial<InstallFacts> = {}): InstallFacts => ({
  launchedPath,
  resolvedPath,
  homeDirectory: HOME,
  platform: 'linux',
  ...more,
});

describe('classifyInstall', () => {
  it('reads an nvm npm global with its prefix and node manager', () => {
    const prefix = `${HOME}/.nvm/versions/node/v22`;
    should(
      classifyInstall(facts(`${prefix}/bin/claude`, `${prefix}/lib/node_modules/@anthropic-ai/claude-code/cli.js`)),
    ).eql({ kind: 'npm-global', tool: 'npm', package: '@anthropic-ai/claude-code', prefix, nodeManager: 'nvm' });
  });

  it('reads bun, pnpm and volta globals', () => {
    should(
      classifyInstall(facts('/b/claude', `${HOME}/.bun/install/global/node_modules/@anthropic-ai/claude-code/cli.js`)),
    ).containEql({ kind: 'npm-global', tool: 'bun' });
    should(
      classifyInstall(
        facts('/p/claude', `${HOME}/.local/share/pnpm/global/5/node_modules/@anthropic-ai/claude-code/cli.js`),
      ),
    ).containEql({ tool: 'pnpm' });
    should(classifyInstall(facts(`${HOME}/.volta/bin/claude`, `${HOME}/.volta/bin/volta-shim`))).containEql({
      tool: 'volta',
    });
  });

  it('reads a Caskroom as a Homebrew cask and a Cellar as a formula', () => {
    should(classifyInstall(facts('/opt/homebrew/bin/claude', '/opt/homebrew/Caskroom/claude-code/2.1.200/claude'))).eql(
      {
        kind: 'homebrew',
        type: 'cask',
        package: 'claude-code',
      },
    );
    should(classifyInstall(facts('/opt/homebrew/bin/claude', '/opt/homebrew/Cellar/claude/2.1.200/bin/claude'))).eql({
      kind: 'homebrew',
      type: 'formula',
      package: 'claude',
    });
  });

  it('reads Claude Code’s own installer', () => {
    should(classifyInstall(facts(`${HOME}/.local/bin/claude`, `${HOME}/.local/share/claude/versions/2.1.200`))).eql({
      kind: 'native-installer',
      directory: `${HOME}/.local/share/claude`,
    });
  });

  it('asks the nix store rule BEFORE the npm layout, because nixpkgs ships an npm layout', () => {
    const store = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-claude-code';
    const method = classifyInstall(
      facts('/etc/profiles/per-user/kirin/bin/claude', `${store}/lib/node_modules/@anthropic-ai/claude-code/cli.js`, {
        viaHomeManagerPath: true,
      }),
    );
    should(method).eql({ kind: 'nix-module', manager: 'home-manager', via: 'nixos' });
    should(classifyInstall(facts(`${store}/bin/claude`, `${store}/bin/claude`))).containEql({ kind: 'nix-shell' });
    should(
      classifyInstall(
        facts(`${HOME}/.nix-profile/bin/claude`, `${store}/bin/claude`, { nixProfileElement: 'claude-code' }),
      ),
    ).eql({ kind: 'nix-profile', element: 'claude-code' });
  });

  it('calls an unrecognised file standalone', () => {
    should(classifyInstall(facts('/opt/x/claude'))).eql({ kind: 'standalone', directory: '/opt/x' });
  });

  describe('a file in the Nix store, by how it was reached', () => {
    const store = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-claude-code';
    const resolved = `${store}/bin/claude`;

    it('reads a system profile as a module of the system’s own manager, on either platform', () => {
      should(classifyInstall(facts('/run/current-system/sw/bin/claude', resolved))).eql({
        kind: 'nix-module',
        manager: 'nixos',
      });
      should(classifyInstall(facts('/etc/profiles/per-user/kirin/bin/claude', resolved, { platform: 'darwin' }))).eql({
        kind: 'nix-module',
        manager: 'nix-darwin',
      });
    });

    it('reads a user profile with no element as home-manager’s generation, when it is one', () => {
      should(classifyInstall(facts(`${HOME}/.nix-profile/bin/claude`, resolved, { homeManagerProfile: true }))).eql({
        kind: 'nix-module',
        manager: 'home-manager',
      });
      should(classifyInstall(facts(`${HOME}/.nix-profile/bin/claude`, resolved, { viaHomeManagerPath: true }))).eql({
        kind: 'nix-module',
        manager: 'home-manager',
      });
    });

    it('does not guess when a user profile has no element and is not home-manager’s', () => {
      const method = classifyInstall(facts(`${HOME}/.nix-profile/bin/claude`, resolved));
      should(method).eql({
        kind: 'unknown',
        reason: 'this nix profile has no element for it; it may have come from nix-env',
      });
    });

    it('does not guess when it was reached by a path it does not recognise', () => {
      const method = classifyInstall(facts('/srv/odd/bin/claude', resolved));
      should(method).eql({
        kind: 'unknown',
        reason: '/srv/odd/bin/claude leads into the Nix store by a path Ferretry does not recognise',
      });
    });
  });
});

describe('updateRecipe', () => {
  const npm = { kind: 'npm-global', tool: 'npm', package: '@anthropic-ai/claude-code', prefix: '/p' } as const;

  it('installs the named version with the same prefix, and rolls back to the previous one', () => {
    const recipe = updateRecipe(npm, '2.1.230');
    should(recipe.kind).equal('self');
    if (recipe.kind !== 'self') return;
    should(recipe.run.map(commandLine)).eql(['npm install -g --prefix /p @anthropic-ai/claude-code@2.1.230']);
    should(recipe.pinsVersion).be.true();
    should(recipe.rollback?.('2.1.200').map(commandLine)).eql([
      'npm install -g --prefix /p @anthropic-ai/claude-code@2.1.200',
    ]);
  });

  it('takes the newest from Homebrew and keeps no previous version', () => {
    const recipe = updateRecipe({ kind: 'homebrew', type: 'cask', package: 'claude-code' }, undefined);
    if (recipe.kind !== 'self') throw new Error('expected self');
    should(recipe.run.map(commandLine)).eql(['brew update', 'brew upgrade --cask claude-code']);
    should(recipe.pinsVersion).be.false();
    should(recipe.rollback).be.undefined();
  });

  it('runs claude itself for the native installer', () => {
    const recipe = updateRecipe({ kind: 'native-installer', directory: '/d' }, undefined);
    if (recipe.kind !== 'self') throw new Error('expected self');
    should(recipe.run.map(commandLine)).eql(['claude update']);
  });

  it('leaves modules, temporary shells, standalone files and unknowns to a person, with the steps', () => {
    for (const method of [
      { kind: 'nix-module', manager: 'home-manager' },
      { kind: 'nix-shell', storePath: '/nix/store/x' },
      { kind: 'standalone', directory: '/d' },
      { kind: 'unknown', reason: 'odd' },
    ] as const)
      should(updateRecipe(method, undefined).kind).equal('manual');
    const plan = updatePlan({ kind: 'nix-module', manager: 'home-manager', via: 'nix-darwin' }, undefined);
    if (plan.kind !== 'manual') throw new Error('expected manual');
    should(plan.steps.map(step => step.command)).eql(['nix flake update nixpkgs', 'darwin-rebuild switch --flake .']);
  });

  it('installs with each node package tool in its own way, and a volta install needs no prefix', () => {
    const install = (tool: 'npm' | 'pnpm' | 'bun' | 'volta', prefix?: string) => {
      const recipe = updateRecipe(
        { kind: 'npm-global', tool, package: '@anthropic-ai/claude-code', ...(prefix === undefined ? {} : { prefix }) },
        '2.1.230',
      );
      if (recipe.kind !== 'self') throw new Error('expected self');
      return recipe.run.map(commandLine);
    };
    should(install('npm')).eql(['npm install -g @anthropic-ai/claude-code@2.1.230']);
    should(install('pnpm')).eql(['pnpm add -g @anthropic-ai/claude-code@2.1.230']);
    should(install('bun')).eql(['bun add -g @anthropic-ai/claude-code@2.1.230']);
    should(install('volta')).eql(['volta install @anthropic-ai/claude-code@2.1.230']);
  });

  it('upgrades a nix profile element, refreshing it, and rolls the profile back', () => {
    const recipe = updateRecipe({ kind: 'nix-profile', element: 'claude-code' }, undefined);
    if (recipe.kind !== 'self') throw new Error('expected self');
    should(recipe.run.map(commandLine)).eql(['nix profile upgrade --refresh claude-code']);
    should(recipe.pinsVersion).be.false();
    should(recipe.rollback?.('2.1.200').map(commandLine)).eql(['nix profile rollback']);
  });

  it('installs the named version with the native installer, and rolls back to the previous one', () => {
    const recipe = updateRecipe({ kind: 'native-installer', directory: '/d' }, '2.1.230');
    if (recipe.kind !== 'self') throw new Error('expected self');
    should(recipe.run.map(commandLine)).eql(['claude install 2.1.230']);
    should(recipe.pinsVersion).be.true();
    should(recipe.rollback?.('2.1.200').map(commandLine)).eql(['claude install 2.1.200']);
  });

  it('names the one switch command for each flavour of module, and says where the flake is', () => {
    const steps = (method: Parameters<typeof updatePlan>[0]) => {
      const plan = updatePlan(method, undefined);
      if (plan.kind !== 'manual') throw new Error('expected manual');
      return { explanation: plan.explanation, commands: plan.steps.map(step => step.command) };
    };
    const homeManager = steps({ kind: 'nix-module', manager: 'home-manager' });
    should(homeManager.commands).eql(['nix flake update nixpkgs', 'home-manager switch --flake .']);
    should(homeManager.explanation).containEql('comes from your home-manager configuration');
    const nixos = steps({ kind: 'nix-module', manager: 'nixos' });
    should(nixos.commands).eql(['nix flake update nixpkgs', 'sudo nixos-rebuild switch --flake .']);
    should(nixos.explanation).containEql('comes from your nixos configuration');
    const inside = steps({ kind: 'nix-module', manager: 'home-manager', via: 'nixos' });
    should(inside.commands.at(-1)).equal('sudo nixos-rebuild switch --flake .');
    should(inside.explanation).containEql('which nixos applies');
  });

  it('gives every install method a short plain name', () => {
    should(
      (
        [
          { kind: 'npm-global', tool: 'npm', package: 'p' },
          { kind: 'npm-global', tool: 'volta', package: 'p' },
          { kind: 'homebrew', type: 'cask', package: 'p' },
          { kind: 'native-installer', directory: '/d' },
          { kind: 'nix-profile', element: 'e' },
          { kind: 'nix-shell', storePath: '/nix/store/x' },
          { kind: 'nix-module', manager: 'nixos' },
          { kind: 'standalone', directory: '/d' },
          { kind: 'unknown', reason: 'r' },
        ] as const
      ).map(installLabel),
    ).eql([
      'npm global',
      'Volta',
      'Homebrew',
      'Claude Code installer',
      'nix profile',
      'nix shell (temporary)',
      'Nix module',
      'standalone binary',
      'unrecognised',
    ]);
  });

  it('describes a self plan with its rollback and pinning', () => {
    should(updatePlan(npm, undefined)).containEql({ kind: 'self', rollback: 'automatic', pinsVersion: true });
  });
});

describe('versions', () => {
  it('orders versions by semver, prereleases below their release', () => {
    should(compareVersions('2.1.230', '2.1.220')).equal(1);
    should(compareVersions('2.1.220', '2.1.220')).equal(0);
    should(compareVersions('2.1.220-rc.1', '2.1.220')).equal(-1);
    should(compareVersions('nope', '2.1.220')).be.undefined();
  });

  it('orders two prereleases of one release by their dot-separated parts, as semver does', () => {
    const order = (lower: string, higher: string) => [compareVersions(lower, higher), compareVersions(higher, lower)];
    // numbers by value, not by text; a number below a word; words by text; the shorter list below the longer
    should(order('2.1.220-rc.2', '2.1.220-rc.10')).eql([-1, 1]);
    should(order('2.1.220-1', '2.1.220-alpha')).eql([-1, 1]);
    should(order('2.1.220-alpha', '2.1.220-beta')).eql([-1, 1]);
    should(order('2.1.220-rc', '2.1.220-rc.1')).eql([-1, 1]);
    should(compareVersions('2.1.220-rc.1', '2.1.220-rc.1')).equal(0);
    should(compareVersions('2.1.220-rc.1+build5', '2.1.220-rc.1')).equal(0);
  });

  it('reads a version out of what --version printed', () => {
    should(parseVersionOutput('2.1.220 (Claude Code)')).equal('2.1.220');
    should(parseVersionOutput('no version here')).be.undefined();
  });

  it('judges a version against the verified one', () => {
    should(verification(VERIFIED_CLAUDE_CODE_VERSION)).equal('verified');
    should(verification('2.0.1')).equal('older');
    should(verification('99.0.0')).equal('unverified');
    should(verification(undefined)).equal('unknown');
  });

  it('takes only a stable npm latest', () => {
    should(parseNpmLatest({ version: '2.1.230' })?.version).equal('2.1.230');
    should(parseNpmLatest({ version: '2.1.230-beta.1' })).be.undefined();
    should(parseNpmLatest('x')).be.undefined();
  });

  it('remembers the last good release across a failed check', () => {
    const latest = { version: '2.1.230', url: 'https://example.com/c' };
    should(knownLatestRelease({ state: 'never' })).be.undefined();
    should(
      knownLatestRelease({
        state: 'failed',
        checkedAt: '2026-10-20T09:00:00.000Z' as never,
        reason: 'x',
        lastKnown: { checkedAt: '2026-10-19T09:00:00.000Z' as never, latest },
      }),
    ).eql(latest);
  });
});
