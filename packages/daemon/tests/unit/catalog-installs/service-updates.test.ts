import { beforeAll, describe, it } from 'bun:test';
import type {
  CatalogInstallPreview,
  CatalogInstallPreviewRequest,
  CatalogInstallTarget,
  SharedCatalogItem,
} from '@ferretry/protocol';
import type { DaemonIdentity } from '@ferretry/relay';
import should from 'should';
import { CatalogInstallRefusalError } from '../../../src/lib/catalog-installs/ports.ts';
import { CatalogInstallStateError } from '../../../src/lib/catalog-installs/store.ts';
import {
  mcpItem,
  newIdentity,
  publish,
  signVersionList,
  skillItem,
  type VersionListOptions,
} from '../../support/catalog-fixtures.ts';
import { GOVERNANCE, projectTarget, request, rig, ROOT, runtimeTarget, STEP_UP, type Rig } from './service-support.ts';

let alice: DaemonIdentity;
let mallory: DaemonIdentity;
beforeAll(async () => {
  alice = await newIdentity();
  mallory = await newIdentity();
});

const refusal = async (work: Promise<unknown>): Promise<CatalogInstallRefusalError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof CatalogInstallRefusalError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

const skillV = (version: number, content = `# v${version}\n`, extra: { path: string; content: string }[] = []) =>
  skillItem(alice.daemonId, { itemVersion: version, files: [{ path: 'SKILL.md', content }, ...extra] });

const FOLDER = `${ROOT}/.claude/skills/pdf-tools`;

async function applyPreview(r: Rig, preview: CatalogInstallPreview, target: CatalogInstallTarget = projectTarget()) {
  return await r.service.apply(target.scope, { previewId: preview.previewId, secretBindings: {} }, GOVERNANCE, STEP_UP);
}

async function install(
  r: Rig,
  item: SharedCatalogItem,
  target = projectTarget(),
  revision = 1,
  bindings: Record<string, string | null> = item.kind === 'mcp' && item.mcp.transport === 'command'
    ? { ACME_TOKEN: null }
    : {},
) {
  const preview = await r.service.preview(target.scope, await request(alice, item, target, { revision }));
  const installed = await r.service.apply(
    target.scope,
    { previewId: preview.previewId, secretBindings: bindings },
    GOVERNANCE,
    STEP_UP,
  );
  return { preview, installed };
}

interface ViaList {
  /** The versions the list offers, oldest first. */
  readonly offered: readonly SharedCatalogItem[];
  /** The version the MANIFEST lists as current (defaults to the last offered). */
  readonly current?: SharedCatalogItem;
  /** The version being installed. */
  readonly chosen: SharedCatalogItem;
  readonly target?: CatalogInstallTarget;
  readonly revision?: number;
  readonly list?: VersionListOptions;
  readonly allowOlder?: true;
  readonly replaceEdited?: true;
}

/** A request for a version other than the manifest's current, carrying the publisher's signed list. */
async function viaList(options: ViaList): Promise<CatalogInstallPreviewRequest> {
  const current = options.current ?? options.offered[options.offered.length - 1];
  if (current === undefined) throw new Error('no versions');
  const published = await publish(alice, [current], { revision: options.revision ?? 1 });
  const signedVersions = await signVersionList(alice, published, options.offered, options.list ?? {});
  return {
    signedManifest: published.signedManifest,
    item: options.chosen,
    target: options.target ?? projectTarget(),
    signedVersions,
    ...(options.allowOlder === true ? { allowOlder: true as const } : {}),
    ...(options.replaceEdited === true ? { replaceEdited: true as const } : {}),
  };
}

