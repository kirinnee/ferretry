import { describe, it } from 'bun:test';
import should from 'should';
import { FleetConfigSchema } from '../../src/lib/config.ts';
import { DEFAULT_INSTRUCTIONS, defaultAccountsFor } from '../../src/lib/defaults.ts';
import { resolveAccounts } from '../../src/lib/profiles.ts';
import type { FleetLayout } from '../../src/lib/provisioning.ts';
import { buildFleetScaffold, fleetScaffoldIds } from '../../src/lib/scaffold.ts';
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

/** One identifier per (harness × lane), spelled out so every assertion can name the exact one. */
const IDS = {
  claude: {
    default: '00000000-0000-4000-8000-00000000a001',
    auto: '00000000-0000-4000-8000-00000000a002',
  },
  codex: {
    default: '00000000-0000-4000-8000-00000000a003',
    auto: '00000000-0000-4000-8000-00000000a004',
  },
} as const;

const subject = buildFleetScaffold({ layout: LAYOUT, ids: IDS, configPath: '/state/fleet/config.yaml' });

const fileAt = (path: string) => subject.files.find(file => file.path === path);

/** The starter a host with these harnesses detected would be given. */
const starterFor = (harnesses: readonly ('claude' | 'codex')[]) =>
  buildFleetScaffold({ layout: LAYOUT, ids: IDS, configPath: '/state/fleet/config.yaml', firstAccounts: harnesses });

const configOf = (scaffold: ReturnType<typeof buildFleetScaffold>) =>
  FleetConfigSchema.parse(
    Bun.YAML.parse(scaffold.files.find(file => file.path === '/state/fleet/config.yaml')?.content ?? ''),
  );

