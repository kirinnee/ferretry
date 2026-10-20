import { describe, it } from 'bun:test';
import should from 'should';
import * as harnessUpdate from '../../src/lib/harness-update.ts';
import {
  classifyHarnessInstall,
  describeHarnessInstall,
  HARNESS_PACKAGES,
  type HarnessCliView,
  type HarnessInstallFacts,
  type HarnessInstallMethod,
  harnessChangelogUrl,
  harnessCommandLine,
  harnessInstallLabel,
  harnessUpdatePlan,
  harnessUpdateRecipe,
  harnessUpdateTargets,
  harnessVerification,
  harnessVerificationUrl,
  installedHarnessVersion,
  needsUnverifiedConsent,
  npmLatestUrl,
  parseHarnessVersion,
  parseNpmLatest,
  VERIFIED_HARNESS_VERSIONS,
} from '../../src/lib/harness-update.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const HOME = '/home/kirin';
const STORE = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-claude-code-2.1.220';

const facts = (overrides: Partial<HarnessInstallFacts>): HarnessInstallFacts => ({
  harness: 'claude',
  launchedPath: '/home/kirin/.local/bin/claude',
  resolvedPath: '/home/kirin/.local/bin/claude',
  homeDirectory: HOME,
  platform: 'linux',
  ...overrides,
});

const CHANGELOG = 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md';
const VERIFIED_URL = 'https://github.com/kirinnee/ferretry/blob/main/packages/fleet/tests/contract/README.md';

const view = (overrides: Partial<HarnessCliView>): HarnessCliView => ({
  harness: 'claude',
  location: { state: 'located', path: '/usr/local/bin/claude', rule: 'inherited environment', declaredBy: 'PATH' },
  installed: { state: 'ok', version: '2.1.200' },
  method: { kind: 'npm-global', tool: 'npm', package: '@anthropic-ai/claude-code', prefix: '/usr/local' },
  plan: {
    kind: 'self',
    steps: [{ command: 'npm install -g --prefix /usr/local @anthropic-ai/claude-code@latest' }],
    rollback: 'automatic',
    pinsVersion: true,
  },
  check: { state: 'ok', checkedAt: '2026-10-20T09:00:00.000Z', latest: { version: '2.1.230', url: CHANGELOG } },
  verified: { version: '2.1.220', url: VERIFIED_URL },
  verification: 'older',
  available: true,
  job: null,
  ...overrides,
});

const cases: readonly SchemaCase[] = [
  { name: 'verification', schema: harnessUpdate.HarnessVerificationSchema, value: 'unverified' },
  { name: 'node tool', schema: harnessUpdate.NodePackageToolSchema, value: 'pnpm' },
  { name: 'node manager', schema: harnessUpdate.NodeVersionManagerSchema, value: 'nvm' },
  {
    name: 'npm method',
    schema: harnessUpdate.HarnessInstallMethodSchema,
    value: { kind: 'npm-global', tool: 'npm', package: '@openai/codex', prefix: '/usr', nodeManager: 'fnm' },
  },
  { name: 'program', schema: harnessUpdate.HarnessUpdateProgramSchema, value: 'harness' },
  {
    name: 'plan',
    schema: harnessUpdate.HarnessUpdatePlanSchema,
    value: { kind: 'manual', explanation: 'Do it.', steps: [{ command: 'nix flake update nixpkgs' }] },
  },
  { name: 'location', schema: harnessUpdate.HarnessCliLocationSchema, value: { state: 'absent', searched: [] } },
  {
    name: 'installed',
    schema: harnessUpdate.HarnessInstalledVersionSchema,
    value: { state: 'unreadable', reason: 'it timed out' },
  },
  { name: 'outcome', schema: harnessUpdate.HarnessUpdateOutcomeSchema, value: 'rolled-back' },
  {
    name: 'report',
    schema: harnessUpdate.HarnessUpdateReportSchema,
    value: {
      from: '0.145.0',
      to: '0.163.0',
      outcome: 'succeeded',
      message: 'Updated.',
      finishedAt: '2026-10-20T09:00:00.000Z',
    },
  },
  {
    name: 'job',
    schema: harnessUpdate.HarnessUpdateJobSchema,
    value: { state: 'running', startedAt: '2026-10-20T09:00:00.000Z', command: 'brew update' },
  },
  { name: 'view one', schema: harnessUpdate.HarnessCliViewSchema, value: view({}) },
  { name: 'view', schema: harnessUpdate.HarnessUpdateViewSchema, value: { harnesses: [view({})] } },
  {
    name: 'start',
    schema: harnessUpdate.HarnessUpdateStartRequestSchema,
    value: { harness: 'codex', target: '0.163.0', confirmUnverified: true },
  },
  {
    name: 'unverified body',
    schema: harnessUpdate.HarnessUpdateUnverifiedBodySchema,
    value: { error: 'no', code: 'harness_update_unverified', target: '0.163.0', verified: '0.145.0' },
  },
];

