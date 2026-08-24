/**
 * Preparing this host's default fleet, through the real mount over a real temporary state home.
 *
 * The pure decision is proved in `tests/unit/fleet/boot-preparation.test.ts`. What is proved HERE is
 * the part only a filesystem can answer: that the scaffold and the apply run in that order without
 * deadlocking on the exclusive apply claim they both take, that the manifest afterwards publishes
 * exactly the accounts a detected harness earns, and — the property that matters most — that a host
 * which already has a fleet has nothing replaced.
 *
 * Nothing here is served. `prepareDefaults` is the boot's own step and has no route.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFleetManifest, DEFAULT_INSTRUCTIONS, FleetConfigSchema, resolveAccounts } from '@ferretry/fleet';
import should from 'should';
import { StateFileSystem } from '../../../../src/adapters/filesystem/state-file-system.ts';
import { ProcfsSessionRootPinner } from '../../../../src/adapters/session/filesystem/index.ts';
import { createFoundationPaths } from '../../../../src/lib/paths.ts';
import {
  createDaemonFleetSubsystem,
  type FleetDefaultsPreparation,
  type FleetSubsystem,
} from '../../../../src/lib/runtime/mounts/fleet.ts';
import { resolveStateHome } from '../../../../src/lib/state-home.ts';
import { harnessDiscoveryReader } from './support.ts';

const GENERATED_AT_MS = Date.parse('2027-04-04T10:00:00.000Z');
const temporaryDirectories: string[] = [];
let minted = 1;

interface Fixture {
  readonly paths: ReturnType<typeof createFoundationPaths>;
  readonly configPath: string;
  readonly subsystem: FleetSubsystem;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'fy-fleet-defaults-'));
  temporaryDirectories.push(root);
  const userHome = join(root, 'user');
  const paths = createFoundationPaths(resolveStateHome({ fyHome: join(root, 'fy-home'), homeDirectory: userHome }));
  const subsystem = createDaemonFleetSubsystem({
    paths,
    userHome,
    clock: { now: () => GENERATED_AT_MS },
    files: new StateFileSystem(paths),
    platform: 'linux',
    mintId: () => `defaults${String(minted++).padStart(14, '0')}`,
    // Counted rather than random: an account id has to be assertable, and one reused across two
    // lanes is the exact defect the per-lane identifier shape exists to prevent.
    mintUuid: () => `00000000-0000-4000-8000-9${String(minted++).padStart(11, '0')}`,
    confirmChange: async () => ({ kind: 'confirmed' }),
    rootPinner: new ProcfsSessionRootPinner(),
    clientName: 'fy',
    harnesses: harnessDiscoveryReader(),
  });
  return { paths, configPath: join(paths.fleet, 'config.yaml'), subsystem };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const wrappersOf = (outcome: FleetDefaultsPreparation): readonly string[] =>
  outcome.kind === 'prepared' ? outcome.wrappers : [];

describe('preparing this host default fleet', () => {
  it('should give a host with only claude exactly its two accounts, published and runnable', async () => {
    // Arrange
    const subject = await fixture();

    // Act
    const outcome = await subject.subsystem.prepareDefaults(['claude']);

    // Assert — the manifest is the file a start reads, so the names come out of it rather than out of
    // the plan that produced it.
    should(outcome.kind).equal('prepared');
    should(wrappersOf(outcome)).deepEqual(['claude-default', 'claude-auto-default']);
    const manifest = await subject.subsystem.accounts();
    should(manifest.accounts.map(account => account.mode)).deepEqual(['interactive', 'auto']);
    for (const account of manifest.accounts) {
      should(account.wrapper).startWith(join(subject.paths.fleet, 'bin'));
      // The wrapper is a real executable this host can run, which is the one thing the manifest
      // cannot declare about itself.
      should((await Bun.file(account.wrapper).stat()).mode & 0o111).be.above(0);
    }
  });

  it('should point each created account at its own instructions document, per harness and lane', async () => {
    // Arrange
    const subject = await fixture();

    // Act
    await subject.subsystem.prepareDefaults(['claude', 'codex']);

    // Assert — "configured by default" means an account READS one without anybody choosing, so the
    // composition chain is resolved and the effective value asserted.
    const accounts = resolveAccounts(await subject.subsystem.config());
    should(accounts.map(account => [account.wrapper, account.memory])).deepEqual([
      ['claude-default', DEFAULT_INSTRUCTIONS.claude.default],
      ['claude-auto-default', DEFAULT_INSTRUCTIONS.claude.auto],
      ['codex-default', DEFAULT_INSTRUCTIONS.codex.default],
      ['codex-auto-default', DEFAULT_INSTRUCTIONS.codex.auto],
    ]);
    // And the documents landed in the homes under the name each harness reads.
    const homes = join(subject.paths.fleet, 'homes');
    const assets = join(subject.paths.fleet, 'assets');
    should(await readFile(join(homes, 'claude-auto-default', 'CLAUDE.md'), 'utf8')).equal(
      await readFile(join(assets, 'CLAUDE-auto.md'), 'utf8'),
    );
    should(await readFile(join(homes, 'codex-default', 'AGENTS.md'), 'utf8')).equal(
      await readFile(join(assets, 'AGENTS.md'), 'utf8'),
    );
  });

  it('should replace nothing on a host that already has a fleet', async () => {
    // Arrange — a configuration with an account in it, and an instruction document somebody edited.
    const subject = await fixture();
    const assets = join(subject.paths.fleet, 'assets');
    await mkdir(assets, { recursive: true });
    const existingConfig = `profiles:
  base:
    claude:
      memory: ./CLAUDE.md
variants:
  default: {}
agents:
  - name: work
    kind: claude
    routes:
      default:
        id: 00000000-0000-4000-8000-0000000000f1
        wrapper: claude-work
        home: claude-work
        defaultModel: a-model
        models: [a-model]
`;
    await writeFile(subject.configPath, existingConfig, { mode: 0o600 });
    await writeFile(join(assets, 'CLAUDE.md'), '# Mine\n', { mode: 0o600 });

    // Act
    const outcome = await subject.subsystem.prepareDefaults(['claude']);

    // Assert — byte for byte. Scaffolding is create-if-absent and the kernel decides, so a host with
    // a fleet keeps every file it had.
    should(outcome.kind).equal('prepared');
    should(await readFile(subject.configPath, 'utf8')).equal(existingConfig);
    should(await readFile(join(assets, 'CLAUDE.md'), 'utf8')).equal('# Mine\n');
    should(wrappersOf(outcome)).deepEqual(['claude-work']);
    // The documents that were genuinely ABSENT are still written, which is what makes re-running safe
    // after an upgrade adds one.
    should(await Bun.file(join(assets, 'CLAUDE-auto.md')).exists()).be.true();
    should(outcome.kind === 'prepared' && outcome.kept).containEql(subject.configPath);
  });

  it('should extend a configuration whose agents list is explicitly empty', async () => {
    // Arrange — the file a previous plain `fy fleet init` left behind.
    const subject = await fixture();
    await mkdir(subject.paths.fleet, { recursive: true });
    await writeFile(
      subject.configPath,
      '# somebody kept this comment\nvariants:\n  default: {}\n  auto:\n    mode: auto\nagents: []\n',
      { mode: 0o600 },
    );

    // Act
    const outcome = await subject.subsystem.prepareDefaults(['codex']);

    // Assert — the one narrow exception to create-if-absent, and the surrounding document survives it.
    should(wrappersOf(outcome)).deepEqual(['codex-default', 'codex-auto-default']);
    should(await readFile(subject.configPath, 'utf8')).containEql('# somebody kept this comment');
  });

  it('should report a failure rather than throw, when the configuration cannot be edited safely', async () => {
    // Arrange — a zero-looking configuration this cannot splice into. It is refused rather than
    // guessed at, and the refusal has to reach the boot as a value.
    const subject = await fixture();
    await mkdir(subject.paths.fleet, { recursive: true });
    await writeFile(subject.configPath, 'agents: {}\n', { mode: 0o600 });

    // Act
    const outcome = await subject.subsystem.prepareDefaults(['claude']);

    // Assert — a boot that refused to start because it could not scaffold a convenience would be
    // strictly worse than one that starts and says what did not happen.
    should(outcome.kind).equal('failed');
    should(outcome.kind === 'failed' && outcome.reason).containEql('non-list "agents" value');
  });

  it('should report a failure when the fleet directory cannot be written', async () => {
    // Arrange — an unwritable state home is the ordinary permissions accident, and the scaffold stops
    // part-way through it.
    const subject = await fixture();
    await mkdir(subject.paths.fleet, { recursive: true });
    await chmod(subject.paths.fleet, 0o500);

    try {
      // Act
      const outcome = await subject.subsystem.prepareDefaults(['claude']);

      // Assert
      should(outcome.kind).equal('failed');
      should(outcome.kind === 'failed' && outcome.reason).match(/EACCES|permission/u);
    } finally {
      await chmod(subject.paths.fleet, 0o700);
    }
  });

  it('should write a configuration this build parses back, with one id per account', async () => {
    // Arrange
    const subject = await fixture();

    // Act
    await subject.subsystem.prepareDefaults(['claude', 'codex']);

    // Assert — a scaffold that wrote a configuration the next apply rejects would be worthless, and
    // a reused account id would give the manifest two accounts it could not tell apart.
    const parsed = FleetConfigSchema.parse(Bun.YAML.parse(await readFile(subject.configPath, 'utf8')));
    const ids = parsed.agents.flatMap(agent => Object.values(agent.routes).map(route => route.id));
    should(ids).have.length(4);
    should(new Set(ids).size).equal(4);
  });
});

/**
 * The manifest as a previous apply left it, written by hand because the point of these cases is that
 * `config.yaml` does NOT reproduce it.
 */
