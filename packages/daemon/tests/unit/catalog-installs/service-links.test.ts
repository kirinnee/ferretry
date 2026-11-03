import { beforeAll, describe, it } from 'bun:test';
import { LINK_ITEM_CATALOG_ID, type CatalogInstallPreview } from '@ferretry/protocol';
import type { DaemonIdentity } from '@ferretry/relay';
import should from 'should';
import { CatalogInstallRefusalError } from '../../../src/lib/catalog-installs/ports.ts';
import { linkSequenceKey } from '../../../src/lib/catalog-installs/store.ts';
import {
  LINK_ID,
  LINK_NOT_AFTER,
  linkPreviewRequest,
  linkSkillItem,
  newIdentity,
  skillItem,
} from '../../support/catalog-fixtures.ts';
import { GOVERNANCE, projectTarget, request, rig, runtimeTarget, STEP_UP, type Rig } from './service-support.ts';

const WEEK = 7 * 24 * 60 * 60 * 1000;

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

async function installLink(r: Rig, options: Parameters<typeof linkPreviewRequest>[2] = {}, target = projectTarget()) {
  const preview = await r.service.preview(target.scope, await linkPreviewRequest(alice, target, options));
  const installed = await r.service.apply(
    target.scope,
    { previewId: preview.previewId, secretBindings: {} },
    GOVERNANCE,
    STEP_UP,
  );
  return { preview, installed };
}

describe('catalog install from a link: preview', () => {
  it('should review a link’s item the way it reviews a file’s, and write nothing', async () => {
    const r = rig();
    const preview: CatalogInstallPreview = await r.service.preview(
      'project',
      await linkPreviewRequest(alice, projectTarget()),
    );
    should(preview.provenance.name).equal('pdf-tools');
    should(preview.replaces).be.undefined();
    should(r.store.writes).equal(0);
    should(r.store.state.installs).eql([]);
    should(r.folders.folders.size).equal(0);
  });

  it('should say a link only ever carries this one item when it is the first thing from its publisher', async () => {
    const r = rig();
    const preview = await r.service.preview('project', await linkPreviewRequest(alice, projectTarget()));
    const first = preview.warnings.find(warning => warning.code === 'first-publisher');
    should(first?.text).match(/came from a link, which only ever carries this one item and never updates it/u);
    should(first?.text).not.match(/can only come from this same machine/u);
  });

  it('should refuse a link whose signature does not verify', async () => {
    const r = rig();
    const asked = await linkPreviewRequest(alice, projectTarget());
    const forged = structuredClone(asked);
    forged.signedLink.link.publisherName = 'Somebody else';
    const error = await refusal(r.service.preview('project', forged));
    should(error.code).equal('catalog_signature_invalid');
  });

  it('should refuse a link by a different key than the fingerprint its address named', async () => {
    const r = rig();
    const error = await refusal(
      r.service.preview(
        'project',
        await linkPreviewRequest(alice, projectTarget(), { linkFingerprint: mallory.daemonId }),
      ),
    );
    should(error.code).equal('catalog_link_mismatch');
  });

  it('should refuse an item that is not the one the link signed', async () => {
    const r = rig();
    const asked = await linkPreviewRequest(alice, projectTarget());
    const swapped = { ...asked, item: linkSkillItem(alice.daemonId, { content: '# something else\n' }) };
    const error = await refusal(r.service.preview('project', swapped));
    should(error.code).equal('catalog_item_mismatch');
  });

  it('should refuse a link only once it is more than a week past its end', async () => {
    const r = rig();
    const asked = await linkPreviewRequest(alice, projectTarget());
    r.clock.now = Date.parse(LINK_NOT_AFTER) + WEEK;
    await r.service.preview('project', asked);
    r.clock.now += 1;
    const error = await refusal(r.service.preview('project', asked));
    should(error.code).equal('catalog_link_expired');
    should(error.message).match(/ended on 2026-11-07/u);
    should(error.message).match(/Ask the person who sent it for a new one/u);
  });

  it('should refuse a catalog whose manifest names the placeholder only links carry', async () => {
    const r = rig();
    const item = skillItem(alice.daemonId, { catalogId: LINK_ITEM_CATALOG_ID });
    const error = await refusal(
      r.service.preview('project', await request(alice, item, projectTarget(), { catalogId: LINK_ITEM_CATALOG_ID })),
    );
    should(error.code).equal('catalog_item_invalid');
  });

  it('should hold a link to the target scope like any other install', async () => {
    const r = rig();
    const error = await refusal(r.service.preview('runtime', await linkPreviewRequest(alice, projectTarget())));
    should(error.code).equal('catalog_target_unknown');
  });
});

