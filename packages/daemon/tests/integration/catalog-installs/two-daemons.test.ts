import { afterEach, beforeAll, describe, it } from 'bun:test';
import { lstat, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogInstallPreviewRequest } from '@ferretry/protocol';
import type { DaemonIdentity } from '@ferretry/relay';
import should from 'should';
import { FileCatalogInstallStore } from '../../../src/adapters/catalog-installs/file-store.ts';
import { FileProjectSkillFiles } from '../../../src/adapters/catalog-installs/project-skill-files.ts';
import { FileRuntimeSkillAssets } from '../../../src/adapters/catalog-installs/runtime-skill-assets.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { FileMcpProjectFiles } from '../../../src/adapters/session-mcp/project-files.ts';
import { CatalogInstallRefusalError } from '../../../src/lib/catalog-installs/ports.ts';
import { CatalogInstallService } from '../../../src/lib/catalog-installs/service.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import { crypto, mcpItem, newIdentity, publish, skillItem } from '../../support/catalog-fixtures.ts';
import {
  AsCaller,
  CALLER,
  FakeFleet,
  FakeFolders,
  GOVERNANCE,
  STEP_UP,
} from '../../unit/catalog-installs/service-support.ts';

/**
 * Two machines that share nothing but a file. Machine A signs a catalog and its file is carried over as
 * TEXT; machine B is the real service over a real state home and a real project folder. B takes nothing on
 * A's word: it verifies the signature, pins A's fingerprint, writes only through the real adapters, and
 * refuses a file that was edited in transit.
 *
 * TODO(lead): when phase 1a's `fy catalog export` is merged, build `carried` from the real export instead
 * of `signCatalogManifest` through `publish`; the file format is the same.
 */

const dirs = new Set<string>();
let machineA: DaemonIdentity;

beforeAll(async () => {
  machineA = await newIdentity();
});

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs.clear();
});

async function machineB() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-two-daemons-'));
  dirs.add(home);
  const project = join(home, 'project');
  await Bun.write(join(project, '.keep'), '');
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const folders = new FakeFolders();
  let minted = 0;
  const inner = new CatalogInstallService({
    crypto,
    store: new FileCatalogInstallStore(paths, new StateFileSystem(paths)),
    projectRoots: async () => [project],
    mcpFiles: new FileMcpProjectFiles(),
    skillFiles: new FileProjectSkillFiles(),
    runtimeSkills: new FileRuntimeSkillAssets(join(home, 'runtime-skills')),
    fleet: new FakeFleet(folders).api,
    secretNames: async () => new Set(['MY_ACME_KEY']),
    now: () => Date.now(),
    mint: prefix => {
      minted += 1;
      return `${prefix}_${String(minted).padStart(22, 'b')}`;
    },
  });
  return { home, project, paths, service: new AsCaller(inner, CALLER) };
}

/** What crosses between the machines: text, and nothing else. */
async function carried(
  items: Parameters<typeof publish>[1],
): Promise<{ signedManifest: CatalogInstallPreviewRequest['signedManifest']; items: typeof items }> {
  const published = await publish(machineA, items, {});
  return JSON.parse(JSON.stringify({ signedManifest: published.signedManifest, items: published.items })) as never;
}

