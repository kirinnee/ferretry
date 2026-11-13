import { describe, it } from 'bun:test';
import should from 'should';
import {
  classifyCodexInstall,
  codexUpdatePlan,
  codexUpdateRecipe,
  codexVerification,
  compareVersions,
  harnessCommandLine,
  harnessInstallLabel,
  type InstallFacts,
  isVersion,
  needsUnverifiedConsent,
  nixPathHops,
  parseCodexVersion,
  parseNixProfileList,
  parseNpmLatest,
  passesThroughHomeManagerPath,
  symlinkHops,
  VERIFIED_CODEX_VERSION,
  verificationUrl,
} from '../../daemon/lib/index.ts';

const facts = (resolvedPath: string, extra: Partial<InstallFacts> = {}): InstallFacts => ({
  launchedPath: resolvedPath,
  resolvedPath,
  homeDirectory: '/home/kirin',
  platform: 'linux',
  ...extra,
});

describe('reading a Codex version', () => {
  it('reads the version `codex --version` prints, with or without a prerelease', () => {
    should(parseCodexVersion('codex-cli 0.145.0')).equal('0.145.0');
    should(parseCodexVersion('codex-cli 0.150.0-alpha.3\n')).equal('0.150.0-alpha.3');
    should(parseCodexVersion('no version here')).be.undefined();
  });

  it('orders versions as semver does, and refuses to order what is not a version', () => {
    should(compareVersions('0.140.0', '0.145.0')).equal(-1);
    should(compareVersions('0.145.0', '0.145.0')).equal(0);
    should(compareVersions('0.145.1', '0.145.0')).equal(1);
    should(compareVersions('0.145.0-alpha.1', '0.145.0')).equal(-1);
    should(compareVersions('latest', '0.145.0')).be.undefined();
    should(isVersion('0.145.0')).be.true();
    should(isVersion('^0.145')).be.false();
  });

  it('takes only a stable version from the registry answer', () => {
    should(parseNpmLatest({ version: '0.145.0' })).eql({
      version: '0.145.0',
      url: 'https://github.com/openai/codex/releases/tag/rust-v0.145.0',
    });
    should(parseNpmLatest({ version: '0.146.0-alpha.1' })).be.undefined();
    should(parseNpmLatest({ version: 5 })).be.undefined();
    should(parseNpmLatest(null)).be.undefined();
  });
});

describe('what Ferretry verified', () => {
  it('names a version as verified, older, unverified or unknown against the one it measured', () => {
    should(VERIFIED_CODEX_VERSION).equal('0.145.0');
    should(codexVerification('0.145.0')).equal('verified');
    should(codexVerification('0.140.0')).equal('older');
    should(codexVerification('0.163.0')).equal('unverified');
    should(codexVerification(undefined)).equal('unknown');
  });

  it('asks for the explicit yes only for a version past the verified one', () => {
    should(needsUnverifiedConsent('0.163.0')).be.true();
    should(needsUnverifiedConsent('0.145.0')).be.false();
    should(needsUnverifiedConsent('0.100.0')).be.false();
  });

  it('points at the contract guard README of the product', () => {
    should(verificationUrl('ferretry')).equal(
      'https://github.com/kirinnee/ferretry/blob/main/packages/fleet/tests/contract/README.md',
    );
  });
});

describe('how a Codex install is classified', () => {
  it('knows a Homebrew cask and a Homebrew formula', () => {
    should(classifyCodexInstall(facts('/opt/homebrew/Caskroom/codex/0.145.0/codex'))).eql({
      kind: 'homebrew',
      type: 'cask',
      package: 'codex',
    });
    should(classifyCodexInstall(facts('/opt/homebrew/Cellar/codex/0.145.0/bin/codex'))).eql({
      kind: 'homebrew',
      type: 'formula',
      package: 'codex',
    });
  });

  it('knows an npm global, its prefix and the node manager that owns the prefix', () => {
    should(
      classifyCodexInstall(
        facts('/home/kirin/.nvm/versions/node/v22/lib/node_modules/@openai/codex/bin/codex.js', {
          launchedPath: '/home/kirin/.nvm/versions/node/v22/bin/codex',
        }),
      ),
    ).eql({
      kind: 'npm-global',
      tool: 'npm',
      package: '@openai/codex',
      prefix: '/home/kirin/.nvm/versions/node/v22',
      nodeManager: 'nvm',
    });
  });

  it('knows a nix profile element, and says a bare store path is a temporary shell', () => {
    should(
      classifyCodexInstall(
        facts('/nix/store/0123456789abcdfghijklmnpqrsvwxyz-codex/bin/codex', {
          launchedPath: '/home/kirin/.nix-profile/bin/codex',
          nixProfileElement: 'codex',
        }),
      ),
    ).eql({ kind: 'nix-profile', element: 'codex' });
    should(classifyCodexInstall(facts('/nix/store/0123456789abcdfghijklmnpqrsvwxyz-codex/bin/codex')).kind).equal(
      'nix-shell',
    );
  });

  it('calls a plain file a standalone binary in its directory', () => {
    should(classifyCodexInstall(facts('/opt/bin/codex'))).eql({ kind: 'standalone', directory: '/opt/bin' });
  });
});

