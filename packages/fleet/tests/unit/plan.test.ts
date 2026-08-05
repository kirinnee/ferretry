import { describe, it } from 'bun:test';
import should from 'should';
import { UnimplementedFleetCapabilityError } from '../../src/lib/capabilities.ts';
import { type FleetConfig, FleetConfigSchema } from '../../src/lib/config.ts';
import { declaredAssetFields, FleetPlan, UnknownDefaultHomeError, UnsupportedAssetError } from '../../src/lib/plan.ts';
import type { ResolvedAccount } from '../../src/lib/profiles.ts';
import type { FleetLayout, FleetWriteOperation } from '../../src/lib/provisioning.ts';
import { MANAGED_MARKER } from '../../src/lib/wrappers.ts';

const ID_CLAUDE = '00000000-0000-4000-8000-00000000c1a1';
const ID_CODEX = '00000000-0000-4000-8000-00000000c0de';
const GENERATED_AT = '2027-03-04T05:06:07.000Z';

const LAYOUT: FleetLayout = {
  stateHome: '/state',
  userHome: '/home/tester',
  fleetDirectory: '/state/fleet',
  binDirectory: '/state/fleet/bin',
  homesDirectory: '/state/fleet/homes',
  assetsDirectory: '/state/fleet/assets',
  manifestPath: '/state/fleet/manifest.json',
  defaultHomeDirectories: { claude: '/home/tester/.claude', codex: '/home/tester/.codex' },
};

const route = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ID_CLAUDE,
  wrapper: 'fy-claude-work',
  home: '~/.claude-work',
  defaultModel: 'opus',
  models: ['opus'],
  ...patch,
});

const config = (patch: Record<string, unknown> = {}): FleetConfig =>
  FleetConfigSchema.parse({
    agents: [{ name: 'work', kind: 'claude', routes: { default: route() } }],
    ...patch,
  });

const subject = new FleetPlan();

const resolved = (patch: Partial<ResolvedAccount> = {}): ResolvedAccount =>
  ({
    settings: [],
    memory: undefined,
    skills: undefined,
    hooks: undefined,
    hooksDir: undefined,
    mcp: undefined,
    ...patch,
  }) as ResolvedAccount;

const operationsOf = (built: { operations: readonly FleetWriteOperation[] }, kind: FleetWriteOperation['kind']) =>
  built.operations.filter(operation => operation.kind === kind);

describe('declaredAssetFields', () => {
  it('should report nothing for an account that declares no assets', () => {
    // Act
    const actual = declaredAssetFields(resolved());

    // Assert
    should([...actual]).deepEqual([]);
  });

  it('should treat a non-empty settings stack as a declared asset', () => {
    // Act
    const actual = declaredAssetFields(resolved({ settings: [{ model: 'x' }] }));

    // Assert
    should([...actual]).deepEqual(['settings']);
  });

  it('should report path assets in materialization order', () => {
    // Act
    const actual = declaredAssetFields(resolved({ mcp: '.mcp.json', memory: 'CLAUDE.md', hooks: 'hooks.json' }));

    // Assert
    should([...actual]).deepEqual(['memory', 'hooks', 'mcp']);
  });
});

