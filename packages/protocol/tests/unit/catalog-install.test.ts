import { describe, expect, it } from 'bun:test';
import {
  CATALOG_INSTALL_REFUSALS,
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

describe('catalog install paths', () => {
  it('names each scope’s apply route and its preview route', () => {
    expect(catalogInstallsPath('project')).toBe('/v1/catalog-installs/project');
    expect(catalogInstallsPath('runtime', true)).toBe('/v1/catalog-installs/runtime/preview');
  });

  it('names the route that stays or skips one install', () => {
    expect(catalogInstallPath('runtime', 'cin_x')).toBe('/v1/catalog-installs/runtime/cin_x');
  });
});
