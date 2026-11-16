/**
 * THE ID OF THIS DEVICE, for the Sharing-off command (`fy device grant <id> …`). Read from Access's paired-devices list
 * (`GET /v1/pair/devices`, `thisDeviceId`) through the half's client, parsed by Access's own schema. A refusal, a caller
 * that is not a paired device (the host's own admin credential has no id) or an answer that does not parse is `null`, and
 * the command keeps its `<device>` placeholder.
 */
import { PairedDevicesViewSchema } from '@ferretry/plugin-access/contract';
import { type CatalogClient, PAIRED_DEVICES_PATH } from './catalog-client.ts';

export async function readThisDeviceId(client: CatalogClient): Promise<string | null> {
  try {
    const view = await client.request(PAIRED_DEVICES_PATH, PairedDevicesViewSchema);
    return view.thisDeviceId ?? null;
  } catch {
    return null;
  }
}
