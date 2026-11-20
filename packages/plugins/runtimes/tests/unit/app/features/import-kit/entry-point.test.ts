import { describe, expect, it } from 'bun:test';
import * as kit from '../../../../../app/features/import-kit/index.ts';

describe('the import kit public entry point', () => {
  it('loads and exports everything the plugins build on, including every file it re-exports', () => {
    for (const name of [
      'buildImportChange',
      'FoundKindList',
      'IMPORT_KINDS',
      'kindFound',
      'kindGroups',
      'kindItemIds',
      'kindSkips',
      'nameProblem',
      'HARNESS_LABEL',
      'HARNESSES',
      'ImportResultList',
      'useApplyImport',
      'createScanStore',
      'scanStoreFor',
      'useHarnessScan',
      'useScan',
    ] as const)
      expect(kit[name]).toBeDefined();
  });
});
