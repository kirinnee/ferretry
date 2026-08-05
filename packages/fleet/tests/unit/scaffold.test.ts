import { describe, it } from 'bun:test';
import should from 'should';
import { FleetConfigSchema } from '../../src/lib/config.ts';
import type { FleetLayout } from '../../src/lib/provisioning.ts';
import { buildFleetScaffold } from '../../src/lib/scaffold.ts';
import { parseSettings } from '../../src/lib/settings.ts';

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

const IDS = {
  claude: '00000000-0000-4000-8000-00000000a001',
  codex: '00000000-0000-4000-8000-00000000a002',
};

const subject = buildFleetScaffold({ layout: LAYOUT, ids: IDS, configPath: '/state/fleet/config.yaml' });

const fileAt = (path: string) => subject.files.find(file => file.path === path);

describe('buildFleetScaffold', () => {
  it('should ensure every directory the fleet owns, including the one apply never creates', () => {
    // Assert — a relative asset reference resolves into assetsDirectory, and provisioning only
    // creates the fleet, bin and homes directories.
    should(subject.directories).deepEqual([
      '/state/fleet',
      '/state/fleet/bin',
      '/state/fleet/homes',
      '/state/fleet/assets',
      '/state/fleet/assets/templates',
      '/state/fleet/assets/templates/claude',
      '/state/fleet/assets/templates/codex',
    ]);
    should(subject.directoryMode).equal(0o700);
  });

  it('should seed the configuration at the path it was told to, not one it derived', () => {
    // Act
    const elsewhere = buildFleetScaffold({ layout: LAYOUT, ids: IDS, configPath: '/somewhere/else.yaml' });

    // Assert — apply reads a path the composition root chooses; init must seed that same file.
    should(elsewhere.files.map(file => file.path)).containEql('/somewhere/else.yaml');
  });

  it('should seed every built-in asset beside the README that explains it', () => {
    // Assert
    should(subject.files.map(file => file.path)).deepEqual([
      '/state/fleet/config.yaml',
      '/state/fleet/assets/README.md',
      '/state/fleet/assets/CLAUDE.md',
      '/state/fleet/assets/templates/claude/settings.json',
      '/state/fleet/assets/templates/codex/config.toml',
    ]);
  });

  it('should write private files, because a fleet directory holds credentials', () => {
    // Assert
    for (const file of subject.files) should(file.mode).equal(0o600);
  });

  it('should say exactly what must go on PATH', () => {
    // Assert — an apply that writes wrappers nowhere on PATH reports success and produces nothing.
    should(subject.pathEntry).equal('export PATH="/state/fleet/bin:$PATH"');
  });

  it('should not double a separator when the assets directory already ends in one', () => {
    // Act
    const trailing = buildFleetScaffold({
      layout: { ...LAYOUT, assetsDirectory: '/state/fleet/assets/' },
      ids: IDS,
      configPath: '/state/fleet/config.yaml',
    });

    // Assert
    should(trailing.files.map(file => file.path)).containEql('/state/fleet/assets/README.md');
    should(trailing.files.map(file => file.path)).containEql('/state/fleet/assets/templates/codex/config.toml');
  });
});

