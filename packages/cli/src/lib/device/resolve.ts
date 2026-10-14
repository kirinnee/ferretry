import type { PairedDevice } from '@ferretry/protocol';

/** What the owner typed, matched against the paired devices. */
export type DeviceResolution =
  | { readonly kind: 'found'; readonly device: PairedDevice }
  | { readonly kind: 'none'; readonly known: readonly PairedDevice[] }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly PairedDevice[] };

/**
 * Finds the one device a query means.
 *
 * AN ID WINS, because it is the only unambiguous spelling: a device whose NAME is another device's id
 * is possible (the name is whatever the device called itself) and must not be able to steal that
 * device's recovery. A name must then match EXACTLY and exactly ONE device; two phones that both call
 * themselves "Chrome" are told apart by the id, never guessed between.
 */
export function resolveDevice(devices: readonly PairedDevice[], query: string): DeviceResolution {
  const byId = devices.find(device => device.id === query);
  if (byId !== undefined) return { kind: 'found', device: byId };
  const byName = devices.filter(device => device.name === query);
  const [only] = byName;
  if (byName.length === 1 && only !== undefined) return { kind: 'found', device: only };
  if (byName.length > 1) return { kind: 'ambiguous', candidates: byName };
  return { kind: 'none', known: devices };
}