describe('FleetPlan', () => {
  it('should create the fleet, bin, homes, and per-account directories privately', () => {
    // Act
    const actual = subject.build(config(), LAYOUT, GENERATED_AT);

    // Assert
    should(operationsOf(actual, 'directory')).deepEqual([
      { kind: 'directory', path: '/state/fleet', mode: 0o700 },
      { kind: 'directory', path: '/state/fleet/bin', mode: 0o700 },
      { kind: 'directory', path: '/state/fleet/homes', mode: 0o700 },
      { kind: 'directory', path: '/home/tester/.claude-work', mode: 0o700 },
    ]);
  });

  it('should write each wrapper into the bin directory as an executable', () => {
    // Act
    const actual = subject.build(config(), LAYOUT, GENERATED_AT);
    const [wrapper] = operationsOf(actual, 'file');

    // Assert
    should(wrapper).match({ path: '/state/fleet/bin/fy-claude-work', mode: 0o755 });
    should(wrapper?.kind === 'file' && wrapper.content).containEql(`export CLAUDE_CONFIG_DIR="$HOME/.claude-work"`);
  });

  it('should keep the declared home form in the wrapper but publish the expanded one', () => {
    // Act
    const actual = subject.build(config(), LAYOUT, GENERATED_AT);
    const [wrapper] = operationsOf(actual, 'file');

    // Assert — the script stays portable; the manifest and the filesystem need an absolute path.
    should(wrapper?.kind === 'file' && wrapper.content).containEql('"$HOME/.claude-work"');
    should(actual.manifest.accounts[0]?.home).equal('/home/tester/.claude-work');
  });

  it('should resolve a relative account home under the homes directory', () => {
    // Arrange
    const input = config({
      agents: [{ name: 'work', kind: 'claude', routes: { default: route({ home: 'claude-work' }) } }],
    });

    // Act
    const actual = subject.build(input, LAYOUT, GENERATED_AT);

    // Assert
    should(actual.manifest.accounts[0]?.home).equal('/state/fleet/homes/claude-work');
  });

  it('should publish the wrapper as a full path so a consumer never reassembles a name', () => {
    // Act
    const actual = subject.build(config(), LAYOUT, GENERATED_AT);

    // Assert
    should(actual.manifest.accounts[0]?.wrapper).equal('/state/fleet/bin/fy-claude-work');
    should(actual.manifest.generatedAt).equal(GENERATED_AT);
    should(actual.manifestPath).equal('/state/fleet/manifest.json');
  });

  it('should source the configured secrets file rather than a hardcoded one', () => {
    // Arrange
    const input = config({ secretsFile: '~/.config/fy/secrets.sh' });

    // Act
    const actual = subject.build(input, LAYOUT, GENERATED_AT);
    const [wrapper] = operationsOf(actual, 'file');

    // Assert
    should(wrapper?.kind === 'file' && wrapper.content).containEql('. "$HOME/.config/fy/secrets.sh"');
  });

  it('should link path assets and plan settings as unresolved layers', () => {
    // Arrange
    const input = config({
      profiles: { shared: { memory: 'CLAUDE.md', skills: '~/assets/skills', settings: ['base.json', { model: 'x' }] } },
      agents: [{ name: 'work', kind: 'claude', profiles: ['shared'], routes: { default: route() } }],
    });

    // Act
    const actual = subject.build(input, LAYOUT, GENERATED_AT);

    // Assert
    should(operationsOf(actual, 'symlink')).deepEqual([
      { kind: 'symlink', source: '/state/fleet/assets/CLAUDE.md', path: '/home/tester/.claude-work/CLAUDE.md' },
      { kind: 'symlink', source: '/home/tester/assets/skills', path: '/home/tester/.claude-work/skills' },
    ]);
    should(operationsOf(actual, 'settings')).deepEqual([
      {
        kind: 'settings',
        path: '/home/tester/.claude-work/settings.json',
        format: 'json',
        layers: [
          { from: 'file', path: '/state/fleet/assets/base.json' },
          { from: 'inline', settings: { model: 'x' } },
        ],
        mode: 0o600,
        preserveExisting: true,
      },
    ]);
  });

  it('should plan no settings operation when the account declares no layers', () => {
    // Act
    const actual = subject.build(config(), LAYOUT, GENERATED_AT);

    // Assert
    should(operationsOf(actual, 'settings')).deepEqual([]);
  });

  it('should use the codex destinations and format for a codex account', () => {
    // Arrange
    const input = config({
      profiles: { shared: { memory: 'AGENTS.md', hooks: 'hooks.json', hooksDir: 'hooks', settings: [{ a: 1 }] } },
      agents: [
        {
          name: 'work',
          kind: 'codex',
          profiles: ['shared'],
          routes: { default: route({ id: ID_CODEX, wrapper: 'fy-codex-work', home: '~/.codex-work' }) },
        },
      ],
    });

    // Act
    const actual = subject.build(input, LAYOUT, GENERATED_AT);

    // Assert
    should(operationsOf(actual, 'settings').map(operation => operation.path)).deepEqual([
      '/home/tester/.codex-work/config.toml',
    ]);
    should(operationsOf(actual, 'symlink').map(operation => operation.path)).deepEqual([
      '/home/tester/.codex-work/AGENTS.md',
      '/home/tester/.codex-work/hooks.json',
      '/home/tester/.codex-work/hooks',
    ]);
  });

  it.each([
    ['claude', 'hooksDir', { hooksDir: 'hooks' }],
    ['claude', 'hooks', { hooks: 'hooks.json' }],
    ['codex', 'mcp', { mcp: '.mcp.json' }],
  ])('should refuse an asset %s cannot materialize (%s) instead of dropping it', (kind, _field, asset) => {
    // Arrange — the tool this replaces silently ignored these.
    const input = config({
      profiles: { shared: asset },
      agents: [
        {
          name: 'work',
          kind,
          profiles: ['shared'],
          routes: { default: route({ id: kind === 'codex' ? ID_CODEX : ID_CLAUDE }) },
        },
      ],
    });

    // Act
    const act = () => subject.build(input, LAYOUT, GENERATED_AT);

    // Assert
    should(act).throw(UnsupportedAssetError);
  });

  it('should materialize the nominated account into the bare harness home, chosen by id', () => {
    // Arrange
    const input = config({
      profiles: { shared: { memory: 'CLAUDE.md' } },
      agents: [{ name: 'work', kind: 'claude', profiles: ['shared'], routes: { default: route() } }],
      defaultHomes: { claude: ID_CLAUDE },
    });

    // Act
    const actual = subject.build(input, LAYOUT, GENERATED_AT);

    // Assert
    should(operationsOf(actual, 'symlink').map(operation => operation.path)).deepEqual([
      '/home/tester/.claude-work/CLAUDE.md',
      '/home/tester/.claude/CLAUDE.md',
    ]);
    should(operationsOf(actual, 'directory').map(operation => operation.path)).containEql('/home/tester/.claude');
  });

  it('should reject a default home naming an account that does not exist', () => {
    // Arrange — the schema catches this too; the builder must not assume it was parsed.
    const input = { ...config(), defaultHomes: { claude: ID_CODEX } } as FleetConfig;

    // Act
    const act = () => subject.build(input, LAYOUT, GENERATED_AT);

    // Assert
    should(act).throw(UnknownDefaultHomeError);
  });

  it('should generate a command that execs its target wrapper by resolved id', () => {
    // Arrange
    const input = config({ commands: [{ wrapper: 'fy-yolo', target: ID_CLAUDE, flags: ['--dangerous'] }] });

    // Act
    const actual = subject.build(input, LAYOUT, GENERATED_AT);
    const command = operationsOf(actual, 'file').find(operation => operation.path.endsWith('fy-yolo'));

    // Assert
    should(command).match({ mode: 0o755 });
    should(command?.kind === 'file' && command.content).containEql(
      `exec '/state/fleet/bin/fy-claude-work' '--dangerous' "$@"`,
    );
  });

  it('should fan an alias out over every account of the harnesses it lists', () => {
    // Arrange
    const input = config({
      variants: { default: {}, auto: {} },
      agents: [
        {
          name: 'work',
          kind: 'claude',
          routes: { default: route(), auto: route({ id: ID_CODEX, wrapper: 'fy-claude-auto', home: '~/.claude-a' }) },
        },
      ],
      aliases: { yolo: { claude: '--yes --force' } },
    });

    // Act
    const actual = subject.build(input, LAYOUT, GENERATED_AT);
    const names = operationsOf(actual, 'file').map(operation => operation.path);

    // Assert
    should(names).containEql('/state/fleet/bin/yolo-fy-claude-work');
    should(names).containEql('/state/fleet/bin/yolo-fy-claude-auto');
  });

  it('should end with a prune bounded to the bin directory, the marker, and every generated name', () => {
    // Arrange
    const input = config({ commands: [{ wrapper: 'fy-yolo', target: ID_CLAUDE }] });

    // Act
    const actual = subject.build(input, LAYOUT, GENERATED_AT);
    const [prune] = operationsOf(actual, 'prune');

    // Assert
    should(prune).deepEqual({
      kind: 'prune',
      path: '/state/fleet/bin',
      marker: MANAGED_MARKER,
      keep: ['fy-claude-work', 'fy-yolo'],
    });
    should(actual.operations.at(-1)).equal(prune);
  });

  it('should reject two homes written differently that expand to the same directory', () => {
    // Arrange — the schema compares the declared strings, so only expansion catches this.
    const input = config({
      variants: { default: {}, auto: {} },
      agents: [
        {
          name: 'work',
          kind: 'claude',
          routes: {
            default: route({ home: '~/.claude-work' }),
            auto: route({ id: ID_CODEX, wrapper: 'fy-claude-auto', home: '/home/tester/.claude-work' }),
          },
        },
      ],
    });

    // Act
    const act = () => subject.build(input, LAYOUT, GENERATED_AT);

    // Assert
    should(act).throw(/duplicate home directory/);
  });

  it('should plan nothing but the fleet skeleton for a configuration with no agents', () => {
    // Arrange
    const input = FleetConfigSchema.parse({});

    // Act
    const actual = subject.build(input, LAYOUT, GENERATED_AT);

    // Assert
    should(actual.manifest.accounts).deepEqual([]);
    should(actual.operations.map(operation => operation.kind)).deepEqual([
      'directory',
      'directory',
      'directory',
      'prune',
    ]);
  });

  it('should carry declared unavailability into the manifest instead of offering a model', () => {
    // Arrange
    const input = config({
      agents: [
        {
          name: 'work',
          kind: 'claude',
          routes: {
            default: route({
              available: false,
              unavailableReason: 'pool down',
              defaultModel: undefined,
              models: [{ id: 'fable', available: false, unavailableReason: 'pool down' }],
            }),
          },
        },
      ],
    });

    // Act
    const actual = subject.build(input, LAYOUT, GENERATED_AT);

    // Assert
    should(actual.manifest.accounts[0]).match({
      available: false,
      unavailableReason: 'pool down',
      defaultModel: null,
    });
  });
});

describe('FleetPlan capability refusal', () => {
  it('should refuse to plan a configuration that asks for a capability this build lacks', () => {
    // Arrange
    const input = config({ sharedHistory: { codex: true } });

    // Act
    const act = (): unknown => subject.build(input, LAYOUT, GENERATED_AT);

    // Assert — refused while planning, so `--dry-run` cannot print a plan an apply could not honour.
    should(act).throw(UnimplementedFleetCapabilityError);
  });

  it('should plan normally when the same sections carry their defaults', () => {
    // Act
    const actual = subject.build(config({ sharedHistory: {}, health: {}, usage: {} }), LAYOUT, GENERATED_AT);

    // Assert
    should(actual.manifest.accounts).have.length(1);
  });
});
