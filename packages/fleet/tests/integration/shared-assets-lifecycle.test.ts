/**
 * Shared documents from the scaffold through a real apply, on a real filesystem.
 *
 * The unit tier proves what the report says. This proves the part only a filesystem can: that an
 * account which references a shared document ends up holding THAT DOCUMENT in its home — same device,
 * same inode — rather than a copy of it, and that moving an account onto a shared document preserves
 * the copy it was using rather than deleting it.
 *
 * The inode assertion is the one that matters and the one a copy cannot fake. Comparing bytes proves
 * only that two files were equal at that instant, which was true of the copy this replaced; the edit
 * made with no apply in between is what distinguishes the two mechanisms, so it is the test written.
 *
 * Nothing here is a fixture configuration. The starting document is the one `fy fleet init` writes, so
 * a change that made the shipped scaffold's registry disagree with the files it writes fails here.
 */
import { describe, it } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { FileFleetProvisioner } from '../../src/adapters/file-provisioner.ts';
import { FileFleetScaffolder } from '../../src/adapters/file-scaffolder.ts';
import { type FleetConfig, FleetConfigSchema } from '../../src/lib/config.ts';
import { FleetPlan } from '../../src/lib/plan.ts';
import type { FleetLayout } from '../../src/lib/provisioning.ts';
import { buildFleetScaffold, fleetScaffoldIds } from '../../src/lib/scaffold.ts';
import { accountSharing, resolveFleetSharing } from '../../src/lib/sharing.ts';

const CLAUDE_ID = '00000000-0000-4000-8000-00000000e1a1';
const CODEX_ID = '00000000-0000-4000-8000-00000000e0de';
const SECOND_CLAUDE_ID = '00000000-0000-4000-8000-00000000e1a2';
/** Counted rather than random, so the starter this host is given is byte-identical across runs. */
let minted = 0;
const SCAFFOLD_IDS = fleetScaffoldIds(() => `00000000-0000-4000-8000-0000000e${String(++minted).padStart(4, '0')}`);
const GENERATED_AT = '2027-05-06T07:08:09.000Z';
const PRIVATE_TEXT = '# Only this account\n\nIts own instructions.\n';

const account = (kind: 'claude' | 'codex', id: string, layer?: Record<string, unknown>): Record<string, unknown> => ({
  name: kind,
  kind,
  routes: {
    default: {
      id,
      wrapper: `${kind}-shared`,
      home: `${kind}-shared`,
      defaultModel: `${kind}-test-model`,
      models: [`${kind}-test-model`],
      ...(layer === undefined ? {} : { layer }),
    },
  },
});

interface Host {
  readonly root: string;
  readonly layout: FleetLayout;
  readonly configPath: string;
  readonly starter: Record<string, unknown>;
}

/** A host prepared exactly as `fy fleet init` prepares one. */
async function prepared(): Promise<Host> {
  const root = await mkdtemp(path.join(tmpdir(), 'fy-shared-assets-'));
  const fleet = path.join(root, 'fleet');
  const layout: FleetLayout = {
    stateHome: root,
    userHome: path.join(root, 'user'),
    fleetDirectory: fleet,
    binDirectory: path.join(fleet, 'bin'),
    homesDirectory: path.join(fleet, 'homes'),
    assetsDirectory: path.join(fleet, 'assets'),
    manifestPath: path.join(fleet, 'manifest.json'),
    defaultHomeDirectories: { claude: path.join(root, 'user', '.claude'), codex: path.join(root, 'user', '.codex') },
  };
  const configPath = path.join(fleet, 'config.yaml');
  await new FileFleetScaffolder([fleet]).scaffold(buildFleetScaffold({ layout, configPath, ids: SCAFFOLD_IDS }));
  return {
    root,
    layout,
    configPath,
    starter: Bun.YAML.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>,
  };
}

const applied = async (host: Host, config: FleetConfig): Promise<void> => {
  await new FileFleetProvisioner([host.layout.fleetDirectory]).apply(
    new FleetPlan().build(config, host.layout, GENERATED_AT),
  );
};

