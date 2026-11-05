import { describe, expect, it } from 'bun:test';
import {
  CATALOG_INSTALL_REFUSALS,
  CatalogInstallPreviewRequestSchema,
  CatalogLinkProvenanceSchema,
  CatalogManifestProvenanceSchema,
  CatalogProvenanceSchema,
  isLinkProvenance,
  provenanceSource,
  catalogInstallPath,
  CatalogInstallPrefsRequestSchema,
  catalogInstallsPath,
  CatalogInstallPreviewIdSchema,
  CatalogInstallRequestSchema,
  CatalogInstallTargetSchema,
} from '../../src/lib/catalog-install.ts';

describe('catalog install wire', () => {
  it('accepts a project target by absolute root and harness, and a runtime target by runtime and profile', () => {
    expect(
      CatalogInstallTargetSchema.safeParse({ scope: 'project', projectRoot: '/home/a/repo', harness: 'claude' })
        .success,
    ).toBe(true);
    expect(
      CatalogInstallTargetSchema.safeParse({ scope: 'runtime', runtime: 'claude-a', profile: 'default' }).success,
    ).toBe(true);
  });

  it('refuses a relative project root, an unknown harness and a mixed target', () => {
    for (const target of [
      { scope: 'project', projectRoot: 'repo', harness: 'claude' },
      { scope: 'project', projectRoot: '/repo', harness: 'gemini' },
      { scope: 'project', projectRoot: '/repo', harness: 'claude', runtime: 'x' },
      { scope: 'runtime', runtime: 'x' },
    ]) {
      expect(CatalogInstallTargetSchema.safeParse(target).success).toBe(false);
    }
  });

  it('binds each placeholder to one of the installer’s own secrets, or to nothing — never to a value', () => {
    const previewId = `cip_${'p'.repeat(22)}`;
    expect(
      CatalogInstallRequestSchema.safeParse({
        previewId,
        secretBindings: { GITHUB_TOKEN: 'GITHUB_TOKEN_READONLY', OTHER: null },
      }).success,
    ).toBe(true);
    // A binding names a secret; it cannot carry one.
    expect(
      CatalogInstallRequestSchema.safeParse({ previewId, secretBindings: { GITHUB_TOKEN: 'ghp_abc def' } }).success,
    ).toBe(false);
    expect(CatalogInstallRequestSchema.safeParse({ previewId }).success).toBe(false);
    expect(CatalogInstallPreviewIdSchema.safeParse('cip_short').success).toBe(false);
  });

  it('asks for a hold, a skipped version or both, and lets either be cleared', () => {
    expect(CatalogInstallPrefsRequestSchema.safeParse({ hold: true }).success).toBe(true);
    expect(CatalogInstallPrefsRequestSchema.safeParse({ hold: false, skippedVersion: null }).success).toBe(true);
    expect(CatalogInstallPrefsRequestSchema.safeParse({ skippedVersion: 3 }).success).toBe(true);
    for (const body of [{}, { skippedVersion: 0 }, { hold: 'yes' }, { other: 1 }]) {
      expect(CatalogInstallPrefsRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it('names the edited refusal', () => {
    expect(CATALOG_INSTALL_REFUSALS).toContain('catalog_install_edited');
  });

  it('keeps every refusal distinct', () => {
    expect(new Set(CATALOG_INSTALL_REFUSALS).size).toBe(CATALOG_INSTALL_REFUSALS.length);
  });
});

const DAEMON = `fy_daemon_${'A'.repeat(43)}`;
const SHARED = {
  publisher: DAEMON,
  publisherName: 'kirin-box',
  itemId: `itm_${'s'.repeat(22)}`,
  kind: 'skill',
  name: 'pdf-tools',
  version: 1,
  digest: `sha256:${'a'.repeat(64)}`,
};
const FROM_CATALOG = { ...SHARED, catalogId: `cat_${'c'.repeat(22)}`, catalogName: 'Kirin catalog' };
const FROM_LINK = { ...SHARED, link: { linkId: `lnk_${'l'.repeat(22)}`, kind: 'public', sequence: 2 } };

describe('catalog install provenance', () => {
  it('reads where an install came from as a catalog or as a link, and never as both', () => {
    expect(CatalogProvenanceSchema.safeParse(FROM_CATALOG).success).toBe(true);
    expect(CatalogProvenanceSchema.safeParse(FROM_LINK).success).toBe(true);
    expect(CatalogProvenanceSchema.safeParse({ ...FROM_CATALOG, link: FROM_LINK.link }).success).toBe(false);
    expect(CatalogManifestProvenanceSchema.safeParse(FROM_LINK).success).toBe(false);
    expect(CatalogLinkProvenanceSchema.safeParse(FROM_CATALOG).success).toBe(false);
  });

  it('refuses a link whose sequence is not a signed 32-bit count, or whose kind is unknown', () => {
    for (const link of [
      { ...FROM_LINK.link, sequence: 0 },
      { ...FROM_LINK.link, sequence: 0x1_0000_0000 },
      { ...FROM_LINK.link, kind: 'forever' },
      { ...FROM_LINK.link, linkId: 'lnk_short' },
    ])
      expect(CatalogLinkProvenanceSchema.safeParse({ ...FROM_LINK, link }).success).toBe(false);
  });

  it('tells a link’s provenance from a catalog’s, and names the source a person reads', () => {
    const link = CatalogProvenanceSchema.parse(FROM_LINK);
    const catalog = CatalogProvenanceSchema.parse(FROM_CATALOG);
    expect(isLinkProvenance(link)).toBe(true);
    expect(isLinkProvenance(catalog)).toBe(false);
    expect(provenanceSource(link)).toBe('a shared link');
    expect(provenanceSource(catalog)).toBe('Kirin catalog');
  });

  it('names the three refusals a link adds', () => {
    for (const code of ['catalog_link_mismatch', 'catalog_link_expired', 'catalog_link_sequence_older'])
      expect(CATALOG_INSTALL_REFUSALS as readonly string[]).toContain(code);
  });

  it('refuses a preview request that is neither a manifest’s nor a link’s', () => {
    expect(CatalogInstallPreviewRequestSchema.safeParse({}).success).toBe(false);
    expect(CatalogInstallPreviewRequestSchema.safeParse({ linkFingerprint: DAEMON }).success).toBe(false);
  });
});

describe('catalog install paths', () => {
  it('names each scope’s apply route and its preview route', () => {
    expect(catalogInstallsPath('project')).toBe('/v1/catalog-installs/project');
    expect(catalogInstallsPath('runtime', true)).toBe('/v1/catalog-installs/runtime/preview');
  });

  it('names the route that stays or skips one install', () => {
    expect(catalogInstallPath('runtime', 'cin_x')).toBe('/v1/catalog-installs/runtime/cin_x');
  });
});
