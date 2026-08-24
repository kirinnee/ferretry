/**
 * Shared documents from the scaffold through a real apply, on a real filesystem.
 *
 * The unit tier proves what the report says. This proves the part only a filesystem can: that an
 * account which references a shared document ends up with that document's bytes in its home, and that
 * moving an account onto a shared document preserves the copy it was using rather than deleting it.
 *
 * Nothing here is a fixture configuration. The starting document is the one `fy fleet init` writes, so
 * a change that made the shipped scaffold's registry disagree with the files it writes fails here.
 */
import { describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
});
