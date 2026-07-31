import { type FleetManifest, FleetManifestSchema } from '@ferretry/fleet';
import { z } from 'zod';
import type { IFleetManifestSource } from '../../lib/fleet/ports.ts';

/**
 * Reads the manifest provisioning published.
 *
 * A host that has never run `fy fleet apply` has no manifest, which is a normal state and answers
 * `undefined`. A manifest that exists but does not parse is not — it means provisioning wrote
 * something inconsistent, and reporting that beats rendering a fleet that is not there.
 */
export class FileFleetManifestSource implements IFleetManifestSource {
  constructor(private readonly path: string) {}

  async load(): Promise<FleetManifest | undefined> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) return undefined;

    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch (error) {
      throw new Error(`the fleet manifest at ${this.path} is not valid JSON: ${(error as Error).message}`);
    }

    const parsed = FleetManifestSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`invalid fleet manifest at ${this.path}: ${z.prettifyError(parsed.error)}`);
    return parsed.data;
  }
}
