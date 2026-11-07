import { readFile } from 'node:fs/promises';
import {
  LOOPBACK_FIREWALL_MARKER_PATH,
  type LoopbackFirewallMarker,
  readLoopbackFirewallMarker,
} from '../wire/ports.ts';
import type { LoopbackMarkerReader } from './state.ts';

// GAP (kernel port, banned-globals stays visible here): the loopback firewall marker is a root-owned file under
// `/etc`, outside every declared root; no kernel port reads a host file outside the home.

/** Reads the marker the root script leaves. A missing or unparseable file is `undefined`, never an error. */
export class FileLoopbackMarkerReader implements LoopbackMarkerReader {
  constructor(private readonly path: string = LOOPBACK_FIREWALL_MARKER_PATH) {}

  async read(): Promise<LoopbackFirewallMarker | undefined> {
    return await readLoopbackFirewallMarker(async path => await readFile(path, 'utf8'), this.path);
  }
}