async function publishManifest(paths: Fixture['paths'], accounts: readonly Record<string, unknown>[]): Promise<void> {
  await mkdir(paths.fleet, { recursive: true });
  await writeFile(
    paths.fleetManifest,
    JSON.stringify(
      buildFleetManifest({
        generatedAt: '2027-04-04T09:00:00.000Z',
        accounts: accounts.map(account => ({
          mode: 'interactive',
          displayName: 'Seeded',
          defaultModel: 'a-model',
          models: [{ id: 'a-model', available: true }],
          available: true,
          unavailableReason: null,
          ...account,
        })),
      }),
    ),
    { mode: 0o600 },
  );
}

describe('preparation may only add', () => {
  it('should prepare NOTHING when applying would remove a published account', async () => {
    // Arrange — the exact reproduction: a manifest publishing one Claude account and NO config.yaml,
    // so the configuration preparation would write declares only the accounts it just created.
    const subject = await fixture();
    const seeded = join(subject.paths.fleet, 'bin', 'claude-seeded');
    await publishManifest(subject.paths, [
      {
        id: '00000000-0000-4000-8000-0000000000a1',
        kind: 'claude',
        wrapper: seeded,
        home: join(subject.paths.fleet, 'homes', 'claude-seeded'),
      },
    ]);
    const before = await readFile(subject.paths.fleetManifest, 'utf8');

    // Act
    const outcome = await subject.subsystem.prepareDefaults(['codex']);

    // Assert — refused, and NOTHING was written. The manifest still publishes the seeded account,
    // asserted on the file rather than on a notice.
    should(outcome.kind).equal('refused');
    should(outcome.kind === 'refused' && outcome.conflicts).deepEqual([
      {
        account: 'claude-seeded',
        reason: 'it is published now and the configuration does not declare it, so this would remove it',
      },
    ]);
    should(await readFile(subject.paths.fleetManifest, 'utf8')).equal(before);
    should((await subject.subsystem.accounts()).accounts.map(account => account.wrapper)).deepEqual([seeded]);
    // Not one byte of the fleet was created, either — not the configuration, not the documents.
    should(await Bun.file(subject.configPath).exists()).be.false();
    should(await Bun.file(join(subject.paths.fleet, 'assets', 'CLAUDE.md')).exists()).be.false();
  });

  it('should prepare NOTHING when applying would republish an account differently', async () => {
    // Arrange — a configuration that declares the same account id with a different wrapper. This is
    // the general case behind the reproduction: an operator edited config.yaml and has not applied it,
    // and a restart must not publish that edit for them.
    const subject = await fixture();
    const identifier = '00000000-0000-4000-8000-0000000000b1';
    await publishManifest(subject.paths, [
      {
        id: identifier,
        kind: 'claude',
        wrapper: join(subject.paths.fleet, 'bin', 'claude-old-name'),
        home: join(subject.paths.fleet, 'homes', 'claude-work'),
      },
    ]);
    await writeFile(
      subject.configPath,
      `variants:
  default: {}
agents:
  - name: work
    kind: claude
    routes:
      default:
        id: ${identifier}
        wrapper: claude-new-name
        home: claude-work
        defaultModel: a-model
        models: [a-model]
`,
      { mode: 0o600 },
    );

    // Act
    const outcome = await subject.subsystem.prepareDefaults(['codex']);

    // Assert
    should(outcome.kind).equal('refused');
    should(outcome.kind === 'refused' && outcome.conflicts[0]?.account).equal('claude-old-name');
    should(outcome.kind === 'refused' && outcome.conflicts[0]?.reason).containEql('a different wrapper');
    should((await subject.subsystem.accounts()).accounts[0]?.wrapper).endWith('claude-old-name');
  });

  it('should add only the addition and leave every published account byte-identical', async () => {
    // Arrange — a host with a real, applied Claude fleet, and Codex newly installed. This is the
    // journey the feature is for: restart, get the missing harness's accounts, lose nothing.
    const subject = await fixture();
    should((await subject.subsystem.prepareDefaults(['claude'])).kind).equal('prepared');
    const before = (await subject.subsystem.accounts()).accounts;
    const beforeConfig = await readFile(subject.configPath, 'utf8');

    // Act — Codex has no account, so preparation fires for it alone. The configuration already
    // declares agents, so nothing can be added to it and the honest answer is that nothing was.
    const outcome = await subject.subsystem.prepareDefaults(['codex']);

    // Assert
    should(outcome.kind).equal('nothing-added');
    should(await readFile(subject.configPath, 'utf8')).equal(beforeConfig);
    should((await subject.subsystem.accounts()).accounts).deepEqual(before);
  });

  it('should add both harnesses at once on a first run and report only the additions', async () => {
    // Arrange
    const subject = await fixture();

    // Act
    const outcome = await subject.subsystem.prepareDefaults(['claude', 'codex']);

    // Assert — everything is an addition when nothing was published, so the two lists agree.
    should(outcome.kind).equal('prepared');
    should(wrappersOf(outcome)).deepEqual([
      'claude-default',
      'claude-auto-default',
      'codex-default',
      'codex-auto-default',
    ]);
    should(outcome.kind === 'prepared' && outcome.published).deepEqual([...wrappersOf(outcome)]);
  });

  it('should refuse rather than guess when the published manifest cannot be read', async () => {
    // Arrange — damage is not an empty fleet. A manifest this daemon cannot parse says nothing about
    // what is published, so acting as though the answer were "nothing" could take an account away.
    const subject = await fixture();
    await mkdir(subject.paths.fleet, { recursive: true });
    await writeFile(subject.paths.fleetManifest, '{ not json', { mode: 0o600 });

    // Act
    const outcome = await subject.subsystem.prepareDefaults(['claude']);

    // Assert
    should(outcome.kind).equal('failed');
    should(outcome.kind === 'failed' && outcome.reason).containEql('unreadable or invalid');
    should(await Bun.file(subject.configPath).exists()).be.false();
  });
});
