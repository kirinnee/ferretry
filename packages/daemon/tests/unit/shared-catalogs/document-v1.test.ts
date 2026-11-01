import { describe, it } from 'bun:test';
import should from 'should';
import { CatalogsDocumentV1Schema } from '../../../src/lib/shared-catalogs/document-v1.ts';
import { legacyState } from './legacy.ts';
import { rig } from './support.ts';

const problem = (document: unknown): string | undefined => {
  const parsed = CatalogsDocumentV1Schema.safeParse(document);
  return parsed.success ? undefined : parsed.error.issues[0]?.message;
};

describe('the version 1 catalogs document', () => {
  it('should accept what a version 1 daemon wrote, and refuse a version 2 file', async () => {
    const { document } = await legacyState(await rig());
    should(problem(document)).be.undefined();
    should(problem({ schemaVersion: 2, catalogs: [], items: [] })).be.a.String();
  });

  it('should refuse a catalog, an item or a run of versions that cannot be right', async () => {
    const { document } = await legacyState(await rig());
    const [first, second] = document.catalogs as [
      (typeof document.catalogs)[number],
      (typeof document.catalogs)[number],
    ];
    should(problem({ ...document, catalogs: [first, first] })).match(/listed twice/u);
    const twin = { ...second, items: first.items };
    should(problem({ ...document, catalogs: [first, twin] })).match(/listed twice/u);
    const skipped = {
      ...first,
      items: first.items.map(item => ({
        ...item,
        versions: item.versions.map(version => ({ ...version, version: version.version + 1 })),
      })),
    };
    should(problem({ ...document, catalogs: [skipped] })).match(/in order/u);
  });
});
