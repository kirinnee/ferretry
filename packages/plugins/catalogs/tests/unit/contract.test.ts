import { describe, expect, test } from 'bun:test';
import { catalogsConformance, fakeCatalogs } from '../../contract/testing/index.ts';
import { CatalogDigestSchema, CatalogShareCodeSchema } from '../../contract/index.ts';

catalogsConformance('fakeCatalogs', () =>
  fakeCatalogs([
    {
      id: `cin_${'A'.repeat(22)}`,
      catalog: `cat_${'B'.repeat(22)}`,
      item: `itm_${'C'.repeat(22)}`,
      kind: 'skill',
      digest: `sha256:${'0'.repeat(64)}`,
    },
  ]),
);

describe('catalogs wire', () => {
  test('a share code and a digest have one exact shape', () => {
    expect(CatalogShareCodeSchema.safeParse(`fy_share_${'x'.repeat(22)}`).success).toBe(true);
    expect(CatalogShareCodeSchema.safeParse(`fy_share_${'x'.repeat(21)}`).success).toBe(false);
    expect(CatalogDigestSchema.safeParse(`sha256:${'A'.repeat(64)}`).success).toBe(false);
  });
});