describe('catalog install from a link: the sequence pin', () => {
  it('should refuse an older copy of a link it has installed from, and take the same or a newer one', async () => {
    const r = rig();
    await installLink(r, { sequence: 3 });
    const older = await refusal(
      r.service.preview('project', await linkPreviewRequest(alice, projectTarget(), { sequence: 2 })),
    );
    should(older.code).equal('catalog_link_sequence_older');
    should(older.message).match(/2 against 3/u);
    await r.service.preview('project', await linkPreviewRequest(alice, projectTarget(), { sequence: 3 }));
    await r.service.preview('project', await linkPreviewRequest(alice, projectTarget(), { sequence: 4 }));
  });

  it('should pin a link on its own, not another link by the same publisher', async () => {
    const r = rig();
    await installLink(r, { sequence: 5 });
    await r.service.preview(
      'runtime',
      await linkPreviewRequest(alice, runtimeTarget(), { linkId: `lnk_${'b'.repeat(22)}`, sequence: 1 }),
    );
  });

  it('should keep the highest sequence seen for the link', async () => {
    const r = rig();
    await installLink(r, { sequence: 4 });
    await installLink(r, { sequence: 6 });
    await installLink(r, { sequence: 6 });
    should(r.store.state.linkSequences?.[linkSequenceKey(alice.daemonId, LINK_ID)]).equal(6);
  });
});

describe('catalog install from a link: apply and what is recorded', () => {
  it('should install the item and record where it came from, with the link’s kind and sequence', async () => {
    const r = rig();
    const { installed } = await installLink(r, { sequence: 2 });
    should(r.folders.folders.get('/work/app/.claude/skills/pdf-tools')?.get('SKILL.md')).equal('# pdf tools\n');
    const { provenance } = installed.install;
    should('link' in provenance).be.true();
    should(provenance).containEql({ publisher: alice.daemonId, publisherName: 'kirin-box', name: 'pdf-tools' });
    should('link' in provenance && provenance.link).eql({ linkId: LINK_ID, kind: 'public', sequence: 2 });
  });

  it('should write state version 2, with no catalog pinned and no revision recorded', async () => {
    const r = rig();
    await installLink(r, { sequence: 2 });
    const { state } = r.store;
    should(state.schemaVersion).equal(2);
    should(state.pins).eql({});
    should(state.revisions).eql({});
    should(Object.keys(state.publishers)).eql([alice.daemonId]);
    should(state.installs).have.length(1);
  });

  it('should leave a catalog install on version 1', async () => {
    const r = rig();
    const preview = await r.service.preview(
      'project',
      await request(alice, skillItem(alice.daemonId), projectTarget()),
    );
    await r.service.apply('project', { previewId: preview.previewId, secretBindings: {} }, GOVERNANCE, STEP_UP);
    should(r.store.state.schemaVersion).equal(1);
    should(r.store.state.linkSequences).be.undefined();
  });

  it('should keep a catalog’s pins and revisions when a link install upgrades the state', async () => {
    const r = rig();
    const preview = await r.service.preview(
      'project',
      await request(alice, skillItem(alice.daemonId, { name: 'other-skill' }), projectTarget()),
    );
    await r.service.apply('project', { previewId: preview.previewId, secretBindings: {} }, GOVERNANCE, STEP_UP);
    const before = r.store.state;
    await installLink(r);
    should(r.store.state.schemaVersion).equal(2);
    should(r.store.state.pins).eql(before.pins);
    should(r.store.state.revisions).eql(before.revisions);
    should(r.store.state.installs).have.length(2);
  });

  it('should show the install as from a link when listed', async () => {
    const r = rig();
    await installLink(r);
    const listed = await r.service.list();
    should(listed.installs).have.length(1);
    should('link' in (listed.installs[0]?.provenance ?? {})).be.true();
  });

  it('should install into a runtime profile too', async () => {
    const r = rig();
    const { installed } = await installLink(r, {}, runtimeTarget());
    should(installed.install.target.scope).equal('runtime');
  });

  it('should keep the one-time kind on the record', async () => {
    const r = rig();
    const { installed } = await installLink(r, { kind: 'one-time' });
    should('link' in installed.install.provenance && installed.install.provenance.link.kind).equal('one-time');
  });
});

