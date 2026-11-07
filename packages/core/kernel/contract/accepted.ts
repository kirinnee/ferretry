import { z } from 'zod';
import { defineState } from './define.ts';

/**
 * The accepted record (§9.2): what was put into effect for one config file, with its text, under
 * `state/kernel/accepted-config/`. Today's `state/config-accepted.json` held one `{ etag, text }` per config path in a
 * single document; here each path is its own document named `acceptedName(path)`, so a converter carries every
 * loosening the owner already confirmed across by writing one document per path (no re-hold). It is the daemon's record, not a configuration: nothing edits it but the config service. A
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