const refusal = async (work: Promise<unknown>): Promise<CatalogInstallRefusalError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof CatalogInstallRefusalError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('install on machine B from a file machine A signed', () => {
  it('should install a skill and an MCP server into a real project, and record where from', async () => {
    const b = await machineB();
    const skill = skillItem(machineA.daemonId);
    const server = mcpItem(machineA.daemonId);
    const file = await carried([skill, server]);
    const target = { scope: 'project' as const, projectRoot: b.project, harness: 'claude' as const };

    const skillPreview = await b.service.preview('project', {
      signedManifest: file.signedManifest,
      item: file.items[0]!,
      target,
    });
    should(skillPreview.publisher.firstSeen).be.true();
    await b.service.apply('project', { previewId: skillPreview.previewId, secretBindings: {} }, GOVERNANCE, STEP_UP);

    const serverPreview = await b.service.preview('project', {
      signedManifest: file.signedManifest,
      item: file.items[1]!,
      target,
    });
    should(serverPreview.publisher.firstSeen).be.false();
    await b.service.apply(
      'project',
      { previewId: serverPreview.previewId, secretBindings: { ACME_TOKEN: 'MY_ACME_KEY' } },
      GOVERNANCE,
      STEP_UP,
    );

    should(await readFile(join(b.project, '.claude/skills/pdf-tools/SKILL.md'), 'utf8')).equal('# pdf tools\n');
    const mcp = JSON.parse(await readFile(join(b.project, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { env: Record<string, string> }>;
    };
    should(mcp.mcpServers['acme-mcp']?.env.ACME_TOKEN).equal('${MY_ACME_KEY}');

    const record = join(b.paths.state, 'catalog-installs.json');
    should((await stat(record)).mode & 0o777).equal(0o600);
    const installs = (await b.service.list()).installs;
    should(installs.map(install => install.provenance.name).toSorted()).eql(['acme-mcp', 'pdf-tools']);
    should(installs.every(install => install.provenance.publisher === machineA.daemonId)).be.true();
  });

  it('should remove exactly what it wrote, and nothing more', async () => {
    const b = await machineB();
    const file = await carried([skillItem(machineA.daemonId)]);
    const target = { scope: 'project' as const, projectRoot: b.project, harness: 'claude' as const };
    const preview = await b.service.preview('project', {
      signedManifest: file.signedManifest,
      item: file.items[0]!,
      target,
    });
    const { install } = await b.service.apply(
      'project',
      { previewId: preview.previewId, secretBindings: {} },
      GOVERNANCE,
      STEP_UP,
    );
    await b.service.remove('project', install.installId, GOVERNANCE, STEP_UP);
    await lstat(join(b.project, '.keep'));
    await lstat(join(b.project, '.claude/skills/pdf-tools/SKILL.md')).then(
      () => should.fail(undefined, undefined, 'the file should be gone'),
      (error: NodeJS.ErrnoException) => should(error.code).equal('ENOENT'),
    );
    should((await b.service.list()).installs).eql([]);
  });

  it('should refuse a file edited in transit, one byte, with the signature sentence, and write nothing', async () => {
    const b = await machineB();
    const file = await carried([skillItem(machineA.daemonId)]);
    const target = { scope: 'project' as const, projectRoot: b.project, harness: 'claude' as const };

    const text = JSON.stringify(file);
    const flipped = text.replace('"revision":1', '"revision":2');
    should(flipped).not.equal(text);
    const manifestEdited = JSON.parse(flipped) as typeof file;
    const signature = await refusal(
      b.service.preview('project', {
        signedManifest: manifestEdited.signedManifest,
        item: manifestEdited.items[0]!,
        target,
      }),
    );
    should(signature.code).equal('catalog_signature_invalid');

    const contentEdited = JSON.parse(text.replace('# pdf tools', '# pdf t00ls')) as typeof file;
    const mismatch = await refusal(
      b.service.preview('project', {
        signedManifest: contentEdited.signedManifest,
        item: contentEdited.items[0]!,
        target,
      }),
    );
    should(mismatch.code).equal('catalog_item_mismatch');

    await lstat(join(b.project, '.claude')).then(
      () => should.fail(undefined, undefined, 'nothing should have been written'),
      (error: NodeJS.ErrnoException) => should(error.code).equal('ENOENT'),
    );
  });

  it('should refuse a second machine publishing under the catalog id machine A already installed from', async () => {
    const b = await machineB();
    const target = { scope: 'project' as const, projectRoot: b.project, harness: 'claude' as const };
    const first = await carried([skillItem(machineA.daemonId)]);
    const preview = await b.service.preview('project', {
      signedManifest: first.signedManifest,
      item: first.items[0]!,
      target,
    });
    await b.service.apply('project', { previewId: preview.previewId, secretBindings: {} }, GOVERNANCE, STEP_UP);

    const impostor = await newIdentity();
    const forged = await publish(impostor, [mcpItem(impostor.daemonId)], {});
    const error = await refusal(
      b.service.preview('project', { signedManifest: forged.signedManifest, item: forged.items[0]!, target }),
    );
    should(error.code).equal('catalog_publisher_changed');
  });
});
