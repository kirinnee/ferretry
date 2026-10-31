import { describe, it } from 'bun:test';
import should from 'should';
import {
  renderCatalogCreated,
  renderCatalogDeleted,
  renderCatalogList,
  renderCatalogUpdated,
  renderExported,
  renderPreview,
  renderPublished,
  renderWithdrawn,
} from '../../../src/lib/catalog/render';
import {
  AT,
  CATALOG_ID,
  catalog,
  catalogList,
  mcpItem,
  preview,
  published,
  SKILL_ID,
  skillItem,
  withdrawn,
} from './fixtures';

describe('rendering the catalog list', () => {
  it('should say how to start when there are no catalogs', () => {
    should(renderCatalogList(catalogList([]))).equal('No catalogs yet. Make one with: fy catalog create <name>');
  });

  it('should list each catalog with its revision, item count, visibility and items', () => {
    const text = renderCatalogList(catalogList());
    should(text).containEql(`Team tools (${CATALOG_ID}) · revision 3 · 2 items · members`);
    should(text).containEql(`skill pdf-tools v1 (${SKILL_ID})`);
    should(text).containEql('GitHub issues');
  });

  it('should say 1 item, show the description, and not count a withdrawn item', () => {
    const text = renderCatalogList(
      catalogList([
        catalog({
          description: 'for the team',
          items: [skillItem(), mcpItem({ withdrawnAt: AT, sourceState: 'withdrawn' })],
        }),
      ]),
    );
    should(text).containEql('· 1 item ·');
    should(text).containEql('  for the team');
    should(text).containEql(`withdrawn ${AT}`);
  });

  it('should mark an item whose source changed, and one whose source is gone', () => {
    const text = renderCatalogList(
      catalogList([
        catalog({
          items: [
            skillItem({ sourceState: 'changed' }),
            mcpItem({ sourceState: 'unavailable', sourceNote: 'no server called github' }),
            skillItem({ itemId: `itm_${'x'.repeat(22)}`, name: 'bare', sourceState: 'unavailable' }),
          ],
        }),
      ]),
    );
    should(text).containEql('source changed since this version — publish to update');
    should(text).containEql('source unavailable: no server called github');
    should(text).match(/bare v1 .*source unavailable$/mu);
  });

  it('should leave the version off an item with no versions to name', () => {
    const bare = { ...skillItem(), versions: [] } as unknown as ReturnType<typeof skillItem>;
    should(renderCatalogList(catalogList([catalog({ items: [bare] })]))).containEql('skill pdf-tools (');
  });

  it('should say a withdrawn item with no instant', () => {
    should(renderCatalogList(catalogList([catalog({ items: [skillItem({ sourceState: 'withdrawn' })] })]))).containEql(
      ' · withdrawn\n',
    );
  });
});

describe('rendering results', () => {
  it('should say what was created, updated, deleted, published, withdrawn and exported', () => {
    should(renderCatalogCreated(catalog())).equal(`Created catalog Team tools (${CATALOG_ID}).`);
    should(renderCatalogUpdated(catalog())).equal(`Catalog Team tools (${CATALOG_ID}) is now at revision 3.`);
    should(renderCatalogDeleted('Team tools', CATALOG_ID)).equal(`Deleted catalog Team tools (${CATALOG_ID}).`);
    should(renderPublished(published())).equal(`Published pdf-tools version 1 (${SKILL_ID}); catalog revision 4.`);
    should(renderWithdrawn(withdrawn(), 'pdf-tools')).equal(`Withdrew pdf-tools (${SKILL_ID}); catalog revision 5.`);
    should(renderExported('Team tools', 1, '/w/a.json')).equal('Exported Team tools (1 item) to /w/a.json.');
    should(renderExported('Team tools', 2, '/w/a.json')).containEql('2 items');
  });
});

describe('rendering a preview', () => {
  it('should show every entry in full, documents as indented blocks, then the digest', () => {
    const text = renderPreview(preview());
    should(text).containEql('skill pdf-tools · version 1 · 120 bytes');
    should(text).containEql('Summary: Split, merge and OCR PDFs');
    should(text).containEql('  Skill file SKILL.md:\n    # pdf\n    line two\n\n    line four');
    should(text).containEql('  Starts: npx -y thing');
    should(text).endWith(`Digest: sha256:${'1'.repeat(64)}`);
    should(text).not.containEql('Warnings:');
    should(text).not.containEql('Left out');
  });

  it('should list warnings and what was left out with its reason', () => {
    const text = renderPreview(
      preview({
        warnings: [{ code: 'carries-scripts', text: 'This skill carries scripts.' }],
        problems: [{ subject: 'logo.png', reason: 'not text' }],
      }),
    );
    should(text).containEql('Warnings:\n  - This skill carries scripts.');
    should(text).containEql('Left out of the frozen copy:\n  - logo.png: not text');
  });
});