describe('shared fleet assets on a real host', () => {
  it('should recognise each shipped starter document as the shared default its own harness reads', async () => {
    // Arrange
    const host = await prepared();
    try {
      const config = FleetConfigSchema.parse({
        ...host.starter,
        agents: [account('claude', CLAUDE_ID), account('codex', CODEX_ID)],
      });

      // Act
      await applied(host, config);

      // Assert — the registry the scaffold declares names the files the scaffold wrote, so each
      // account reports as SHARING one rather than as an account that happens to name a path. This is
      // the whole migration story for an existing host: a declaration, with nothing moved.
      //
      // TWO DOCUMENTS RATHER THAN ONE, which is the correction: the previous starter registered a
      // single `default` and handed Codex a file whose own text said it belonged to Claude.
      const sharing = resolveFleetSharing(config);
      should(sharing.documents).containEql({
        field: 'memory',
        name: 'claude',
        path: './CLAUDE.md',
        accounts: [CLAUDE_ID],
      });
      should(sharing.documents).containEql({
        field: 'memory',
        name: 'codex',
        path: './AGENTS.md',
        accounts: [CODEX_ID],
      });
      should(accountSharing(sharing, CLAUDE_ID)?.fields.memory).match({ state: 'shared', name: 'claude' });
      should(accountSharing(sharing, CODEX_ID)?.fields.memory).match({ state: 'shared', name: 'codex' });

      // And "reads it" is the filesystem's answer, not the report's: each home holds the bytes of its
      // own harness's document, under the name that harness expects.
      should(await readFile(path.join(host.layout.homesDirectory, 'claude-shared', 'CLAUDE.md'), 'utf8')).equal(
        await readFile(path.join(host.layout.assetsDirectory, 'CLAUDE.md'), 'utf8'),
      );
      should(await readFile(path.join(host.layout.homesDirectory, 'codex-shared', 'AGENTS.md'), 'utf8')).equal(
        await readFile(path.join(host.layout.assetsDirectory, 'AGENTS.md'), 'utf8'),
      );
      // Not each other's. A Codex home holding Claude's document is the defect, and it has to fail here.
      should(await readFile(path.join(host.layout.homesDirectory, 'codex-shared', 'AGENTS.md'), 'utf8')).not.equal(
        await readFile(path.join(host.layout.assetsDirectory, 'CLAUDE.md'), 'utf8'),
      );
    } finally {
      await rm(host.root, { recursive: true, force: true });
    }
  });

  it('should give one account a second shared document without moving the other', async () => {
    // Arrange — a fleet with two named instruction documents, which is what "multiple CLAUDE.md to
    // configure" means: the registry names both, and each account references whichever it uses.
    const host = await prepared();
    try {
      await writeFile(path.join(host.layout.assetsDirectory, 'terse.md'), 'Be brief.\n', 'utf8');
      const shared = host.starter.shared as { readonly memory: Record<string, string> };
      const config = FleetConfigSchema.parse({
        ...host.starter,
        // The shipped registry plus one more name, so the four starters keep their declarations.
        shared: { ...shared, memory: { ...shared.memory, terse: './terse.md' } },
        agents: [account('claude', CLAUDE_ID, { memory: './terse.md' }), account('codex', CODEX_ID)],
      });

      // Act
      await applied(host, config);

      // Assert
      const sharing = resolveFleetSharing(config);
      should(accountSharing(sharing, CLAUDE_ID)?.fields.memory).match({ state: 'shared', name: 'terse', referrers: 1 });
      should(accountSharing(sharing, CODEX_ID)?.fields.memory).match({ state: 'shared', name: 'codex' });
      should(await readFile(path.join(host.layout.homesDirectory, 'claude-shared', 'CLAUDE.md'), 'utf8')).equal(
        'Be brief.\n',
      );
      should(await readFile(path.join(host.layout.homesDirectory, 'codex-shared', 'AGENTS.md'), 'utf8')).equal(
        await readFile(path.join(host.layout.assetsDirectory, 'AGENTS.md'), 'utf8'),
      );
    } finally {
      await rm(host.root, { recursive: true, force: true });
    }
  });

  it('should move an account off its own copy onto the shared document without losing the copy', async () => {
    // Arrange — the host every existing install looks like after somebody edited one account's
    // instructions: a private document, referenced by that account alone.
    const host = await prepared();
    try {
      const own = path.join(host.layout.assetsDirectory, 'accounts', 'claude-shared', 'CLAUDE.md');
      await mkdir(path.dirname(own), { recursive: true });
      await writeFile(own, PRIVATE_TEXT, 'utf8');
      const before = FleetConfigSchema.parse({
        ...host.starter,
        agents: [
          account('claude', CLAUDE_ID, { memory: './accounts/claude-shared/CLAUDE.md' }),
          account('codex', CODEX_ID),
        ],
      });
      await applied(host, before);
      should(accountSharing(resolveFleetSharing(before), CLAUDE_ID)?.fields.memory).match({ state: 'local' });
      should(await readFile(path.join(host.layout.homesDirectory, 'claude-shared', 'CLAUDE.md'), 'utf8')).equal(
        PRIVATE_TEXT,
      );

      // Act — exactly the edit a link derives: the account's own overlay names the shared document.
      const after = FleetConfigSchema.parse({
        ...host.starter,
        agents: [account('claude', CLAUDE_ID, { memory: './CLAUDE.md' }), account('codex', CODEX_ID)],
      });
      await applied(host, after);

      // Assert — the account now reads the shared document, and its old one is still on disk with its
      // original bytes. Migrating onto a shared default never destroys what an account was using.
      const shared = await readFile(path.join(host.layout.assetsDirectory, 'CLAUDE.md'), 'utf8');
      should(accountSharing(resolveFleetSharing(after), CLAUDE_ID)?.fields.memory).match({
        state: 'shared',
        name: 'claude',
        // One, not two: the Codex account resolves to its own `AGENTS.md`, so Claude's document has
        // exactly one referrer even though both accounts read a declared shared document.
        referrers: 1,
      });
      should(await readFile(path.join(host.layout.homesDirectory, 'claude-shared', 'CLAUDE.md'), 'utf8')).equal(shared);
      should(await readFile(own, 'utf8')).equal(PRIVATE_TEXT);
    } finally {
      await rm(host.root, { recursive: true, force: true });
    }
  });

  it('should never pool a credential when accounts share every document they can', async () => {
    // Arrange — both accounts on every shared document the starter declares.
    const host = await prepared();
    try {
      const config = FleetConfigSchema.parse({
        ...host.starter,
        agents: [account('claude', CLAUDE_ID), account('codex', CODEX_ID)],
      });

      // Act
      await applied(host, config);

      // Assert — each account still has its own home, which is where its provider credential lives, and
      // nothing under the assets tree or a home is a link into a shared pool. Sharing instructions can
      // never become sharing a login.
      const homes = config.agents.flatMap(agent => Object.values(agent.routes).map(route => route.home));
      should(new Set(homes).size).equal(homes.length);
      for (const home of homes) {
        should(
          (await Bun.file(path.join(host.layout.homesDirectory, home, 'CLAUDE.md')).exists()) ||
            (await Bun.file(path.join(host.layout.homesDirectory, home, 'AGENTS.md')).exists()),
        ).be.true();
      }
      should(await Bun.file(path.join(host.layout.fleetDirectory, 'shared', 'claude')).exists()).be.false();
    } finally {
      await rm(host.root, { recursive: true, force: true });
    }
  });

  it('should give a member that chose nothing a working home from the starter defaults alone', async () => {
    // Arrange — one account of each harness, declaring no memory, no settings, no skills, no hooks.
    // Everything it gets has to come from the `base` profile the shipped starter writes.
    const host = await prepared();
    try {
      const config = FleetConfigSchema.parse({
        ...host.starter,
        agents: [account('claude', CLAUDE_ID), account('codex', CODEX_ID)],
      });

      // Act
      await applied(host, config);

      // Assert — instructions arrive as a LINK to the registered shared document, so the default is
      // also the thing an operator edits once for the whole fleet.
      for (const [home, document] of [
        ['claude-shared/CLAUDE.md', 'CLAUDE.md'],
        ['codex-shared/AGENTS.md', 'AGENTS.md'],
      ] as const) {
        const entry = path.join(host.layout.homesDirectory, ...home.split('/'));
        should((await lstat(entry)).isSymbolicLink()).be.true();
        should(await realpath(entry)).equal(await realpath(path.join(host.layout.assetsDirectory, document)));
      }

      // Settings arrive as a generated file carrying the shipped base layer, so a harness that reads
      // its own settings on start finds a valid document rather than nothing.
      const claudeSettings = path.join(host.layout.homesDirectory, 'claude-shared', 'settings.json');
      should((await lstat(claudeSettings)).isSymbolicLink()).be.false();
      should(JSON.parse(await readFile(claudeSettings, 'utf8'))).have.property('$schema');
      const codexSettings = path.join(host.layout.homesDirectory, 'codex-shared', 'config.toml');
      should((await lstat(codexSettings)).isSymbolicLink()).be.false();
      should(typeof (await readFile(codexSettings, 'utf8'))).equal('string');

      // And nothing that executes code is installed by default: a skill or a hook is a choice, so an
      // account that chose none has none rather than a directory somebody has to audit.
      should(await Bun.file(path.join(host.layout.homesDirectory, 'claude-shared', 'skills')).exists()).be.false();
      should(await Bun.file(path.join(host.layout.homesDirectory, 'codex-shared', 'hooks.json')).exists()).be.false();
    } finally {
      await rm(host.root, { recursive: true, force: true });
    }
  });

  it('should carry one edit to a shared document into every account, with no apply in between', async () => {
    // Arrange — two Claude accounts, both on the one document the starter registers as `claude`. This
    // is the whole claim: not that they hold equal copies, but that they hold the document.
    const host = await prepared();
    try {
      const config = FleetConfigSchema.parse({
        ...host.starter,
        agents: [
          account('claude', CLAUDE_ID),
          {
            name: 'second',
            kind: 'claude',
            routes: {
              default: {
                id: SECOND_CLAUDE_ID,
                wrapper: 'claude-second',
                home: 'claude-second',
                defaultModel: 'claude-test-model',
                models: ['claude-test-model'],
              },
            },
          },
        ],
      });
      await applied(host, config);
      const shared = path.join(host.layout.assetsDirectory, 'CLAUDE.md');
      const first = path.join(host.layout.homesDirectory, 'claude-shared', 'CLAUDE.md');
      const second = path.join(host.layout.homesDirectory, 'claude-second', 'CLAUDE.md');

      // Act — one edit, to the shared document, and nothing else. No second apply.
      await writeFile(shared, '# Edited once\n\nThis reached both accounts without an apply.\n', 'utf8');

      // Assert — both homes read the new text, because both entries ARE that file. Same device and
      // inode as the source, which is the assertion a copy that happens to be equal cannot pass.
      should(await readFile(first, 'utf8')).equal('# Edited once\n\nThis reached both accounts without an apply.\n');
      should(await readFile(second, 'utf8')).equal(await readFile(shared, 'utf8'));
      const source = await stat(shared);
      for (const home of [first, second]) {
        should((await lstat(home)).isSymbolicLink()).be.true();
        should(await realpath(home)).equal(await realpath(shared));
        const linked = await stat(home);
        should([linked.dev, linked.ino]).deepEqual([source.dev, source.ino]);
      }
    } finally {
      await rm(host.root, { recursive: true, force: true });
    }
  });

  it('should copy rather than link a shared document kept outside the asset tree', async () => {
    // Arrange — the same fleet, but the document lives in the operator's own home. A link there would
    // put a symlink escaping the state home under `fleet/homes`, which the state filesystem exists to
    // refuse, so this one is copied and the report says so.
    const host = await prepared();
    try {
      const outside = path.join(host.layout.userHome, 'dotfiles');
      await mkdir(outside, { recursive: true });
      await writeFile(path.join(outside, 'CLAUDE.md'), 'From my dotfiles.\n', 'utf8');
      const config = FleetConfigSchema.parse({
        ...host.starter,
        agents: [account('claude', CLAUDE_ID, { memory: '~/dotfiles/CLAUDE.md' })],
      });

      // Act
      await applied(host, config);
      const home = path.join(host.layout.homesDirectory, 'claude-shared', 'CLAUDE.md');

      // Assert — the bytes arrived, as a regular file rather than a link, and the report agrees with
      // the disk about which of the two happened.
      should(await readFile(home, 'utf8')).equal('From my dotfiles.\n');
      should((await lstat(home)).isSymbolicLink()).be.false();
      should(accountSharing(resolveFleetSharing(config), CLAUDE_ID)?.fields.memory).match({
        state: 'local',
        materialization: 'copy',
      });

      // And an edit to that source does NOT reach the account until the next apply, which is exactly
      // the difference the two mechanisms are named for.
      await writeFile(path.join(outside, 'CLAUDE.md'), 'Changed.\n', 'utf8');
      should(await readFile(home, 'utf8')).equal('From my dotfiles.\n');
    } finally {
      await rm(host.root, { recursive: true, force: true });
    }
  });

  it('should keep settings a generated merge of its layers rather than a link to any of them', async () => {
    // Arrange — the shipped Claude template as the base layer, plus one inline override.
    const host = await prepared();
    try {
      const config = FleetConfigSchema.parse({
        ...host.starter,
        agents: [account('claude', CLAUDE_ID, { settings: [{ includeCoAuthoredBy: true }] })],
      });

      // Act
      await applied(host, config);
      const settings = path.join(host.layout.homesDirectory, 'claude-shared', 'settings.json');

      // Assert — a real file, not a link, holding the MERGE: the template's `$schema` survives and the
      // account's own later layer wins on the key both of them set. A link could express neither.
      should((await lstat(settings)).isSymbolicLink()).be.false();
      const merged = JSON.parse(await readFile(settings, 'utf8')) as Record<string, unknown>;
      should(merged.$schema).equal('https://json.schemastore.org/claude-code-settings.json');
      should(merged.includeCoAuthoredBy).be.true();
    } finally {
      await rm(host.root, { recursive: true, force: true });
    }
  });
});