describe('the harness update wire contract', () => {
  it('covers every exported schema', () => assertCoversEverySchema(harnessUpdate, cases));
  it('round-trips every case', () => assertRoundTrips(cases));
  it('refuses what the contract does not allow', () =>
    assertRejects([
      {
        name: 'bad target',
        schema: harnessUpdate.HarnessUpdateStartRequestSchema,
        value: { harness: 'claude', target: 'latest' },
      },
      { name: 'other harness', schema: harnessUpdate.HarnessUpdateStartRequestSchema, value: { harness: 'gemini' } },
      {
        name: 'empty self plan',
        schema: harnessUpdate.HarnessUpdatePlanSchema,
        value: { kind: 'self', steps: [], rollback: 'none', pinsVersion: false },
      },
    ]));
});

describe('classifyHarnessInstall', () => {
  const classify = (overrides: Partial<HarnessInstallFacts>): HarnessInstallMethod =>
    classifyHarnessInstall(facts(overrides));

  it('reads a Homebrew cask and a Homebrew formula from where the file resolves', () => {
    should(classify({ resolvedPath: '/opt/homebrew/Caskroom/claude-code/2.1.200/claude' })).eql({
      kind: 'homebrew',
      type: 'cask',
      package: 'claude-code',
    });
    should(classify({ harness: 'codex', resolvedPath: '/opt/homebrew/Cellar/codex/0.145.0/bin/codex' })).eql({
      kind: 'homebrew',
      type: 'formula',
      package: 'codex',
    });
  });

  it('decides a store path by the daemon’s own rule — before the npm layout nixpkgs also has', () => {
    const resolvedPath = `${STORE}/lib/node_modules/@anthropic-ai/claude-code/cli.js`;
    should(
      classify({ launchedPath: `${HOME}/.nix-profile/bin/claude`, resolvedPath, nixProfileElement: 'claude-code' }),
    ).eql({
      kind: 'nix-profile',
      element: 'claude-code',
    });
    should(classify({ launchedPath: `${STORE}/bin/claude`, resolvedPath })).eql({
      kind: 'nix-shell',
      storePath: STORE,
    });
    should(
      classify({
        launchedPath: '/etc/profiles/per-user/kirin/bin/claude',
        resolvedPath,
        viaHomeManagerPath: true,
        platform: 'darwin',
      }),
    ).eql({ kind: 'nix-module', manager: 'home-manager', via: 'nix-darwin' });
  });

  it('reads an npm global with its prefix and the node manager that owns it', () => {
    should(
      classify({
        launchedPath: `${HOME}/.nvm/versions/node/v22.1.0/bin/claude`,
        resolvedPath: `${HOME}/.nvm/versions/node/v22.1.0/lib/node_modules/@anthropic-ai/claude-code/cli.js`,
      }),
    ).eql({
      kind: 'npm-global',
      tool: 'npm',
      package: '@anthropic-ai/claude-code',
      prefix: `${HOME}/.nvm/versions/node/v22.1.0`,
      nodeManager: 'nvm',
    });
    should(classify({ resolvedPath: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js' })).eql({
      kind: 'npm-global',
      tool: 'npm',
      package: '@anthropic-ai/claude-code',
      prefix: '/usr/local',
    });
    should(classify({ resolvedPath: '/opt/npm/node_modules/@anthropic-ai/claude-code/cli.js' })).eql({
      kind: 'npm-global',
      tool: 'npm',
      package: '@anthropic-ai/claude-code',
      prefix: '/opt/npm',
    });
    should(classify({ resolvedPath: '/node_modules/@anthropic-ai/claude-code/cli.js' })).eql({
      kind: 'npm-global',
      tool: 'npm',
      package: '@anthropic-ai/claude-code',
    });
    for (const [path, manager] of [
      [`${HOME}/.local/share/fnm/node-versions/v22/installation`, 'fnm'],
      [`${HOME}/.asdf/installs/nodejs/22`, 'asdf'],
      [`${HOME}/.local/share/mise/installs/node/22`, 'mise'],
    ] as const)
      should(classify({ resolvedPath: `${path}/lib/node_modules/@anthropic-ai/claude-code/cli.js` })).have.property(
        'nodeManager',
        manager,
      );
  });

  it('reads Volta, Bun and pnpm globals as their own tools', () => {
    should(classify({ launchedPath: `${HOME}/.volta/bin/claude`, resolvedPath: `${HOME}/.volta/bin/volta-shim` })).eql({
      kind: 'npm-global',
      tool: 'volta',
      package: '@anthropic-ai/claude-code',
    });
    should(
      classify({
        harness: 'codex',
        resolvedPath: `${HOME}/.bun/install/global/node_modules/@openai/codex/bin/codex.js`,
      }),
    ).eql({ kind: 'npm-global', tool: 'bun', package: '@openai/codex' });
    should(
      classify({ resolvedPath: `${HOME}/.local/share/pnpm/global/5/node_modules/@anthropic-ai/claude-code/cli.js` }),
    ).eql({
      kind: 'npm-global',
      tool: 'pnpm',
      package: '@anthropic-ai/claude-code',
    });
  });

  it('reads Claude Code’s own installer, and anything else as a standalone file', () => {
    should(classify({ resolvedPath: `${HOME}/.local/share/claude/versions/2.1.200` })).eql({
      kind: 'native-installer',
      directory: `${HOME}/.local/share/claude`,
    });
    should(classify({ harness: 'codex', resolvedPath: `${HOME}/.local/share/claude/versions/2.1.200` })).eql({
      kind: 'standalone',
      directory: `${HOME}/.local/share/claude/versions`,
    });
    should(classify({ harness: 'codex', resolvedPath: '/codex' })).eql({ kind: 'standalone', directory: '/' });
  });
});

describe('the words for a method', () => {
  const methods: readonly [HarnessInstallMethod, string, string][] = [
    [
      { kind: 'npm-global', tool: 'npm', package: '@openai/codex', prefix: '/usr', nodeManager: 'nvm' },
      'npm global',
      'npm global package @openai/codex in /usr (node from nvm)',
    ],
    [{ kind: 'npm-global', tool: 'volta', package: '@openai/codex' }, 'Volta', 'volta global package @openai/codex'],
    [{ kind: 'homebrew', type: 'cask', package: 'codex' }, 'Homebrew', 'Homebrew cask codex'],
    [
      { kind: 'native-installer', directory: '/h/.local/share/claude' },
      'Claude Code installer',
      "Claude Code's own installer, in /h/.local/share/claude",
    ],
    [{ kind: 'nix-profile', element: 'codex' }, 'nix profile', 'nix profile element codex'],
    [{ kind: 'nix-shell', storePath: STORE }, 'nix shell (temporary)', `nix shell store path ${STORE}`],
    [{ kind: 'nix-module', manager: 'nixos' }, 'Nix module', 'nixos module'],
    [{ kind: 'standalone', directory: '/opt' }, 'standalone binary', 'standalone binary in /opt'],
    [{ kind: 'unknown', reason: 'why' }, 'unrecognised', 'unrecognised install (why)'],
  ];
  it('labels and describes every method', () => {
    for (const [method, label, detail] of methods) {
      should(harnessInstallLabel(method)).equal(label);
      should(describeHarnessInstall(method)).equal(detail);
    }
  });
});

describe('harnessUpdateRecipe and harnessUpdatePlan', () => {
  const lines = (harness: 'claude' | 'codex', method: HarnessInstallMethod, target?: string) =>
    harnessUpdatePlan(harness, method, target);

  it('updates every JavaScript global with its own tool, pinned, with the previous version as the rollback', () => {
    const npm: HarnessInstallMethod = { kind: 'npm-global', tool: 'npm', package: '@openai/codex', prefix: '/p' };
    should(lines('codex', npm, '0.163.0')).eql({
      kind: 'self',
      steps: [{ command: 'npm install -g --prefix /p @openai/codex@0.163.0' }],
      rollback: 'automatic',
      pinsVersion: true,
    });
    const recipe = harnessUpdateRecipe('codex', npm, undefined);
    should(recipe.kind === 'self' && recipe.rollback?.('0.145.0')).eql([
      { program: 'npm', args: ['install', '-g', '--prefix', '/p', '@openai/codex@0.145.0'] },
    ]);
    const command = (tool: 'npm' | 'pnpm' | 'bun' | 'volta') => {
      const plan = lines('claude', { kind: 'npm-global', tool, package: '@anthropic-ai/claude-code' });
      return plan.steps[0]?.command;
    };
    should(command('npm')).equal('npm install -g @anthropic-ai/claude-code@latest');
    should(command('pnpm')).equal('pnpm add -g @anthropic-ai/claude-code@latest');
    should(command('bun')).equal('bun add -g @anthropic-ai/claude-code@latest');
    should(command('volta')).equal('volta install @anthropic-ai/claude-code@latest');
  });

  it('refreshes Homebrew first and keeps no rollback; upgrades a formula without --cask', () => {
    should(lines('claude', { kind: 'homebrew', type: 'cask', package: 'claude-code' })).eql({
      kind: 'self',
      steps: [{ command: 'brew update' }, { command: 'brew upgrade --cask claude-code' }],
      rollback: 'none',
      pinsVersion: false,
    });
    should(lines('codex', { kind: 'homebrew', type: 'formula', package: 'codex' }).steps[1]).eql({
      command: 'brew upgrade codex',
    });
  });

  it('upgrades a nix profile element with --refresh and rolls back with nix profile rollback', () => {
    should(lines('codex', { kind: 'nix-profile', element: 'codex' })).eql({
      kind: 'self',
      steps: [{ command: 'nix profile upgrade --refresh codex' }],
      rollback: 'automatic',
      pinsVersion: false,
    });
    const recipe = harnessUpdateRecipe('codex', { kind: 'nix-profile', element: 'codex' }, undefined);
    should(recipe.kind === 'self' && recipe.rollback?.('0.145.0')).eql([
      { program: 'nix', args: ['profile', 'rollback'] },
    ]);
  });

  it('uses `claude update` for the newest and `claude install <version>` for a chosen one', () => {
    const native: HarnessInstallMethod = { kind: 'native-installer', directory: '/h/.local/share/claude' };
    should(lines('claude', native)).eql({
      kind: 'self',
      steps: [{ command: 'claude update' }],
      rollback: 'automatic',
      pinsVersion: true,
    });
    should(lines('claude', native, '2.1.220')).eql({
      kind: 'self',
      steps: [{ command: 'claude install 2.1.220' }],
      rollback: 'automatic',
      pinsVersion: true,
    });
    const recipe = harnessUpdateRecipe('claude', native, undefined);
    should(recipe.kind === 'self' && recipe.rollback?.('2.1.200')).eql([
      { program: 'harness', args: ['install', '2.1.200'] },
    ]);
  });

  it('reports the flake steps for a module and never runs them', () => {
    const plan = lines('claude', { kind: 'nix-module', manager: 'home-manager', via: 'nixos' });
    should(plan.kind).equal('manual');
    should(plan.steps.map(step => step.command)).eql([
      'nix flake update nixpkgs',
      'sudo nixos-rebuild switch --flake .',
    ]);
    should(plan.steps[0]?.note).match(/provides claude-code is usually nixpkgs/u);
    should(lines('codex', { kind: 'nix-module', manager: 'home-manager' }).steps[1]).eql({
      command: 'home-manager switch --flake .',
    });
  });

  it('hands a temporary shell, a standalone file and an unknown install the steps a person runs', () => {
    should(lines('codex', { kind: 'nix-shell', storePath: STORE })).match({
      kind: 'manual',
      steps: [{ command: 'nix profile install nixpkgs#codex' }],
    });
    should(lines('claude', { kind: 'standalone', directory: '/opt' }).steps).eql([
      { command: 'curl -fsSL https://claude.ai/install.sh | bash' },
    ]);
    should(lines('codex', { kind: 'standalone', directory: '/opt' }).steps[0]?.command).equal(
      'npm install -g @openai/codex',
    );
    should(lines('codex', { kind: 'unknown', reason: 'odd' })).eql({
      kind: 'manual',
      explanation: 'Ferretry cannot update Codex here: odd.',
      steps: [],
    });
  });

  it('writes the harness program as the harness’s own name', () => {
    should(harnessCommandLine('codex', { program: 'harness', args: ['--version'] })).equal('codex --version');
  });
});

describe('versions and verification', () => {
  it('reads both harnesses’ --version output', () => {
    should(parseHarnessVersion('2.1.220 (Claude Code)')).equal('2.1.220');
    should(parseHarnessVersion('codex-cli 0.163.0')).equal('0.163.0');
    should(parseHarnessVersion('codex-cli 0.164.0-alpha.1')).equal('0.164.0-alpha.1');
    should(parseHarnessVersion('no version')).be.undefined();
  });

  it('places a version against the one Ferretry verified', () => {
    should(VERIFIED_HARNESS_VERSIONS).eql({ claude: '2.1.220', codex: '0.145.0' });
    should(harnessVerification('codex', '0.145.0')).equal('verified');
    should(harnessVerification('codex', '0.140.0')).equal('older');
    should(harnessVerification('codex', '0.163.0')).equal('unverified');
    should(harnessVerification('codex', 'nonsense')).equal('unknown');
    should(harnessVerification('codex', undefined)).equal('unknown');
    should(needsUnverifiedConsent('codex', '0.163.0')).be.true();
    should(needsUnverifiedConsent('claude', '2.1.220')).be.false();
  });

  it('reads npm’s latest, refusing anything that is not a stable version', () => {
    should(parseNpmLatest('codex', { version: '0.163.0', name: '@openai/codex' })).eql({
      version: '0.163.0',
      url: 'https://github.com/openai/codex/releases/tag/rust-v0.163.0',
    });
    should(parseNpmLatest('claude', { version: '2.2.0-beta.1' })).be.undefined();
    should(parseNpmLatest('claude', { version: 'latest' })).be.undefined();
    should(parseNpmLatest('claude', 'nope')).be.undefined();
  });

  it('names its addresses from the one package table', () => {
    should(npmLatestUrl(HARNESS_PACKAGES.claude.npm)).equal(
      'https://registry.npmjs.org/@anthropic-ai/claude-code/latest',
    );
    should(harnessVerificationUrl('ferretry')).equal(VERIFIED_URL);
    should(harnessChangelogUrl('claude', '2.1.230')).equal(CHANGELOG);
  });
});

describe('the versions a person is offered', () => {
  it('offers the newest, and the verified one too when the method can install it and it lies between', () => {
    should(harnessUpdateTargets(view({}))).eql({ latest: '2.1.230', verified: '2.1.220' });
    should(installedHarnessVersion(view({}))).equal('2.1.200');
  });

  it('offers nothing chosen to a method that takes what it has', () => {
    should(
      harnessUpdateTargets(
        view({ plan: { kind: 'self', steps: [{ command: 'brew update' }], rollback: 'none', pinsVersion: false } }),
      ),
    ).eql({ latest: '2.1.230' });
  });

  it('offers no verified version when it is not newer than what runs, or the newest is not past it', () => {
    should(harnessUpdateTargets(view({ installed: { state: 'ok', version: '2.1.225' } }))).eql({ latest: '2.1.230' });
    const verifiedIsNewest = view({
      check: { state: 'ok', checkedAt: '2026-10-20T09:00:00.000Z', latest: { version: '2.1.220', url: CHANGELOG } },
    });
    should(harnessUpdateTargets(verifiedIsNewest)).eql({ latest: '2.1.220' });
  });

  it('offers the last known newest after a failed check, and nothing when nothing was ever learned', () => {
    const failed = view({
      installed: { state: 'unreadable', reason: 'odd' },
      check: {
        state: 'failed',
        checkedAt: '2026-10-20T09:00:00.000Z',
        reason: 'could not reach npm',
        lastKnown: { checkedAt: '2026-10-20T08:00:00.000Z', latest: { version: '2.1.230', url: CHANGELOG } },
      },
    });
    should(harnessUpdateTargets(failed)).eql({ latest: '2.1.230', verified: '2.1.220' });
    should(installedHarnessVersion(failed)).be.undefined();
    should(harnessUpdateTargets(view({ check: { state: 'never' }, plan: null }))).eql({});
  });
});
