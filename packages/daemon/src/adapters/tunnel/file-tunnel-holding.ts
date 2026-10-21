/**
 * THAT THIS DAEMON HOLDS A TUNNEL, ON DISK — and nothing that could run one.
 *
 * The record is `{ origin, tunnelUrl }`: which hosted service provisioned it and the hostname it
 * answers. The connector token is NOT here and has no field to be put in — it lives in memory for one
 * boot. The record exists for one case: an operator who switches the carrier off on a later boot, whose
 * daemon must know there is a tunnel to release even though the boot that provisioned it is gone.
 *
 * Written atomically (temporary file, then rename) with owner-only permissions. A damaged record is an
 * error rather than "no tunnel": treating unreadable evidence as absence is how a held tunnel would be
 * silently forgotten instead of released.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { TunnelOriginSchema } from '@ferretry/protocol';
import { z } from 'zod';
import type { TunnelHolding, TunnelHoldingPort } from '../../lib/tunnel/index.ts';

const TunnelHoldingDocumentSchema = z.strictObject({
  version: z.literal(1),
  origin: z.string().min(1).max(2048),
  tunnelUrl: TunnelOriginSchema,
});

export class FileTunnelHolding implements TunnelHoldingPort {
  constructor(private readonly file: string) {}

  async read(): Promise<TunnelHolding | undefined> {
    const text = await readFile(this.file, 'utf8').catch((error: unknown) => {
      if ((error as { code?: string }).code === 'ENOENT') return undefined;
      throw error;
    });
    if (text === undefined) return undefined;
    let parsed: z.output<typeof TunnelHoldingDocumentSchema>;
    try {
      parsed = TunnelHoldingDocumentSchema.parse(JSON.parse(text));
    } catch {
      throw new Error(`the tunnel record ${this.file} is damaged and cannot be read`);
    }
    return { origin: parsed.origin, tunnelUrl: parsed.tunnelUrl };
  }

  async record(holding: TunnelHolding): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(this.file), `.${basename(this.file)}.${randomUUID()}.tmp`);
    const document = { version: 1, origin: holding.origin, tunnelUrl: holding.tunnelUrl };
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.file);
  }

  async forget(): Promise<void> {
    await rm(this.file, { force: true });
  }
}
