import { join } from 'node:path';
import { InstantSchema, SecuritySettingsSchema } from '@ferretry/protocol';
import { z } from 'zod';
import type {
  FileSystemPort,
  FoundationPaths,
  SecuritySettingsDocumentPort,
  StoredSecuritySettings,
} from '../../lib/index.ts';

/**
 * ONE MACHINE'S SECURITY SETTINGS, in one document inside the state home (`docs/design/zero-trust.md`
 * B6): `state/security.json`, written atomically and owner-only.
 *
 * A document that does not parse is DAMAGE and throws. The service reads that as its strictest
 * reading, never as the defaults — a corrupted file must not quietly turn presence-on-open off — so
 * this adapter's only job is to say "unreadable" loudly and name the file while it does.
 */

const SECURITY_MODE = 0o600;

const DocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  settings: SecuritySettingsSchema,
  updatedAt: InstantSchema,
});

/** The settings document could not be read as settings. A state to report, never the defaults. */
export class SecuritySettingsDamaged extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecuritySettingsDamaged';
  }
}

export class StateSecuritySettingsDocument implements SecuritySettingsDocumentPort {
  readonly path: string;

  constructor(
    paths: FoundationPaths,
    private readonly files: Pick<FileSystemPort, 'readText' | 'writeTextAtomic' | 'setMode'>,
  ) {
    this.path = join(paths.state, 'security.json');
  }

  async read(): Promise<StoredSecuritySettings | undefined> {
    const raw = await this.files.readText(this.path);
    if (raw === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SecuritySettingsDamaged(`${this.path} is not valid JSON`);
    }
    const document = DocumentSchema.safeParse(parsed);
    if (!document.success) throw new SecuritySettingsDamaged(`${this.path} does not describe security settings`);
    return { settings: document.data.settings, updatedAt: document.data.updatedAt };
  }

  async write(stored: StoredSecuritySettings): Promise<void> {
    const document = DocumentSchema.parse({ schemaVersion: 1, ...stored });
    await this.files.writeTextAtomic(this.path, `${JSON.stringify(document)}\n`);
    await this.files.setMode(this.path, SECURITY_MODE);
  }
}