describe('moving to any offered version: the signed list', () => {
  const v1 = () => skillV(1);
  const v2 = () => skillV(2);
  const v3 = () => skillV(3);

  it('should install a version the manifest does not list now, from the publisher’s signed list', async () => {
    const r = rig();
    const preview = await r.service.preview('project', await viaList({ offered: [v1(), v2(), v3()], chosen: v2() }));
    should(preview.provenance.version).equal(2);
    const installed = await applyPreview(r, preview);
    should(installed.install.provenance.version).equal(2);
    should(r.store.state.installs[0]?.provenance.version).equal(2);
    should(r.folders.folders.get(FOLDER)?.get('SKILL.md')).equal('# v2\n');
  });

  it('should record the offered digest of the version it moved to, not the manifest’s', async () => {
    const r = rig();
    const request2 = await viaList({ offered: [v1(), v2(), v3()], chosen: v2() });
    const offered = request2.signedVersions?.versions.offered.find(entry => entry.version === 2);
    const manifestLine = request2.signedManifest.manifest.items[0];
    const preview = await r.service.preview('project', request2);
    should(preview.provenance.digest).equal(offered?.digest);
    should(preview.provenance.digest).not.equal(manifestLine?.digest);
  });

  it('should refuse another version when no signed list comes with it', async () => {
    const r = rig();
    const bare = await request(alice, v3(), projectTarget());
    const error = await refusal(r.service.preview('project', { ...bare, item: v2() }));
    should(error.code).equal('catalog_item_mismatch');
    should(error.message).match(/signed list of versions/u);
  });

  it('should refuse a retired version: the list does not offer it', async () => {
    const r = rig();
    const error = await refusal(r.service.preview('project', await viaList({ offered: [v1(), v3()], chosen: v2() })));
    should(error.code).equal('catalog_item_mismatch');
  });

  it('should refuse a list signed by another machine than the one that signed the catalog', async () => {
    const r = rig();
    const asked = await viaList({ offered: [v1(), v2(), v3()], chosen: v2() });
    const published = await publish(mallory, [v3()]);
    const foreign = await signVersionList(mallory, published, [v1(), v2(), v3()]);
    const error = await refusal(r.service.preview('project', { ...asked, signedVersions: foreign }));
    should(error.code).equal('catalog_signature_invalid');
  });

  it('should refuse a list whose signature does not hold', async () => {
    const r = rig();
    const asked = await viaList({ offered: [v1(), v2(), v3()], chosen: v2() });
    const forged = structuredClone(asked);
    if (forged.signedVersions === undefined) throw new Error('no list');
    forged.signedVersions.versions.offered[0] = { ...forged.signedVersions.versions.offered[0]!, size: 99_999 };
    const error = await refusal(r.service.preview('project', forged));
    should(error.code).equal('catalog_signature_invalid');
  });

  it('should refuse a signed list swapped in from another catalog', async () => {
    const r = rig();
    const error = await refusal(
      r.service.preview(
        'project',
        await viaList({
          offered: [v1(), v2(), v3()],
          chosen: v2(),
          list: { catalogId: `cat_${'x'.repeat(22)}` },
        }),
      ),
    );
    should(error.code).equal('catalog_item_mismatch');
  });

  it('should refuse a signed list swapped in from another item', async () => {
    const r = rig();
    const otherItem = `itm_${'q'.repeat(22)}`;
    const error = await refusal(
      r.service.preview(
        'project',
        await viaList({
          offered: [v1(), v2(), v3()],
          chosen: v2(),
          list: { itemId: otherItem },
        }),
      ),
    );
    should(error.code).equal('catalog_item_mismatch');
  });

  it('should refuse a signed list swapped in from another revision of the catalog', async () => {
    const r = rig();
    const error = await refusal(
      r.service.preview(
        'project',
        await viaList({ offered: [v1(), v2(), v3()], chosen: v2(), revision: 2, list: { revision: 1 } }),
      ),
    );
    should(error.code).equal('catalog_item_mismatch');
  });

  it('should refuse a list that calls another version current than the manifest does', async () => {
    const r = rig();
    const error = await refusal(
      r.service.preview('project', await viaList({ offered: [v1(), v2(), v3()], chosen: v2(), list: { current: 2 } })),
    );
    should(error.code).equal('catalog_item_mismatch');
  });

  it('should refuse bytes that are not the version the list offers', async () => {
    const r = rig();
    const error = await refusal(
      r.service.preview(
        'project',
        await viaList({ offered: [v1(), v2(), v3()], chosen: skillV(2, '# not what was signed\n') }),
      ),
    );
    should(error.code).equal('catalog_item_mismatch');
  });

  it('should refuse a revision older than the last seen, even for a version chosen from the list', async () => {
    const r = rig();
    await install(r, skillV(3), projectTarget(), 5);
    const error = await refusal(
      r.service.preview(
        'project',
        await viaList({ offered: [v1(), v2(), v3()], chosen: v2(), revision: 4, allowOlder: true }),
      ),
    );
    should(error.code).equal('catalog_revision_older');
  });

  it('should keep the publisher pin for a version chosen from the list', async () => {
    const r = rig();
    await install(r, skillV(3));
    const published = await publish(mallory, [skillItem(mallory.daemonId, { itemVersion: 3 })]);
    const swapped = [1, 2, 3].map(version => skillItem(mallory.daemonId, { itemVersion: version }));
    const list = await signVersionList(mallory, published, swapped);
    const error = await refusal(
      r.service.preview('project', {
        signedManifest: published.signedManifest,
        item: swapped[1]!,
        target: projectTarget(),
        signedVersions: list,
        allowOlder: true,
      }),
    );
    should(error.code).equal('catalog_publisher_changed');
  });

  it('should need allowOlder to move below the installed version, and then warn', async () => {
    const r = rig();
    await install(r, skillV(3));
    const error = await refusal(
      r.service.preview('project', await viaList({ offered: [v1(), v2(), v3()], chosen: v2() })),
    );
    should(error.code).equal('catalog_downgrade');
    const chosen = await r.service.preview(
      'project',
      await viaList({ offered: [v1(), v2(), v3()], chosen: v2(), allowOlder: true }),
    );
    should(chosen.warnings[0]?.code).equal('older-version');
    should(chosen.replaces?.version).equal(3);
    const installed = await applyPreview(r, chosen);
    should(installed.install.provenance.version).equal(2);
    should(r.store.state.installs).have.length(1);
  });

  it('should move up to a version that is not the newest without allowOlder', async () => {
    const r = rig();
    await install(r, skillV(1));
    const preview = await r.service.preview('project', await viaList({ offered: [v1(), v2(), v3()], chosen: v2() }));
    should(preview.warnings.map(warning => warning.code)).not.containEql('older-version');
    should(preview.replaces?.version).equal(1);
  });
});

