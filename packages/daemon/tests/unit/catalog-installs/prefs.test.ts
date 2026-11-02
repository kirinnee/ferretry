import { describe, it } from 'bun:test';
import should from 'should';
import {
  CatalogInstallPrefsStateSchema,
  EMPTY_CATALOG_INSTALL_PREFS,
  mergedPref,
  withPref,
} from '../../../src/lib/catalog-installs/prefs.ts';

/** Stay and skip: what a request does to a recorded choice, and that an empty choice is not kept. */

const ID = `cin_${'i'.repeat(22)}`;
const OTHER = `cin_${'j'.repeat(22)}`;

describe('mergedPref', () => {
  it('should set a hold and a skipped version from nothing', () => {
    should(mergedPref(undefined, { hold: true, skippedVersion: 3 })).deepEqual({ hold: true, skippedVersion: 3 });
  });

  it('should keep what the request leaves out', () => {
    should(mergedPref({ hold: true, skippedVersion: 3 }, {})).deepEqual({ hold: true, skippedVersion: 3 });
  });

  it('should clear a hold with false and a skip with null', () => {
    should(mergedPref({ hold: true, skippedVersion: 3 }, { hold: false })).deepEqual({ skippedVersion: 3 });
    should(mergedPref({ hold: true, skippedVersion: 3 }, { skippedVersion: null })).deepEqual({ hold: true });
    should(mergedPref({ hold: true, skippedVersion: 3 }, { hold: false, skippedVersion: null })).deepEqual({});
  });
});

describe('withPref', () => {
  it('should record a choice and drop it again when nothing is left of it', () => {
    const set = withPref(EMPTY_CATALOG_INSTALL_PREFS, ID, { hold: true });
    should(set.installs).deepEqual({ [ID]: { hold: true } });
    should(withPref(set, ID, {})).deepEqual(EMPTY_CATALOG_INSTALL_PREFS);
  });

  it('should leave another install’s choice alone', () => {
    const state = withPref(withPref(EMPTY_CATALOG_INSTALL_PREFS, OTHER, { skippedVersion: 2 }), ID, { hold: true });
    should(state.installs).deepEqual({ [OTHER]: { skippedVersion: 2 }, [ID]: { hold: true } });
    should(CatalogInstallPrefsStateSchema.safeParse(state).success).be.true();
  });
});
