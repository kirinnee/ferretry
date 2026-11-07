import { readFile } from 'node:fs/promises';
import {
  LOOPBACK_FIREWALL_MARKER_PATH,
  type LoopbackFirewallMarker,
  readLoopbackFirewallMarker,
} from '@ferretry/protocol';
import type { LoopbackMarkerReader } from '../../../lib/browser/firewall/index.ts';

/** Reads the marker the root script leaves. A missing or unparseable file is `undefined`, never an error. */
export class FileLoopbackMarkerReader implements LoopbackMarkerReader {
  constructor(private readonly path: string = LOOPBACK_FIREWALL_MARKER_PATH) {}

  async read(): Promise<LoopbackFirewallMarker | undefined> {
    return await readLoopbackFirewallMarker(async path => await readFile(path, 'utf8'), this.path);
  }
}