describe('fleetScaffoldIds', () => {
  it('should spend one identifier per harness and lane, never reusing one across lanes', () => {
    // Arrange
    let minted = 0;

    // Act
    const ids = fleetScaffoldIds(() => `id-${String(++minted)}`);

    // Assert — an account id must never be shared: two lanes on one id are two accounts the manifest
    // could not tell apart.
    should(minted).equal(4);
    should(new Set([ids.claude.default, ids.claude.auto, ids.codex.default, ids.codex.auto]).size).equal(4);
  });
});

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
      '/state/fleet/assets/CLAUDE-auto.md',
      '/state/fleet/assets/AGENTS.md',
      '/state/fleet/assets/AGENTS-auto.md',
      '/state/fleet/assets/templates/claude/settings.json',
      '/state/fleet/assets/templates/codex/config.toml',
    ]);
  });

  it('should write all four instruction documents even for a host with one harness', () => {
    // Act — the configuration points BOTH harnesses at their own documents whatever is installed, so
    // writing only the detected pair would leave a live reference to a file nothing made.
    const claudeOnly = starterFor(['claude']);

    // Assert
    for (const lane of ['default', 'auto'] as const) {
      for (const kind of ['claude', 'codex'] as const) {
        const reference = DEFAULT_INSTRUCTIONS[kind][lane].replace('./', '');
        should(claudeOnly.files.map(file => file.path)).containEql(`/state/fleet/assets/${reference}`);
      }
    }
  });

  it('should write private files, because a fleet directory holds credentials', () => {
    // Assert
    for (const file of subject.files) should(file.mode).equal(0o600);
  });

  it('should say exactly what must go on PATH', () => {
    // Assert — the line is for a person typing a wrapper name; a start uses the absolute path the
    // manifest publishes and needs none of it.
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
    should(trailing.files.map(file => file.path)).containEql('/state/fleet/assets/CLAUDE-auto.md');
    should(trailing.files.map(file => file.path)).containEql('/state/fleet/assets/templates/codex/config.toml');
  });

  it('should name the harnesses it declared, so a caller can report them without re-deriving', () => {
    // Assert — absent when nothing was declared, because "declared none" and "declared an empty
    // list" would otherwise be the same value.
    should(subject.declaration).be.undefined();
    should(starterFor(['claude', 'codex']).declaration).deepEqual({
      path: '/state/fleet/config.yaml',
      accounts: ['claude', 'codex'],
    });
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

  it('should declare no accounts when no harness was named', () => {
    // Act
    const parsed = FleetConfigSchema.parse(Bun.YAML.parse(config()));

    // Assert
    should(parsed.agents).be.empty();
  });

  it('should give a host with only claude detected exactly two accounts, correctly named', () => {
    // Act — the whole point of the change: a detected harness earns its own accounts and an
    // undetected one earns none.
    const parsed = configOf(starterFor(['claude']));

    // Assert
    should(parsed.agents).have.length(1);
    should(parsed.agents[0]).match({ name: 'default', kind: 'claude', auth: 'oauth' });
    should(Object.values(parsed.agents[0]?.routes ?? {}).map(route => route.wrapper)).deepEqual([
      'claude-default',
      'claude-auto-default',
    ]);
    should(parsed.agents[0]?.routes.default).match({
      id: IDS.claude.default,
      wrapper: 'claude-default',
      home: 'claude-default',
      defaultModel: 'claude-opus-5',
      models: [{ id: 'claude-opus-5', available: true }],
    });
    should(parsed.agents[0]?.routes.auto).match({
      id: IDS.claude.auto,
      wrapper: 'claude-auto-default',
      home: 'claude-auto-default',
    });
  });

  it('should give a host with both harnesses one agent each and four accounts in all', () => {
    // Act
    const accounts = resolveAccounts(configOf(starterFor(['claude', 'codex'])));

    // Assert — one agent per harness with two lanes on it, never two agents: the lanes share a
    // provider login, so two agents would ask for the same sign-in twice.
    should(accounts.map(account => account.wrapper)).deepEqual([
      'claude-default',
      'claude-auto-default',
      'codex-default',
      'codex-auto-default',
    ]);
    should(accounts.map(account => account.mode)).deepEqual(['interactive', 'auto', 'interactive', 'auto']);
    // Two provider logins, not four: an identity is `<kind>:<identity>`, so the two harnesses share
    // the agent name `default` and still keep separate credentials.
    should(new Set(accounts.map(account => `${account.kind}:${account.identity}`)).size).equal(2);
  });

  it('should give an unattended default account the -auto instructions and an attended one the plain ones', () => {
    // Act — the proof for "configured by default": the composition chain is resolved and the
    // account's effective `memory` is read, rather than asserting that a document exists.
    const accounts = resolveAccounts(configOf(starterFor(['claude', 'codex'])));
    const memoryOf = (wrapper: string) => accounts.find(account => account.wrapper === wrapper)?.memory;

    // Assert — the `auto` VARIANT slot is applied after the base profile slot, so its per-harness
    // overlay replaces the base document for that lane only.
    should(memoryOf('claude-default')).equal(DEFAULT_INSTRUCTIONS.claude.default);
    should(memoryOf('claude-auto-default')).equal(DEFAULT_INSTRUCTIONS.claude.auto);
    should(memoryOf('codex-default')).equal(DEFAULT_INSTRUCTIONS.codex.default);
    should(memoryOf('codex-auto-default')).equal(DEFAULT_INSTRUCTIONS.codex.auto);
  });

  it('should point every default account at the document defaultAccountsFor names for it', () => {
    // Act — one table, two readers: the configuration writer and anything reporting what an account
    // reads. A drift between them would be a fleet pointing at a file nobody registered.
    const declared = defaultAccountsFor(['claude', 'codex']);
    const resolved = resolveAccounts(configOf(starterFor(['claude', 'codex'])));

    // Assert
    should(resolved.map(account => account.memory)).deepEqual(declared.map(account => account.instructions));
  });

  it('should register all four instruction documents as named shared documents', () => {
    // Act
    const parsed = FleetConfigSchema.parse(Bun.YAML.parse(config()));

    // Assert — one shared `default` is what forced Codex to read a document whose own text said it
    // was Claude's; the registry is per harness and per lane now.
    should(parsed.shared.memory).deepEqual({
      claude: DEFAULT_INSTRUCTIONS.claude.default,
      'claude-auto': DEFAULT_INSTRUCTIONS.claude.auto,
      codex: DEFAULT_INSTRUCTIONS.codex.default,
      'codex-auto': DEFAULT_INSTRUCTIONS.codex.auto,
    });
  });

  it('should add the declared accounts to the empty starter without replacing its comments', () => {
    // Arrange — this is the file left by a previous plain `fy fleet init`.
    const selected = starterFor(['codex']);
    const update = selected.files.find(file => file.path === '/state/fleet/config.yaml')?.updateIfPresent;
    const existing = `${config()}# A comment the owner added before asking for an account.\n`;

    // Act
    const updated = update?.(existing) ?? '';
    const parsed = FleetConfigSchema.parse(Bun.YAML.parse(updated));

    // Assert — the surrounding document stays as it was, but it is no longer an empty fleet.
    should(updated).containEql('# A comment the owner added before asking for an account.');
    should(parsed.agents).match([{ name: 'default', kind: 'codex' }]);
    should(Object.keys(parsed.agents[0]?.routes ?? {})).deepEqual(['default', 'auto']);
  });

  it('should append the accounts when the existing configuration omits the agents key entirely', () => {
    // Arrange — an omitted key is an empty declaration under the schema, so it is extended too.
    const update = starterFor(['claude']).files.find(file => file.path === '/state/fleet/config.yaml')?.updateIfPresent;

    // Act
    const updated = update?.('# only a comment\nvariants:\n  default: {}\n') ?? '';

    // Assert
    should(updated).containEql('# only a comment');
    should(Bun.YAML.parse(updated)).have.property('agents');
  });

  it('should leave a configuration with accounts alone when asked to declare defaults', () => {
    // Arrange — a host that already has a fleet gets nothing replaced.
    const selected = starterFor(['claude']);
    const update = selected.files.find(file => file.path === '/state/fleet/config.yaml')?.updateIfPresent;
    const existing = selected.files.find(file => file.path === '/state/fleet/config.yaml')?.content ?? '';

    // Act / Assert
    should(update?.(existing)).be.undefined();
  });

  it('should declare only the lanes the existing configuration has variants for', () => {
    // Arrange — a hand-written empty fleet that never declared the `auto` lane. A route names a
    // variant and the schema refuses an undeclared one, so writing an `auto` route here would take a
    // valid empty fleet and leave a file that no longer parses.
    const update = starterFor(['claude']).files.find(file => file.path === '/state/fleet/config.yaml')?.updateIfPresent;

    // Act
    const laneless = FleetConfigSchema.parse(Bun.YAML.parse(update?.('variants:\n  default: {}\nagents: []\n') ?? ''));
    // An absent `variants` key is the schema's own `{ default: {} }`, so the interactive lane is still
    // available on a document that says nothing about lanes at all.
    const silent = FleetConfigSchema.parse(Bun.YAML.parse(update?.('agents: []\n') ?? ''));

    // Assert
    should(Object.keys(laneless.agents[0]?.routes ?? {})).deepEqual(['default']);
    should(Object.keys(silent.agents[0]?.routes ?? {})).deepEqual(['default']);
  });

  it('should refuse rather than write an agent with no route at all', () => {
    // Arrange — a `variants` value nothing can be declared safely against.
    const update = starterFor(['claude']).files.find(file => file.path === '/state/fleet/config.yaml')?.updateIfPresent;

    // Act / Assert — an agent must declare at least one route, so an empty one would be a document
    // the very next read rejects.
    should(() => update?.('variants: []\nagents: []\n')).throw(/declares none of the default lanes/u);
  });

  it('should refuse a zero-looking configuration it cannot edit safely rather than guess', () => {
    // Arrange
    const update = starterFor(['claude']).files.find(file => file.path === '/state/fleet/config.yaml')?.updateIfPresent;

    // Act / Assert — damaged state is not an empty fleet.
    should(() => update?.('agents: {}\n')).throw(/non-list "agents" value/u);
    should(() => update?.('- not: a mapping\n')).throw(/not a YAML mapping/u);
    should(() => update?.(': :\n\tbroken')).throw(/not valid YAML/u);
    // An empty fleet written in JSON flow style is still an empty fleet, and still not one this can
    // splice a block mapping into without rewriting somebody's document.
    should(() => update?.('{"agents": []}\n')).throw(/Ferretry cannot safely edit/u);
  });

  it('should mount every starter through the harness-scoped base profile', () => {
    // Act
    const parsed = FleetConfigSchema.parse(Bun.YAML.parse(config()));

    // Assert — every path here names a file in this same scaffold, so a standalone build cannot
    // produce a configuration whose supposedly bundled source is absent.
    should(parsed.profiles.base).match({
      claude: { memory: './CLAUDE.md', settings: './templates/claude/settings.json' },
      codex: { memory: './AGENTS.md', settings: './templates/codex/config.toml' },
    });
    // `memory` is declared per harness only: one flat value is what gave Codex Claude's document.
    should(parsed.profiles.base?.memory).be.undefined();
    for (const path of [
      'CLAUDE.md',
      'CLAUDE-auto.md',
      'AGENTS.md',
      'AGENTS-auto.md',
      'templates/claude/settings.json',
      'templates/codex/config.toml',
    ]) {
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
      memory: './CLAUDE-auto.md',
      flags: ['--dangerously-skip-permissions', '--disallowed-tools=AskUserQuestion'],
      settings: [{ skipDangerousModePermissionPrompt: true }],
    });
    should(parsed.variants.auto?.codex).match({
      memory: './AGENTS-auto.md',
      flags: ['--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen'],
    });
  });

  it('should carry the generated ids in its example, so nobody has to invent a UUID', () => {
    // Assert — both are the CLAUDE agent's ids, because the example declares one Claude account with
    // two lanes; spending the codex id on a claude route is the defect the shape now prevents.
    should(config()).containEql(IDS.claude.default);
    should(config()).containEql(IDS.claude.auto);
  });

  it('should keep the example commented out', () => {
    // Assert — every line mentioning an id is a comment, so the example cannot accidentally apply.
    const exampleLines = config()
      .split('\n')
      .filter(line => line.includes(IDS.claude.default) || line.includes(IDS.claude.auto));
    should(exampleLines).not.be.empty();
    for (const line of exampleLines) should(line.trimStart()).startWith('#');
  });

  it('should keep the example commented out even when accounts were declared', () => {
    // Assert — a declared starter still teaches the schema, and still may not apply by accident.
    const content = starterFor(['claude']).files.find(file => file.path === '/state/fleet/config.yaml')?.content ?? '';
    const exampleLines = content.split('\n').filter(line => line.includes('claude-work'));
    should(exampleLines).not.be.empty();
    for (const line of exampleLines) should(line.trimStart()).startWith('#');
    should(content).containEql('This is a second Claude account');
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

  it('should name each harness in its own instructions document rather than the other one', () => {
    // Assert — the shared document told Codex it was Claude's, which is why there are four now.
    should(fileAt('/state/fleet/assets/CLAUDE.md')?.content).containEql('Claude account');
    should(fileAt('/state/fleet/assets/CLAUDE.md')?.content).containEql('`CLAUDE.md`');
    should(fileAt('/state/fleet/assets/AGENTS.md')?.content).containEql('Codex account');
    should(fileAt('/state/fleet/assets/AGENTS.md')?.content).containEql('`AGENTS.md`');
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      should(fileAt(`/state/fleet/assets/${name}`)?.content).containEql('Replace it with your own');
      should(fileAt(`/state/fleet/assets/${name}`)?.content).containEql('never overwrites it');
    }
  });

  it('should tell an unattended agent not to wait, and an attended one nothing of the kind', () => {
    // Assert — the advice inverts between the lanes, which is the reason they are two documents.
    for (const name of ['CLAUDE-auto.md', 'AGENTS-auto.md']) {
      const source = fileAt(`/state/fleet/assets/${name}`)?.content ?? '';
      should(source).containEql('Never wait for input');
      should(source).containEql('write down the');
      should(source).containEql('Report what was done AND what was not');
      should(source).containEql('before claiming the work is complete');
    }
    should(fileAt('/state/fleet/assets/CLAUDE.md')?.content).not.containEql('Never wait for input');
  });

  it('should state which mechanism each field gets and the deliberately empty capabilities', () => {
    // Assert — all three mechanisms, said where somebody about to edit a file will read them: a person
    // who does not know whether their edit is shared, private or discarded finds out the expensive way.
    const source = fileAt('/state/fleet/assets/README.md')?.content ?? '';
    should(source).containEql('it **is** the file in');
    should(source).containEql('`settings` is generated, never linked');
    should(source).containEql('A source outside this directory is copied');
    should(source).containEql('No hooks, MCP servers or skills are installed by default');
    // The README names the four documents it ships, so it cannot describe a fleet it no longer writes.
    for (const name of ['CLAUDE.md', 'CLAUDE-auto.md', 'AGENTS.md', 'AGENTS-auto.md']) {
      should(source).containEql(name);
    }
  });
});
