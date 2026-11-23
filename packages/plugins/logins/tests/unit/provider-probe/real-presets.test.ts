import { describe, it } from 'bun:test';
import should from 'should';
import { REAL_PROVIDER_PRESET_CATALOG } from '../../../contract/testing/index.ts';
import realProviderPresets from '../../../contract/testing/provider-presets.json';
import { ProviderPresetService } from '../../../daemon/lib/provider-probe/presets.ts';

/**
 * `contract/testing/provider-presets.json` is the ONE copy of the real catalog other packages' tests draw (Onboarding's
 * "Which AI?" picker and the app's first-run fake daemon). If it drifted from the service, those tests would pass over a
 * catalog the daemon no longer sends; so it is held to the service's own answer here, row for row.
 *
 * To regenerate it after a built-in preset changes: write `JSON.stringify(await new ProviderPresetService({ presets: async () => ({}) }).catalog(), null, 2)`
 * (plus a trailing newline) over `contract/testing/provider-presets.json`.
 */
describe('the real provider catalog fixture', () => {
  const answer = async () => new ProviderPresetService({ presets: async () => ({}) }).catalog();

  it('should equal what the default ProviderPresetService answers, the way it is sent on the wire', async () => {
    // Act
    const actual = JSON.parse(JSON.stringify(await answer()));

    // Assert
    should(realProviderPresets).deepEqual(actual);
  });

  it('should be the catalog the testing export carries, whole', async () => {
    // Act
    const actual = JSON.parse(JSON.stringify(await answer()));

    // Assert
    should(JSON.parse(JSON.stringify(REAL_PROVIDER_PRESET_CATALOG))).deepEqual(actual);
  });
});
