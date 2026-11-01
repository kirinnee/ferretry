import type { AccountList, LoginEntryId, LoginFieldRole } from '@ferretry/protocol';
import type { AccountVault, LoginFieldValues } from '../secrets/accounts.ts';
import type { LoginDirectory } from '../secrets/logins.ts';
import type { InputLoginPort } from './ports.ts';

/**
 * The accounts as the input bridge sees them: the directory for names, places and saving, the vault for the one
 * value a delivery types. Nothing here returns a value to anything but the delivery that asked.
 */
export class InputLoginAdapter implements InputLoginPort {
  constructor(
    private readonly directory: LoginDirectory,
    private readonly vault: Pick<AccountVault, 'fill'>,
  ) {}

  async listing(): Promise<Pick<AccountList, 'accounts' | 'signIns'>> {
    return await this.directory.accounts.list();
  }

  async fill(id: LoginEntryId, role: LoginFieldRole, nowMs: number): Promise<string> {
    return await this.vault.fill(id, role, nowMs);
  }

  async save(id: LoginEntryId, label: string, match: string | undefined, fields: LoginFieldValues): Promise<void> {
    await this.directory.saveFields(id, label, match, fields);
  }
}