describe('reading the nix profile and the link chain', () => {
  it('finds the profile element whose store paths hold the binary', () => {
    const listing = {
      elements: {
        codex: { storePaths: ['/nix/store/0123456789abcdfghijklmnpqrsvwxyz-codex'] },
        other: { storePaths: ['/nix/store/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-other'] },
      },
    };
    should(parseNixProfileList(listing, ['/nix/store/0123456789abcdfghijklmnpqrsvwxyz-codex/bin/codex']).element).equal(
      'codex',
    );
    should(
      parseNixProfileList(undefined, ['/nix/store/0123456789abcdfghijklmnpqrsvwxyz-codex']).element,
    ).be.undefined();
  });

  it('follows links one hop at a time and lists the store paths and the home-manager generation it passed', async () => {
    const links = new Map([
      [
        '/etc/profiles/per-user/kirin/bin/codex',
        '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-home-manager-path/bin/codex',
      ],
      [
        '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-home-manager-path/bin/codex',
        '/nix/store/abcdfghijklmnpqrsvwxyz0123456789-codex/bin/codex',
      ],
    ]);
    const hops = await symlinkHops('/etc/profiles/per-user/kirin/bin/codex', async path => links.get(path));
    should(nixPathHops(hops)).eql([
      '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-home-manager-path/bin/codex',
      '/nix/store/abcdfghijklmnpqrsvwxyz0123456789-codex/bin/codex',
    ]);
    should(passesThroughHomeManagerPath(hops)).be.true();
    should(passesThroughHomeManagerPath(['/usr/bin/codex'])).be.false();
  });
});

