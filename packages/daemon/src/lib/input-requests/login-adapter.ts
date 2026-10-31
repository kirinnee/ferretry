import type { LoginEntryId, LoginEntrySummary, LoginFieldRole } from '@ferretry/protocol';
import type { LoginDirectory, LoginFieldValues, LoginVault } from '../secrets/logins.ts';
import type { InputLoginPort } from './ports.ts';

/**
 * The saved logins as the input bridge sees them: the directory for names and for saving, the vault for the
 * one value a delivery types. Nothing here returns a value to anything but the delivery that asked.
 */
export class InputLoginAdapter implements InputLoginPort {
  constructor(
    private readonly directory: LoginDirectory,
    private readonly vault: LoginVault,
  ) {}

  async entries(): Promise<readonly LoginEntrySummary[]> {
    return await this.directory.list();
  }

  async fill(id: LoginEntryId, role: LoginFieldRole, nowMs: number): Promise<string> {
    return await this.vault.fill(id, role, nowMs);
  }

  async save(id: LoginEntryId, label: string, match: string | undefined, fields: LoginFieldValues): Promise<void> {
    await this.directory.saveFields(id, label, match, fields);
  }
}
