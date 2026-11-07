import { describe, it } from 'bun:test';
import should from 'should';
import {
  classifyCodexInstall,
  codexUpdatePlan,
  codexUpdateRecipe,
  codexVerification,
  compareVersions,
  harnessCommandLine,
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