describe('what updating takes', () => {
  it('runs the prefix’s own npm, and rolls back by installing the previous version', () => {
    const method = {
      kind: 'npm-global',
      tool: 'npm',
      package: '@openai/codex',
      prefix: '/home/kirin/.nvm/versions/node/v22',
      nodeManager: 'nvm',
    } as const;
    const recipe = codexUpdateRecipe(method, '0.145.0');
    should(recipe.kind).equal('self');
    if (recipe.kind !== 'self') return;
    should(recipe.run.map(harnessCommandLine)).eql([
      'npm install -g --prefix /home/kirin/.nvm/versions/node/v22 @openai/codex@0.145.0',
    ]);
    should(recipe.pinsVersion).be.true();
    should(recipe.rollback?.('0.140.0').map(harnessCommandLine)).eql([
      'npm install -g --prefix /home/kirin/.nvm/versions/node/v22 @openai/codex@0.140.0',
    ]);
  });

  it('upgrades a cask with brew and keeps no previous version to put back', () => {
    const recipe = codexUpdateRecipe({ kind: 'homebrew', type: 'cask', package: 'codex' }, undefined);
    if (recipe.kind !== 'self') throw new Error('expected a self update');
    should(recipe.run.map(harnessCommandLine)).eql(['brew update', 'brew upgrade --cask codex']);
    should(recipe.rollback).be.undefined();
  });

  it('shows steps instead for a method Ferretry cannot update, and says why for one it cannot name', () => {
    const shell = codexUpdatePlan(
      { kind: 'nix-shell', storePath: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-codex' },
      undefined,
    );
    should(shell.kind).equal('manual');
    should(codexUpdatePlan({ kind: 'unknown', reason: 'no idea' }, undefined)).containDeep({
      kind: 'manual',
      explanation: 'Ferretry cannot update Codex here: no idea.',
      steps: [],
    });
  });
});

describe('the rest of the version order', () => {
  it('orders prereleases of one release by their dot-separated parts, as semver does', () => {
    const order = (lower: string, higher: string) => [compareVersions(lower, higher), compareVersions(higher, lower)];
    should(order('0.150.0-alpha.2', '0.150.0-alpha.10')).eql([-1, 1]);
    should(order('0.150.0-1', '0.150.0-alpha')).eql([-1, 1]);
    should(order('0.150.0-alpha', '0.150.0-beta')).eql([-1, 1]);
    should(order('0.150.0-alpha', '0.150.0-alpha.1')).eql([-1, 1]);
    should(compareVersions('0.150.0-alpha.1', '0.150.0-alpha.1')).equal(0);
    should(compareVersions('0.150.0+build', '0.150.0')).equal(0);
  });

  it('names a prerelease of a later release as unverified, and of an earlier one as older', () => {
    should(codexVerification('0.146.0-alpha.1')).equal('unverified');
    should(codexVerification('0.144.0-rc.1')).equal('older');
  });
});

describe('every way a Nix store file can have been reached', () => {
  const store = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-codex';
  const reached = (launchedPath: string, extra: Partial<InstallFacts> = {}) =>
    classifyCodexInstall(facts(`${store}/bin/codex`, { launchedPath, ...extra }));

  it('reads a system profile as a module of the system’s own manager, on either platform', () => {
    should(reached('/run/current-system/sw/bin/codex')).eql({ kind: 'nix-module', manager: 'nixos' });
    should(reached('/etc/profiles/per-user/kirin/bin/codex', { platform: 'darwin' })).eql({
      kind: 'nix-module',
      manager: 'nix-darwin',
    });
    should(reached('/etc/profiles/per-user/kirin/bin/codex', { viaHomeManagerPath: true })).eql({
      kind: 'nix-module',
      manager: 'home-manager',
      via: 'nixos',
    });
  });

  it('reads a user profile as its element, as home-manager’s generation, or as nothing it can name', () => {
    const profile = '/home/kirin/.nix-profile/bin/codex';
    should(reached(profile, { nixProfileElement: 'codex' })).eql({ kind: 'nix-profile', element: 'codex' });
    should(reached(profile, { homeManagerProfile: true })).eql({ kind: 'nix-module', manager: 'home-manager' });
    should(reached(profile, { viaHomeManagerPath: true })).eql({ kind: 'nix-module', manager: 'home-manager' });
    should(reached(profile)).eql({
      kind: 'unknown',
      reason: 'this nix profile has no element for it; it may have come from nix-env',
    });
  });

  it('does not guess at a path it does not recognise', () => {
    should(reached('/srv/odd/bin/codex')).eql({
      kind: 'unknown',
      reason: '/srv/odd/bin/codex leads into the Nix store by a path Ferretry does not recognise',
    });
  });
});

describe('the install methods that are not covered above', () => {
  it('knows a Volta shim by the path it was launched as, and pnpm and bun globals by where they live', () => {
    should(
      classifyCodexInstall(
        facts('/home/kirin/.volta/bin/volta-shim', { launchedPath: '/home/kirin/.volta/bin/codex' }),
      ),
    ).eql({
      kind: 'npm-global',
      tool: 'volta',
      package: '@openai/codex',
    });
    should(classifyCodexInstall(facts('/home/kirin/.bun/install/global/node_modules/@openai/codex/bin/codex.js'))).eql({
      kind: 'npm-global',
      tool: 'bun',
      package: '@openai/codex',
    });
    should(
      classifyCodexInstall(facts('/home/kirin/.local/share/pnpm/global/5/node_modules/@openai/codex/bin/codex.js')),
    ).eql({ kind: 'npm-global', tool: 'pnpm', package: '@openai/codex' });
  });

  it('gives every method a short plain name', () => {
    should(
      (
        [
          { kind: 'npm-global', tool: 'npm', package: 'p' },
          { kind: 'npm-global', tool: 'volta', package: 'p' },
          { kind: 'homebrew', type: 'formula', package: 'p' },
          { kind: 'nix-profile', element: 'e' },
          { kind: 'nix-shell', storePath: '/nix/store/x' },
          { kind: 'nix-module', manager: 'nixos' },
          { kind: 'standalone', directory: '/d' },
          { kind: 'unknown', reason: 'r' },
        ] as const
      ).map(harnessInstallLabel),
    ).eql([
      'npm global',
      'Volta',
      'Homebrew',
      'nix profile',
      'nix shell (temporary)',
      'Nix module',
      'standalone binary',
      'unrecognised',
    ]);
  });

  it('reads Nix 2’s profile, an array whose index is the element’s name', () => {
    const profile = {
      version: 2,
      elements: [{ storePaths: ['/nix/store/other'] }, { storePaths: ['/nix/store/x-codex'] }],
    };
    should(parseNixProfileList(profile, ['/nix/store/x-codex/bin/codex'])).eql({ element: '1', homeManager: false });
  });

  it('walks a path with dot-dot parts through the links it meets', async () => {
    should(await symlinkHops('/a/./b/../claude', async () => undefined)).eql([]);
    should(await symlinkHops('/a/../../codex', async () => undefined)).eql([]);
    should(await symlinkHops('/a/b/../../codex', async path => (path === '/codex' ? '/real/codex' : undefined))).eql([
      '/real/codex',
    ]);
  });
});

describe('the rest of what updating takes', () => {
  const run = (method: Parameters<typeof codexUpdateRecipe>[0], target?: string) => {
    const recipe = codexUpdateRecipe(method, target);
    if (recipe.kind !== 'self') throw new Error('expected self');
    return recipe;
  };

  it('installs with each node package tool in its own way, and can put the previous version back the same way', () => {
    const lines = (tool: 'pnpm' | 'bun' | 'volta') => {
      const recipe = run({ kind: 'npm-global', tool, package: '@openai/codex' }, '0.145.0');
      return [recipe.run.map(harnessCommandLine), recipe.rollback?.('0.140.0').map(harnessCommandLine)];
    };
    should(lines('pnpm')).eql([['pnpm add -g @openai/codex@0.145.0'], ['pnpm add -g @openai/codex@0.140.0']]);
    should(lines('bun')).eql([['bun add -g @openai/codex@0.145.0'], ['bun add -g @openai/codex@0.140.0']]);
    should(lines('volta')).eql([['volta install @openai/codex@0.145.0'], ['volta install @openai/codex@0.140.0']]);
  });

  it('upgrades a nix profile element, refreshing it, and rolls the profile back', () => {
    const recipe = run({ kind: 'nix-profile', element: 'codex' }, undefined);
    should(recipe.run.map(harnessCommandLine)).eql(['nix profile upgrade --refresh codex']);
    should(recipe.pinsVersion).be.false();
    should(recipe.rollback?.('0.140.0').map(harnessCommandLine)).eql(['nix profile rollback']);
  });

  it('names the one switch command for each flavour of module, and where the flake is', () => {
    const steps = (method: Parameters<typeof codexUpdatePlan>[0]) => {
      const plan = codexUpdatePlan(method, undefined);
      if (plan.kind !== 'manual') throw new Error('expected manual');
      return { explanation: plan.explanation, steps: plan.steps };
    };
    const homeManager = steps({ kind: 'nix-module', manager: 'home-manager' });
    should(homeManager.steps.map(step => step.command)).eql([
      'nix flake update nixpkgs',
      'home-manager switch --flake .',
    ]);
    should(homeManager.explanation).containEql('comes from your home-manager configuration');
    const darwin = steps({ kind: 'nix-module', manager: 'nix-darwin' });
    should(darwin.steps.map(step => step.command)).eql(['nix flake update nixpkgs', 'darwin-rebuild switch --flake .']);
    should(darwin.explanation).containEql('comes from your nix-darwin configuration');
    const nixos = steps({ kind: 'nix-module', manager: 'nixos' });
    should(nixos.steps.at(-1)?.command).equal('sudo nixos-rebuild switch --flake .');
    const inside = steps({ kind: 'nix-module', manager: 'home-manager', via: 'nixos' });
    should(inside.steps.at(-1)?.command).equal('sudo nixos-rebuild switch --flake .');
    should(inside.steps.at(-1)?.note).containEql('no separate home-manager switch');
    should(inside.explanation).containEql('which nixos applies');
  });

  it('tells a standalone binary how to be replaced', () => {
    const plan = codexUpdatePlan({ kind: 'standalone', directory: '/opt/x' }, undefined);
    should(plan).containDeep({ kind: 'manual', steps: [{ command: 'npm install -g @openai/codex' }] });
    should(plan.kind === 'manual' && plan.explanation).containEql('/opt/x');
  });
});
