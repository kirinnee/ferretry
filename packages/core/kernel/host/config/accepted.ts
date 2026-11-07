import { z } from 'zod';
import { defineState } from '../../contract/index.ts';

/**
 * The accepted record, one document per config file under `state/kernel/accepted-config/` (§9.2): what was put into
 * effect, with its text. It is the daemon's record, not a configuration: nothing edits it but the config service. A
 * record that cannot be read reads as nothing accepted, so every file is judged against the defaults, which holds
 * back any loosening until the owner confirms it again — the safe direction to be wrong in.
 */
export const acceptedConfigFile = defineState({
  name: 'accepted-config',
  path: 'accepted-config/*.json',
  store: 'json',
  format: 1,
  schema: z.strictObject({ etag: z.string().min(1), text: z.string() }),
  onDamaged: { narrower: 'reads as nothing accepted, so every file is judged against its defaults' },
});

/** The state name for a config path: every character outside a safe set is `%XX`-escaped, so `a/b.yaml` is one name. */
export function acceptedName(path: string): string {
  return Array.from(new TextEncoder().encode(path), byte => {
    const char = String.fromCharCode(byte);
    return /[A-Za-z0-9._~-]/u.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

export function pathOfAcceptedName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}
