import { readFile } from 'node:fs/promises';
import {
  LOOPBACK_FIREWALL_MARKER_PATH,
  type LoopbackFirewallMarker,
  readLoopbackFirewallMarker,
} from '../wire/ports.ts';
import type { LoopbackMarkerReader } from './state.ts';

// Permanent per-file exemption (DECISIONS-2 #20): the loopback firewall marker is a root-owned file under `/etc`, a
// host file outside every declared root, so it is read by its path here.

/** Reads the marker the root script leaves. A missing or unparseable file is `undefined`, never an error. */
export class FileLoopbackMarkerReader implements LoopbackMarkerReader {
  constructor(private readonly path: string = LOOPBACK_FIREWALL_MARKER_PATH) {}

  async read(): Promise<LoopbackFirewallMarker | undefined> {
    return await readLoopbackFirewallMarker(async path => await readFile(path, 'utf8'), this.path);
  }
}
