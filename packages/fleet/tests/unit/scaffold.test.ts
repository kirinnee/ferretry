import { describe, it } from 'bun:test';
import should from 'should';
import { FleetConfigSchema } from '../../src/lib/config.ts';
import type { FleetLayout } from '../../src/lib/provisioning.ts';
import { buildFleetScaffold } from '../../src/lib/scaffold.ts';

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
    ]);
    should(subject.directoryMode).equal(0o700);
  });

  it('should seed the configuration at the path it was told to, not one it derived', () => {
    // Act
    const elsewhere = buildFleetScaffold({ layout: LAYOUT, ids: IDS, configPath: '/somewhere/else.yaml' });

    // Assert — apply reads a path the composition root chooses; init must seed that same file.
    should(elsewhere.files.map(file => file.path)).containEql('/somewhere/else.yaml');
  });

  it('should seed an assets README beside the assets it explains', () => {
    // Assert
    should(fileAt('/state/fleet/assets/README.md')).not.be.undefined();
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
    should(config()).not.match(/\/Users\//);
    should(config()).not.match(/loctl/);
  });
});