describe('the starter configuration', () => {
  const config = () => fileAt('/state/fleet/config.yaml')?.content ?? '';

  it('should be a configuration this build actually accepts', () => {
    // Act — the scaffold is worthless if the first `fy fleet apply` rejects what it wrote.
    const parsed = FleetConfigSchema.safeParse(Bun.YAML.parse(config()));

    // Assert
    should(parsed.success).be.true();
  });

  it('should declare no accounts, so nothing is invented on the person’s behalf', () => {
    // Act
    const parsed = FleetConfigSchema.parse(Bun.YAML.parse(config()));

    // Assert
    should(parsed.agents).be.empty();
  });

  it('should declare one usable starter only when the caller selected its harness', () => {
    // Act — the file-first default stays empty; this is the explicit fast path for a first host.
    const selected = buildFleetScaffold({
      layout: LAYOUT,
      ids: IDS,
      configPath: '/state/fleet/config.yaml',
      firstAccount: 'codex',
    });
    const content = selected.files.find(file => file.path === '/state/fleet/config.yaml')?.content ?? '';
    const parsed = FleetConfigSchema.parse(Bun.YAML.parse(content));

    // Assert — one account is immediately valid for apply, while its id remains caller-supplied and stable.
    should(parsed.agents).have.length(1);
    should(parsed.agents[0]).match({ name: 'primary', kind: 'codex' });
    should(parsed.agents[0]?.routes.default).match({
      id: IDS.codex,
      wrapper: 'codex-primary',
      home: 'codex-primary',
      defaultModel: 'gpt-5.6',
      models: [{ id: 'gpt-5.6', available: true }],
    });
  });

  it('should mount every starter through the harness-scoped base profile', () => {
    // Act
    const parsed = FleetConfigSchema.parse(Bun.YAML.parse(config()));

    // Assert — every path here names a file in this same scaffold, so a standalone build cannot
    // produce a configuration whose supposedly bundled source is absent.
    should(parsed.profiles.base).match({
      memory: './CLAUDE.md',
      claude: { settings: './templates/claude/settings.json' },
      codex: { settings: './templates/codex/config.toml' },
    });
    for (const path of ['CLAUDE.md', 'templates/claude/settings.json', 'templates/codex/config.toml']) {
      should(fileAt(`/state/fleet/assets/${path}`)).not.be.undefined();
    }
  });

  it('should give only the auto lane the flags that keep an unattended launch moving', () => {
    // Act
    const parsed = FleetConfigSchema.parse(Bun.YAML.parse(config()));

    // Assert — the interactive lane retains each harness's own permission policy.
    should(parsed.variants.default?.claude?.flags).be.undefined();
    should(parsed.variants.default?.codex?.flags).be.undefined();
    should(parsed.variants.auto?.claude).match({
      flags: ['--dangerously-skip-permissions', '--disallowed-tools=AskUserQuestion'],
      settings: [{ skipDangerousModePermissionPrompt: true }],
    });
    should(parsed.variants.auto?.codex?.flags).deepEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
    ]);
  });

  it('should carry the generated ids in its example, so nobody has to invent a UUID', () => {
    // Assert
    should(config()).containEql(IDS.claude);
    should(config()).containEql(IDS.codex);
  });

  it('should keep the example commented out', () => {
    // Assert — every line mentioning an id is a comment, so the example cannot accidentally apply.
    const exampleLines = config()
      .split('\n')
      .filter(line => line.includes(IDS.claude) || line.includes(IDS.codex));
    should(exampleLines).not.be.empty();
    for (const line of exampleLines) should(line.trimStart()).startWith('#');
  });

  it('should not carry anybody’s personal paths or tooling', () => {
    // Assert — the tool this replaces kept its owner's machine paths in its templates.
    for (const file of subject.files) {
      should(file.content).not.match(/\/Users\//);
      should(file.content).not.match(/\/home\/[A-Za-z0-9_-]+\//);
      should(file.content).not.match(/loctl/);
      should(file.content).not.match(/Workspace\/atomi/);
    }
  });
});

describe('the starter asset content', () => {
  it('should keep Claude settings valid and limited to neutral editing/attribution defaults', () => {
    // Act
    const parsed = parseSettings(fileAt('/state/fleet/assets/templates/claude/settings.json')?.content ?? '', 'json');

    // Assert
    should(parsed).deepEqual({
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      includeCoAuthoredBy: false,
    });
  });

  it('should make Codex policy an obvious blank instead of guessing for the operator', () => {
    // Act
    const source = fileAt('/state/fleet/assets/templates/codex/config.toml')?.content ?? '';

    // Assert
    should(parseSettings(source, 'toml')).deepEqual({});
    should(source).containEql('Model, approval, sandbox and tool policy are deliberately left');
  });

  it('should explain what the shared instructions are and how to replace them', () => {
    // Assert
    const source = fileAt('/state/fleet/assets/CLAUDE.md')?.content ?? '';
    should(source).containEql('Claude receives');
    should(source).containEql('Codex receives');
    should(source).containEql('Replace this file');
    should(source).containEql('will not overwrite it');
  });

  it('should state the copy-on-apply and deliberately empty capability boundaries', () => {
    // Assert
    const source = fileAt('/state/fleet/assets/README.md')?.content ?? '';
    should(source).containEql('Account-home assets are copies, not symlinks');
    should(source).containEql('No hooks, MCP servers or skills are installed by default');
  });
});
