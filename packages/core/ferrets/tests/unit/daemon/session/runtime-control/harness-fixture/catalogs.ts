/**
 * TEST FIXTURE: the `HarnessRuntimeCatalogs` the host builds from the harness plugin, over this fixture's verbatim
 * copies, so the runtime-control tests see today's catalogs and today's picker driver.
 */
import type { HarnessRuntimeCatalogs } from '../../../../../../daemon/lib/session/peers/harness.ts';
import { fastModeFacts } from './fast-mode.ts';
import { claudeRuntimeCatalog, codexRuntimeCatalog, codexSwitchContext } from './model-catalog.ts';
import { CodexModelPickerDriver } from './picker-drive.ts';

export const harnessCatalogs: HarnessRuntimeCatalogs = {
  claudeRuntimeCatalog,
  codexRuntimeCatalog,
  codexSwitchContext,
  fastModeFacts,
  pickerDriver: (transport, sleeper) => new CodexModelPickerDriver(transport, sleeper),
};
