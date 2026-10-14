/**
 * The browser's half of a machine's setup (docs/design/account-model.md §4.3, §4.7, §7, §10.3): the
 * first-run scan, installing a harness tool, and the Clone export.
 *
 * The import and the clone themselves are reviewed changes — `setup.import` and `clone.import`, staged
 * and applied through `catalog-api.ts` — so nothing here writes a setup. Clone has no daemon-to-daemon
 * path: the browser reads one machine's export here and stages it on the other machine as a change.
 *
 * Every answer is parsed through the shared schema, which has no field a credential could occupy.
 */

import {
  type FleetCloneBundle,
  FleetCloneBundleSchema,
  type FleetSetupScan,
  FleetSetupScanSchema,
  type FleetToolInstallRequest,
  FleetToolInstallRequestSchema,
  type FleetToolInstallResult,
  FleetToolInstallResultSchema,
} from '@ferretry/protocol';
import type { FleetClient } from './fleet-client.ts';

export const FLEET_SETUP_SCAN_PATH = '/v1/fleet/setup/scan';
export const FLEET_TOOLS_INSTALL_PATH = '/v1/fleet/machine/tools/install';
export const FLEET_EXPORT_PATH = '/v1/fleet/export';

/** What the first run (and Import again) would find on this machine. Names only, never a value. */
export const readFleetSetupScan = async (client: FleetClient): Promise<FleetSetupScan> =>
  await client.request(FLEET_SETUP_SCAN_PATH, FleetSetupScanSchema);

/** Install harness tools with the exact command the scan showed.. */
export const installFleetTools = async (
  client: FleetClient,
  request: FleetToolInstallRequest,
): Promise<FleetToolInstallResult> =>
  await client.request(FLEET_TOOLS_INSTALL_PATH, FleetToolInstallResultSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(FleetToolInstallRequestSchema.parse(request)),
  });

/** The Clone bundle a source machine exports: no credential, no history. */
export const readFleetExport = async (client: FleetClient): Promise<FleetCloneBundle> =>
  await client.request(FLEET_EXPORT_PATH, FleetCloneBundleSchema);
