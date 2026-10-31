import { LOGIN_MATCH_MAX, type LoginEntryId, type LoginEntrySummary, type LoginFieldRole } from '@ferretry/protocol';
import type { LoginDirectory, LoginVault } from '../secrets/logins.ts';
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

  async save(
    id: LoginEntryId,
    label: string,
    match: string | undefined,
    field: Exclude<LoginFieldRole, 'totp'>,
    value: string,
  ): Promise<void> {
    const existing = (await this.directory.list()).find(entry => entry.id === id);
    const matches = [...new Set([...(existing?.match ?? []), ...(match === undefined ? [] : [match])])].slice(
      -LOGIN_MATCH_MAX,
    );
    await this.directory.put(id, {
      ...(existing === undefined ? { label } : {}),
      match: matches,
      ...(field === 'password' ? { password: value } : { username: value }),
    });
  }
}
