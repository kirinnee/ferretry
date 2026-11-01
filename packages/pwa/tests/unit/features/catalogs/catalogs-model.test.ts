import { describe, it } from 'bun:test';
import { FyHttpError, FyTransportError } from '@ferretry/protocol/client';
import should from 'should';
import {
  addState,
  catalogSummary,
  choiceProblem,
  exportFileName,
  itemState,
  latestVersion,
  ownerRefusal,
  previewButtonLabel,
  previewPlan,
  SHARING_GRANT_COMMAND,
  SHARING_OFF_LINES,
  sharingGrantCommand,
} from '../../../../src/features/catalogs/catalogs-model.ts';
import { itemPreview, ownedCatalog } from '../../../support/catalog-views.ts';

describe('sharing', () => {
  it('names the in-app way first, then the host command', () => {
    should(SHARING_GRANT_COMMAND).match(/sharing/u);
    should(SHARING_GRANT_COMMAND).match(/--use/u);
    should(SHARING_OFF_LINES.join(' ')).match(/Settings › Devices/u);
    should(SHARING_OFF_LINES.at(-1)).match(/machine itself/u);
  });
});

describe('sharingGrantCommand', () => {
  const id = `fy_device_id_${'a'.repeat(22)}`;
  it('uses this device id, so the command can be pasted as it is', () => {
    should(sharingGrantCommand(id)).equal(`fy device grant ${id} sharing --use`);
  });
  it('keeps the placeholder when the id is missing or is not a device id', () => {
    should(sharingGrantCommand(null)).containEql('<device>');
    should(sharingGrantCommand('Ernest; rm -rf ~')).containEql('<device>');
  });
});

describe('ownerRefusal', () => {
  it('says Sharing is off for a grant refusal', () => {
    const refusal = ownerRefusal(new FyHttpError('no', 403, 'grant_device_not_granted'));
    should(refusal).containEql({ sharingOff: true, previewAgain: false });
  });
  it('treats a missing passkey as an ordinary refusal', () => {
    const refusal = ownerRefusal(new FyHttpError('step up', 403, 'grant_step_up_required'));
    should(refusal.sharingOff).be.false();
    should(refusal.sentence).match(/passkey/u);
  });
  it('asks to preview again when the source changed', () => {
    const refusal = ownerRefusal(new FyHttpError('x', 409, 'changed_since_preview'));
    should(refusal.previewAgain).be.true();
    should(refusal.sentence).match(/Preview it again/u);
  });
  it('words each known code', () => {
    for (const code of ['nothing_to_publish', 'name_taken', 'catalog_full', 'catalog_unknown', 'item_unknown'])
      should(ownerRefusal(new FyHttpError('x', 409, code)).sentence).not.equal('x');
  });
  it('falls back to a plain sentence for anything else', () => {
    should(ownerRefusal(new FyHttpError('odd', 500, 'zzz')).sentence.length).be.above(0);
    should(ownerRefusal(new FyHttpError('odd', 500, undefined)).previewAgain).be.false();
    should(ownerRefusal(new FyTransportError('down', '/v1/catalogs', false, null)).sentence.length).be.above(0);
    should(ownerRefusal(new Error('x')).sharingOff).be.false();
  });
});

describe('catalogs and items', () => {
  it('summarises a catalog without counting withdrawn items', () => {
    should(catalogSummary(ownedCatalog())).equal('1 item · revision 4');
    should(catalogSummary(ownedCatalog({}, { withdrawnAt: '2026-10-31T09:00:00.000Z' }))).equal('0 items · revision 4');
  });
  it('reads the latest version', () => {
    should(latestVersion(ownedCatalog().items[0]!)).equal(2);
  });
  it('says how each source state reads', () => {
    const state = (change: Record<string, unknown>) => itemState(ownedCatalog({}, change).items[0]!);
    should(state({})).be.null();
    should(state({ sourceState: 'unchanged' })).containEql({ label: 'Up to date', canPublish: false });
    should(state({ sourceState: 'changed' })).containEql({ label: 'Source changed', canPublish: true });
    should(state({ sourceState: 'unavailable', sourceNote: 'moved' })).containEql({
      detail: 'moved',
      canPublish: false,
    });
    should(state({ sourceState: 'unavailable' })?.detail).be.null();
    should(state({ sourceState: 'changed', withdrawnAt: '2026-10-31T09:00:00.000Z' })).containEql({
      label: 'Withdrawn',
      canPublish: false,
    });
  });
  it('treats an item with no versions as version 1', () => {
    const item = { ...ownedCatalog().items[0]!, versions: [] };
    should(latestVersion(item)).equal(1);
  });
});

describe('exportFileName', () => {
  it('keeps letters of any language and turns the rest into dashes', () => {
    should(exportFileName('Team skills')).equal('Team-skills.catalog.json');
    should(exportFileName('チーム/スキル')).equal('チーム-スキル.catalog.json');
    should(exportFileName('  ../x  ')).equal('x.catalog.json');
    should(exportFileName('///')).equal('catalog.catalog.json');
  });
});

describe('choosing a catalog', () => {
  const catalogs = [ownedCatalog()];
  it('needs a choice', () => {
    should(choiceProblem(null, catalogs)).match(/Pick a catalog/u);
  });
  it('accepts an existing catalog only while it exists', () => {
    should(choiceProblem({ kind: 'existing', catalogId: catalogs[0]!.id }, catalogs)).be.null();
    should(choiceProblem({ kind: 'existing', catalogId: 'cat_gone' }, catalogs)).match(/gone/u);
  });
  it('checks a new name', () => {
    should(choiceProblem({ kind: 'new', name: '   ' }, catalogs)).match(/Give the new catalog a name/u);
    should(choiceProblem({ kind: 'new', name: 'a\nb' }, catalogs)).match(/shorter name/u);
    should(choiceProblem({ kind: 'new', name: ' team SKILLS ' }, catalogs)).match(/already have/u);
    should(choiceProblem({ kind: 'new', name: 'Other' }, catalogs)).be.null();
  });
  it('previews a new catalog against the first, or makes the first', () => {
    const existing = previewPlan({ kind: 'existing', catalogId: 'cat_x' }, catalogs);
    should(existing).eql({ kind: 'use', catalogId: 'cat_x' });
    should(previewPlan({ kind: 'new', name: ' New ' }, catalogs)).eql({ kind: 'use', catalogId: catalogs[0]!.id });
    const first = previewPlan({ kind: 'new', name: ' New ' }, []);
    should(first).eql({ kind: 'make-first', name: 'New' });
    should(previewButtonLabel(first)).match(/Make the catalog/u);
    should(previewButtonLabel(existing)).equal('Preview');
  });
});

describe('addState', () => {
  it('waits for a preview', () => {
    should(addState(null, false).enabled).be.false();
  });
  it('refuses a preview that is the same as the version it follows', () => {
    const state = addState(itemPreview({ sameAsVersion: 2, version: 3 }), false);
    should(state.enabled).be.false();
    should(state.reason).match(/version 2/u);
  });
  it('enables Add for a new preview unless busy', () => {
    should(addState(itemPreview(), false)).eql({ enabled: true, reason: null });
    should(addState(itemPreview(), true).enabled).be.false();
  });
});
