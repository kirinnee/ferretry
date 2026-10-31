import { describe, it } from 'bun:test';
import should from 'should';
import { catalogFileSlug, resolveCatalog, resolveItem } from '../../../src/lib/catalog/resolve';
import { CATALOG_ID, catalog, MCP_ID, mcpItem, OTHER_CATALOG_ID, SKILL_ID, skillItem } from './fixtures';

describe('resolving a catalog', () => {
  const catalogs = [catalog(), catalog({ id: OTHER_CATALOG_ID, name: 'Other' })];

  it('should find a catalog by its id', () => {
    should(resolveCatalog(catalogs, OTHER_CATALOG_ID).name).equal('Other');
  });

  it('should find a catalog by its exact name', () => {
    should(resolveCatalog(catalogs, 'Team tools').id).equal(CATALOG_ID);
  });

  it('should find a catalog by its name in any case', () => {
    should(resolveCatalog(catalogs, ' team TOOLS ').id).equal(CATALOG_ID);
  });

  it('should prefer the exact name when only a case-insensitive twin also matches', () => {
    const twins = [catalog({ name: 'Tools' }), catalog({ id: OTHER_CATALOG_ID, name: 'tools' })];
    should(resolveCatalog(twins, 'tools').id).equal(OTHER_CATALOG_ID);
  });

  it('should refuse a name two catalogs share and list their ids', () => {
    const twins = [catalog(), catalog({ id: OTHER_CATALOG_ID })];
    should(() => resolveCatalog(twins, 'Team tools')).throw(new RegExp(`${CATALOG_ID}, ${OTHER_CATALOG_ID}`));
  });

  it('should refuse a name nobody has', () => {
    should(() => resolveCatalog(catalogs, 'nope')).throw('no catalog "nope"');
  });

  it('should refuse an empty reference', () => {
    should(() => resolveCatalog(catalogs, '  ')).throw('a catalog id or name is required');
  });
});

describe('resolving an item', () => {
  const gone = skillItem({ name: 'old', itemId: `itm_${'o'.repeat(22)}`, withdrawnAt: '2026-10-31T10:00:00.000Z' });
  const target = catalog({ items: [skillItem(), mcpItem(), gone] });

  it('should find a live item by id or by name', () => {
    should(resolveItem(target, MCP_ID).name).equal('github');
    should(resolveItem(target, 'pdf-tools').itemId).equal(SKILL_ID);
  });

  it('should find a withdrawn item by its id', () => {
    should(resolveItem(target, gone.itemId).name).equal('old');
  });

  it('should not reach a withdrawn item by name', () => {
    should(() => resolveItem(target, 'old')).throw('no item in Team tools "old"');
  });
});

describe('naming the export file', () => {
  it('should lower-case and join words with hyphens', () => {
    should(catalogFileSlug("My Team's Skills!")).equal('my-team-s-skills');
  });

  it('should cut a long name and not leave a trailing hyphen', () => {
    const slug = catalogFileSlug(`${'a'.repeat(59)} b`);
    should(slug).equal('a'.repeat(59));
  });

  it('should fall back to catalog when nothing usable is left', () => {
    should(catalogFileSlug('日本語')).equal('catalog');
  });
});