describe('see changes: the installing machine’s own bytes', () => {
  it('should show a changed skill file against what is on disk, not against the recorded version', async () => {
    const r = rig();
    await install(r, skillV(1, '# one\nsame\n'));
    const preview = await r.service.preview(
      'project',
      await request(alice, skillV(2, '# two\nsame\n'), projectTarget()),
    );
    const entry = preview.changes?.entries.find(candidate => candidate.label === 'Skill file SKILL.md');
    should(entry?.change).equal('changed');
    should(JSON.stringify(entry?.hunks)).match(/# one/u);
    should(JSON.stringify(entry?.hunks)).match(/# two/u);
  });

  it('should show nothing for a fresh install: there is nothing to compare', async () => {
    const r = rig();
    const preview = await r.service.preview('project', await request(alice, skillV(1), projectTarget()));
    should(preview.changes).be.undefined();
  });

  it('should show added and removed skill files', async () => {
    const r = rig();
    await install(r, skillV(1, '# one\n', [{ path: 'old.md', content: 'old' }]));
    const preview = await r.service.preview(
      'project',
      await request(alice, skillV(2, '# one\n', [{ path: 'new.md', content: 'new' }]), projectTarget()),
    );
    const labels = Object.fromEntries((preview.changes?.entries ?? []).map(entry => [entry.label, entry.change]));
    should(labels['Skill file new.md']).equal('added');
    should(labels['Skill file old.md']).equal('removed');
  });

  it('should mark a file too large to read as too large, never read whole', async () => {
    const r = rig();
    await install(r, skillV(1, '# one\n', [{ path: 'big.md', content: 'x' }]));
    r.folders.tooLarge.add('big.md');
    const preview = await r.service.preview(
      'project',
      await request(alice, skillV(2, '# one\n', [{ path: 'big.md', content: 'y' }]), projectTarget()),
    );
    const entry = preview.changes?.entries.find(candidate => candidate.label === 'Skill file big.md');
    should(entry).match({ change: 'changed', tooLarge: true });
  });

  it('should mark an unreadable file the offered version drops as removed and too large', async () => {
    const r = rig();
    await install(r, skillV(1, '# one\n', [{ path: 'big.md', content: 'x' }]));
    r.folders.tooLarge.add('big.md');
    const preview = await r.service.preview('project', await request(alice, skillV(2, '# one\n'), projectTarget()));
    const entry = preview.changes?.entries.find(candidate => candidate.label === 'Skill file big.md');
    should(entry).match({ change: 'removed', tooLarge: true });
  });

  it('should leave changes out when the installed copy cannot be rebuilt, and still show the review', async () => {
    const r = rig();
    await install(r, skillV(1));
    r.folders.failReadFiles = new Error('disk gone');
    const preview = await r.service.preview('project', await request(alice, skillV(2), projectTarget()));
    should(preview.changes).be.undefined();
    should(preview.review.length).be.above(0);
  });

  it('should bound the diff: two wholly different big files come back marked, not computed forever', async () => {
    const r = rig();
    const lines = (prefix: string) => Array.from({ length: 6000 }, (_, index) => `${prefix}${index}`).join('\n');
    await install(r, skillV(1, lines('a')));
    const started = Date.now();
    const preview = await r.service.preview('project', await request(alice, skillV(2, lines('b')), projectTarget()));
    should(Date.now() - started).be.below(20_000);
    should(preview.changes?.entries.find(entry => entry.label === 'Skill file SKILL.md')?.tooLarge).equal(true);
    should(preview.changes?.truncated).equal(true);
  });

  it('should show a project server against its .mcp.json entry, with bound values put back as placeholders', async () => {
    const r = rig();
    await install(r, skillV(1)); // an unrelated install first
    const first = await r.service.preview('project', await request(alice, mcpItem(alice.daemonId), projectTarget()));
    await r.service.apply(
      'project',
      { previewId: first.previewId, secretBindings: { ACME_TOKEN: 'ACME_TOKEN_OWN' } },
      GOVERNANCE,
      STEP_UP,
    );
    const v2 = mcpItem(alice.daemonId, {
      itemVersion: 2,
      mcp: {
        transport: 'command',
        command: 'acme-mcp',
        args: ['--stdio', '--verbose'],
        env: { ACME_TOKEN: '${secret:ACME_TOKEN}' },
      },
    });
    const preview = await r.service.preview('project', await request(alice, v2, projectTarget()));
    const labels = (preview.changes?.entries ?? []).map(entry => entry.label);
    should(preview.changes?.entries.length).be.above(0);
    should(labels.join(' ')).match(/Starts/u);
    should(labels.join(' ')).not.match(/Environment/u);
  });

  it('should show a runtime server against its stored component', async () => {
    const r = rig();
    const first = await r.service.preview('runtime', await request(alice, mcpItem(alice.daemonId), runtimeTarget()));
    await r.service.apply(
      'runtime',
      { previewId: first.previewId, secretBindings: { ACME_TOKEN: 'ACME_TOKEN_OWN' } },
      GOVERNANCE,
      STEP_UP,
    );
    const v2 = mcpItem(alice.daemonId, {
      itemVersion: 2,
      mcp: {
        transport: 'command',
        command: 'acme-mcp',
        args: ['--other'],
        env: { ACME_TOKEN: '${secret:ACME_TOKEN}' },
      },
    });
    const preview = await r.service.preview('runtime', await request(alice, v2, runtimeTarget()));
    should((preview.changes?.entries ?? []).map(entry => entry.label).join(' ')).match(/Starts/u);
  });

  it('should leave changes out for a server whose entry is no longer a shape an install writes', async () => {
    const r = rig();
    await install(r, mcpItem(alice.daemonId), projectTarget());
    const written = JSON.parse(r.mcp.text ?? '{}') as { mcpServers: Record<string, unknown> };
    const current = written.mcpServers['acme-mcp'] as Record<string, unknown>;
    // The hash will differ; the entry is still a server, but not one with a command or an address.
    written.mcpServers['acme-mcp'] = { ...current, command: 7 };
    r.mcp.text = JSON.stringify(written);
    const preview = await r.service.preview(
      'project',
      await request(alice, mcpItem(alice.daemonId, { itemVersion: 2 }), projectTarget(), {
        replaceEdited: true,
      }),
    );
    should(preview.changes).be.undefined();
    should(preview.edited?.entry).equal('acme-mcp');
  });

  it('should leave changes out when the install’s server was taken out of .mcp.json', async () => {
    const r = rig();
    await install(r, mcpItem(alice.daemonId), projectTarget());
    r.mcp.text = JSON.stringify({ mcpServers: {} });
    const preview = await r.service.preview(
      'project',
      await request(alice, mcpItem(alice.daemonId, { itemVersion: 2 }), projectTarget()),
    );
    should(preview.changes).be.undefined();
  });

  it('should show the changes of a server reached by address', async () => {
    const r = rig();
    const url = (version: number, address: string) =>
      mcpItem(alice.daemonId, { itemVersion: version, mcp: { transport: 'url', url: address } });
    await install(r, url(1, 'https://mcp.example.com/one'), projectTarget());
    const preview = await r.service.preview(
      'project',
      await request(alice, url(2, 'https://mcp.example.com/two'), projectTarget()),
    );
    should(preview.changes?.entries.length).be.above(0);
  });
});

describe('local edits: keep or replace', () => {
  it('should refuse a file edited here, naming it, and change nothing', async () => {
    const r = rig();
    await install(r, skillV(1));
    r.folders.folders.get(FOLDER)?.set('SKILL.md', 'mine');
    const error = await refusal(r.service.preview('project', await request(alice, skillV(2), projectTarget())));
    should(error.code).equal('catalog_install_edited');
    should(error.message).match(/skills\/pdf-tools\/SKILL\.md|\.claude\/skills\/pdf-tools\/SKILL\.md/u);
    should(r.folders.folders.get(FOLDER)?.get('SKILL.md')).equal('mine');
  });

  it('should list what was edited, with a warning, when the person chose to replace', async () => {
    const r = rig();
    await install(r, skillV(1));
    r.folders.folders.get(FOLDER)?.set('SKILL.md', 'mine');
    const preview = await r.service.preview(
      'project',
      await request(alice, skillV(2), projectTarget(), { replaceEdited: true }),
    );
    should(preview.edited?.paths).have.length(1);
    should(preview.edited?.paths[0]).match(/SKILL\.md$/u);
    should(preview.warnings.map(warning => warning.code)).containEql('edited-locally');
    should(preview.changes?.entries.find(entry => entry.label === 'Skill file SKILL.md')?.change).equal('changed');
  });

  it('should replace the edited file on apply, and record the new one', async () => {
    const r = rig();
    await install(r, skillV(1));
    r.folders.folders.get(FOLDER)?.set('SKILL.md', 'mine');
    const preview = await r.service.preview(
      'project',
      await request(alice, skillV(2), projectTarget(), { replaceEdited: true }),
    );
    const installed = await applyPreview(r, preview);
    should(r.folders.folders.get(FOLDER)?.get('SKILL.md')).equal('# v2\n');
    should(installed.install.provenance.version).equal(2);
    should(r.store.state.installs).have.length(1);
  });

  it('should refuse a file edited AGAIN after the review, and leave it as it is', async () => {
    const r = rig();
    await install(r, skillV(1));
    r.folders.folders.get(FOLDER)?.set('SKILL.md', 'mine');
    const preview = await r.service.preview(
      'project',
      await request(alice, skillV(2), projectTarget(), { replaceEdited: true }),
    );
    r.folders.folders.get(FOLDER)?.set('SKILL.md', 'mine, and then some');
    const error = await refusal(applyPreview(r, preview));
    should(error.code).equal('catalog_install_edited');
    should(error.message).match(/after the changes were reviewed/u);
    should(r.folders.folders.get(FOLDER)?.get('SKILL.md')).equal('mine, and then some');
    should(r.store.state.installs[0]?.provenance.version).equal(1);
  });

  it('should refuse a file edited after a review that saw no edits', async () => {
    const r = rig();
    await install(r, skillV(1));
    const preview = await r.service.preview('project', await request(alice, skillV(2), projectTarget()));
    should(preview.edited).be.undefined();
    r.folders.folders.get(FOLDER)?.set('SKILL.md', 'edited meanwhile');
    const error = await refusal(applyPreview(r, preview));
    should(error.code).equal('catalog_install_edited');
    should(r.folders.folders.get(FOLDER)?.get('SKILL.md')).equal('edited meanwhile');
  });

  it('should guard the write itself: a file that moves between the check and the write refuses', async () => {
    const r = rig();
    await install(r, skillV(1));
    r.folders.folders.get(FOLDER)?.set('SKILL.md', 'mine');
    const preview = await r.service.preview(
      'project',
      await request(alice, skillV(2), projectTarget(), { replaceEdited: true }),
    );
    r.folders.racing = true;
    const error = await refusal(applyPreview(r, preview));
    should(error.code).equal('catalog_install_conflict');
    should(r.folders.folders.get(FOLDER)?.get('SKILL.md')).equal('mine');
  });

  it('should never touch a file no install of ours wrote, even when asked to replace edits', async () => {
    const r = rig();
    await install(r, skillV(1));
    r.folders.folders.get(FOLDER)?.set('mine.md', 'mine');
    r.folders.folders.get(FOLDER)?.set('SKILL.md', 'edited too');
    const error = await refusal(
      r.service.preview('project', await request(alice, skillV(2), projectTarget(), { replaceEdited: true })),
    );
    should(error.code).equal('catalog_install_conflict');
    should(r.folders.folders.get(FOLDER)?.get('mine.md')).equal('mine');
    should(r.folders.folders.get(FOLDER)?.get('SKILL.md')).equal('edited too');
  });

  it('should never touch a file that appeared after the review', async () => {
    const r = rig();
    await install(r, skillV(1));
    r.folders.folders.get(FOLDER)?.set('SKILL.md', 'mine');
    const preview = await r.service.preview(
      'project',
      await request(alice, skillV(2), projectTarget(), { replaceEdited: true }),
    );
    r.folders.folders.get(FOLDER)?.set('mine.md', 'arrived');
    const error = await refusal(applyPreview(r, preview));
    should(error.code).equal('catalog_install_conflict');
    should(r.folders.folders.get(FOLDER)?.get('mine.md')).equal('arrived');
    should(r.folders.folders.get(FOLDER)?.get('SKILL.md')).equal('mine');
  });

  it('should answer a replace request with no edits like a plain one', async () => {
    const r = rig();
    await install(r, skillV(1));
    const preview = await r.service.preview(
      'project',
      await request(alice, skillV(2), projectTarget(), { replaceEdited: true }),
    );
    should(preview.edited).be.undefined();
    should(preview.warnings.map(warning => warning.code)).not.containEql('edited-locally');
    await applyPreview(r, preview);
  });

  it('should refuse an edited project server, and replace it when asked', async () => {
    const r = rig();
    await install(r, mcpItem(alice.daemonId), projectTarget());
    r.mcp.text = (r.mcp.text ?? '').replace('--stdio', '--mine');
    const v2 = mcpItem(alice.daemonId, { itemVersion: 2 });
    const refused = await refusal(r.service.preview('project', await request(alice, v2, projectTarget())));
    should(refused.code).equal('catalog_install_edited');
    should(refused.message).match(/server acme-mcp in \.mcp\.json/u);
    const preview = await r.service.preview(
      'project',
      await request(alice, v2, projectTarget(), { replaceEdited: true }),
    );
    should(preview.edited).eql({ paths: [], entry: 'acme-mcp' });
    await r.service.apply(
      'project',
      { previewId: preview.previewId, secretBindings: { ACME_TOKEN: null } },
      GOVERNANCE,
      STEP_UP,
    );
    should(r.mcp.text).match(/--stdio/u);
    should(r.mcp.text).not.match(/--mine/u);
  });

  it('should refuse a project server edited again after the review', async () => {
    const r = rig();
    await install(r, mcpItem(alice.daemonId), projectTarget());
    r.mcp.text = (r.mcp.text ?? '').replace('--stdio', '--mine');
    const preview = await r.service.preview(
      'project',
      await request(alice, mcpItem(alice.daemonId, { itemVersion: 2 }), projectTarget(), { replaceEdited: true }),
    );
    r.mcp.text = (r.mcp.text ?? '').replace('--mine', '--mine-again');
    const error = await refusal(
      r.service.apply(
        'project',
        { previewId: preview.previewId, secretBindings: { ACME_TOKEN: null } },
        GOVERNANCE,
        STEP_UP,
      ),
    );
    should(error.code).equal('catalog_install_edited');
    should(r.mcp.text).match(/--mine-again/u);
  });

  it('should refuse an edited stored component, and replace it when asked', async () => {
    const r = rig();
    await install(r, mcpItem(alice.daemonId), runtimeTarget());
    const current = r.fleet.components.get('mcp')?.[0];
    r.fleet.components.set('mcp', [
      { ...current, name: 'acme-mcp', detail: { ...(current?.detail as object), edited: 1 } },
    ]);
    const v2 = mcpItem(alice.daemonId, { itemVersion: 2 });
    const refused = await refusal(r.service.preview('runtime', await request(alice, v2, runtimeTarget())));
    should(refused.code).equal('catalog_install_edited');
    const preview = await r.service.preview(
      'runtime',
      await request(alice, v2, runtimeTarget(), { replaceEdited: true }),
    );
    should(preview.edited?.component).equal(true);
    const installed = await r.service.apply(
      'runtime',
      { previewId: preview.previewId, secretBindings: { ACME_TOKEN: null } },
      GOVERNANCE,
      STEP_UP,
    );
    should(installed.install.provenance.version).equal(2);
  });

  it('should refuse a stored component edited again after the review', async () => {
    const r = rig();
    await install(r, mcpItem(alice.daemonId), runtimeTarget());
    const edit = (n: number) => {
      const current = r.fleet.components.get('mcp')?.[0];
      r.fleet.components.set('mcp', [
        { ...current, name: 'acme-mcp', detail: { ...(current?.detail as object), edited: n } },
      ]);
    };
    edit(1);
    const preview = await r.service.preview(
      'runtime',
      await request(alice, mcpItem(alice.daemonId, { itemVersion: 2 }), runtimeTarget(), { replaceEdited: true }),
    );
    edit(2);
    const error = await refusal(
      r.service.apply(
        'runtime',
        { previewId: preview.previewId, secretBindings: { ACME_TOKEN: null } },
        GOVERNANCE,
        STEP_UP,
      ),
    );
    should(error.code).equal('catalog_install_edited');
  });

  it('should refuse an edited runtime skill and replace it when asked', async () => {
    const r = rig();
    await install(r, skillV(1), runtimeTarget());
    r.folders.folders.get('runtime/pdf-tools')?.set('SKILL.md', 'mine');
    const refused = await refusal(r.service.preview('runtime', await request(alice, skillV(2), runtimeTarget())));
    should(refused.code).equal('catalog_install_edited');
    const preview = await r.service.preview(
      'runtime',
      await request(alice, skillV(2), runtimeTarget(), { replaceEdited: true }),
    );
    should(preview.edited?.paths[0]).match(/SKILL\.md$/u);
    await applyPreview(r, preview, runtimeTarget());
    should(r.folders.folders.get('runtime/pdf-tools')?.get('SKILL.md')).equal('# v2\n');
  });

  it('should leave a removal of an edited install refused, as it always was', async () => {
    const r = rig();
    const { installed } = await install(r, skillV(1));
    r.folders.folders.get(FOLDER)?.set('SKILL.md', 'mine');
    const error = await refusal(r.service.remove('project', installed.install.installId, GOVERNANCE, STEP_UP));
    should(error.code).equal('catalog_install_conflict');
  });
});

describe('stay and skip', () => {
  it('should hold an install and show it in the list', async () => {
    const r = rig();
    const { installed } = await install(r, skillV(1));
    const answer = await r.service.setPrefs('project', installed.install.installId, { hold: true });
    should(answer.hold).equal(true);
    const listed = await r.service.list();
    should(listed.installs[0]?.hold).equal(true);
    should(listed.installs[0]?.skippedVersion).be.undefined();
  });

  it('should skip a version and keep the hold when only the skip changes', async () => {
    const r = rig();
    const { installed } = await install(r, skillV(1));
    const id = installed.install.installId;
    await r.service.setPrefs('project', id, { hold: true });
    const answer = await r.service.setPrefs('project', id, { skippedVersion: 4 });
    should(answer).match({ hold: true, skippedVersion: 4 });
  });

  it('should clear a hold with false and a skip with null, leaving the other alone', async () => {
    const r = rig();
    const { installed } = await install(r, skillV(1));
    const id = installed.install.installId;
    await r.service.setPrefs('project', id, { hold: true, skippedVersion: 4 });
    const noHold = await r.service.setPrefs('project', id, { hold: false });
    should(noHold.hold).be.undefined();
    should(noHold.skippedVersion).equal(4);
    const none = await r.service.setPrefs('project', id, { skippedVersion: null });
    should(none.skippedVersion).be.undefined();
    should(r.prefs.state.installs).eql({});
  });

  it('should refuse an install that is not there, or is of the other scope', async () => {
    const r = rig();
    const { installed } = await install(r, skillV(1));
    const missing = await refusal(r.service.setPrefs('project', `cin_${'z'.repeat(22)}`, { hold: true }));
    should(missing.code).equal('catalog_install_unknown');
    const wrong = await refusal(r.service.setPrefs('runtime', installed.install.installId, { hold: true }));
    should(wrong.code).equal('catalog_install_unknown');
    should(r.prefs.state.installs).eql({});
  });

  it('should write no installed file and change no install record', async () => {
    const r = rig();
    const { installed } = await install(r, skillV(1));
    const before = structuredClone(r.store.state);
    const folder = structuredClone([...(r.folders.folders.get(FOLDER) ?? [])]);
    await r.service.setPrefs('project', installed.install.installId, { hold: true, skippedVersion: 2 });
    should(r.store.state).eql(before);
    should([...(r.folders.folders.get(FOLDER) ?? [])]).eql(folder);
  });

  it('should drop the choice when the install is replaced by another version', async () => {
    const r = rig();
    const { installed } = await install(r, skillV(1));
    await r.service.setPrefs('project', installed.install.installId, { hold: true, skippedVersion: 2 });
    const { installed: next } = await install(r, skillV(3));
    should(r.prefs.state.installs).eql({});
    should(next.install.hold).be.undefined();
    const listed = await r.service.list();
    should(listed.installs[0]?.hold).be.undefined();
    should(listed.installs[0]?.skippedVersion).be.undefined();
  });

  it('should drop the choice when the install is removed', async () => {
    const r = rig();
    const { installed } = await install(r, skillV(1));
    await r.service.setPrefs('project', installed.install.installId, { hold: true });
    await r.service.remove('project', installed.install.installId, GOVERNANCE, STEP_UP);
    should(r.prefs.state.installs).eql({});
  });

  it('should keep another install’s choice when one is replaced', async () => {
    const r = rig();
    const { installed: one } = await install(r, skillV(1));
    const { installed: other } = await install(r, mcpItem(alice.daemonId), projectTarget());
    await r.service.setPrefs('project', one.install.installId, { hold: true });
    await r.service.setPrefs('project', other.install.installId, { skippedVersion: 5 });
    await install(r, skillV(2));
    should(Object.keys(r.prefs.state.installs)).eql([other.install.installId]);
  });

  it('should not undo an install because the preferences file could not be written', async () => {
    const r = rig();
    const { installed } = await install(r, skillV(1));
    await r.service.setPrefs('project', installed.install.installId, { hold: true });
    r.prefs.failWrite = new CatalogInstallStateError('catalog-install-prefs.json is damaged');
    const { installed: next } = await install(r, skillV(2));
    should(next.install.provenance.version).equal(2);
    should(r.store.state.installs).have.length(1);
  });

  it('should report a preferences file it cannot write, rather than pretend', async () => {
    const r = rig();
    const { installed } = await install(r, skillV(1));
    r.prefs.failWrite = new CatalogInstallStateError('catalog-install-prefs.json is damaged');
    await r.service.setPrefs('project', installed.install.installId, { hold: true }).then(
      () => should.fail(undefined, undefined, 'expected a failure'),
      (error: Error) => should(error).be.instanceOf(CatalogInstallStateError),
    );
  });

  it('should never act on a choice by itself: a held install can still be replaced by the person', async () => {
    const r = rig();
    const { installed } = await install(r, skillV(1));
    await r.service.setPrefs('project', installed.install.installId, { hold: true, skippedVersion: 2 });
    const preview = await r.service.preview('project', await request(alice, skillV(2), projectTarget()));
    should(preview.replaces?.version).equal(1);
  });
});
