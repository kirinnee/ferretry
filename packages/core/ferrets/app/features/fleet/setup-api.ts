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

import { FLEET_CLONE_KEYS_PATH, type FleetCloneBundle, FleetCloneBundleSchema, type FleetCloneKeysRecordRequest, FleetCloneKeysRecordRequestSchema, type FleetCloneKeysRecordResult, FleetCloneKeysRecordResultSchema, type FleetCloneReview, type FleetCloneReviewRequest, FleetCloneReviewRequestSchema, FleetCloneReviewSchema, type FleetSetupScan, FleetSetupScanSchema, type FleetToolInstallRequest, FleetToolInstallRequestSchema, type FleetToolInstallResult, FleetToolInstallResultSchema } from '@ferretry/protocol';
import type { FleetClient } from './fleet-client.ts';

export const FLEET_SETUP_SCAN_PATH = '/v1/runtimes/setup/scan';
export const FLEET_TOOLS_INSTALL_PATH = '/v1/runtimes/machine/tools/install';
export const FLEET_EXPORT_PATH = '/v1/runtimes/export';
export const FLEET_CLONE_REVIEW_PATH = '/v1/runtimes/clone/review';

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

/**
 * What a copy from this source would change here, key by key for settings (design §5, §8b), and how each API key
 * stands (`newer` on the source, changed `both` sides, `missing` here): this machine compares `updatedAt`
 * timestamps with its own record of the last copy. Writes nothing, and carries no value: `sourceSecrets` is names
 * and instants. The answer's `fingerprint` is what the apply names, so the apply is refused if this machine has
 * moved since.
 */
export const reviewFleetClone = async (
  client: FleetClient,
  request: FleetCloneReviewRequest,
): Promise<FleetCloneReview> =>
  await client.request(FLEET_CLONE_REVIEW_PATH, FleetCloneReviewSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(FleetCloneReviewRequestSchema.parse(request)),
  });

/**
 * After a sealed copy has landed here: remember when the source last changed each key it filed. `filedAt` is the
 * instant this machine says it filed them (the import's own answer); a key it cannot prove it made then is not
 * remembered. Timestamps only.
 */
export const recordCloneKeys = async (
  client: FleetClient,
  request: {
    readonly source: FleetCloneKeysRecordRequest['source'];
    readonly filedAt: string;
    readonly keys: readonly { readonly name: string; readonly sourceUpdatedAt: string }[];
  },
): Promise<FleetCloneKeysRecordResult> =>
  await client.request(FLEET_CLONE_KEYS_PATH, FleetCloneKeysRecordResultSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(FleetCloneKeysRecordRequestSchema.parse(request)),
  });