describe('catalog install from a link: replacing, downgrading and conflicts', () => {
  it('should replace an install of the same link at the same place with a newer sequence', async () => {
    const r = rig();
    const first = await installLink(r, { sequence: 1 });
    const second = await installLink(r, { sequence: 2, itemVersion: 2 });
    should(second.preview.replaces?.installId).equal(first.installed.install.installId);
    should(r.store.state.installs).have.length(1);
    should(r.store.state.installs[0]?.provenance.version).equal(2);
  });

  it('should refuse a downgrade unless it was chosen, then say so first, in the link’s words', async () => {
    const r = rig();
    await installLink(r, { sequence: 1, itemVersion: 3 });
    const older = await refusal(
      r.service.preview('project', await linkPreviewRequest(alice, projectTarget(), { sequence: 2, itemVersion: 2 })),
    );
    should(older.code).equal('catalog_downgrade');
    should(older.message).match(/this link has version 2/u);
    const chosen = await r.service.preview(
      'project',
      await linkPreviewRequest(alice, projectTarget(), { sequence: 2, itemVersion: 2, allowOlder: true }),
    );
    should(chosen.warnings[0]?.code).equal('older-version');
    should(chosen.replaces?.version).equal(3);
  });

  it('should not let a catalog install at the same place be replaced by a link', async () => {
    const r = rig();
    const preview = await r.service.preview(
      'project',
      await request(alice, skillItem(alice.daemonId), projectTarget()),
    );
    const catalog = await r.service.apply(
      'project',
      { previewId: preview.previewId, secretBindings: {} },
      GOVERNANCE,
      STEP_UP,
    );
    const error = await refusal(r.service.preview('project', await linkPreviewRequest(alice, projectTarget())));
    should(error.code).equal('catalog_install_conflict');
    should(error.message).match(new RegExp(catalog.install.installId, 'u'));
  });

  it('should not let a link install at the same place be replaced by a catalog', async () => {
    const r = rig();
    await installLink(r);
    const error = await refusal(
      r.service.preview('project', await request(alice, skillItem(alice.daemonId), projectTarget())),
    );
    should(error.code).equal('catalog_install_conflict');
  });

  it('should not let another link replace it', async () => {
    const r = rig();
    await installLink(r);
    const error = await refusal(
      r.service.preview(
        'project',
        await linkPreviewRequest(alice, projectTarget(), { linkId: `lnk_${'b'.repeat(22)}` }),
      ),
    );
    should(error.code).equal('catalog_install_conflict');
  });

  it('should install the same link at another place as a fresh install', async () => {
    const r = rig();
    await installLink(r);
    const elsewhere = await r.service.preview('runtime', await linkPreviewRequest(alice, runtimeTarget()));
    should(elsewhere.replaces).be.undefined();
  });
});
