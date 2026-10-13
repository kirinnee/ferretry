/**
 * Planting a fake Claude credential where the harness looks for it on this platform.
 *
 * On Linux that is `<store>/.credentials.json`. On macOS it is a login-keychain item whose service
 * name Claude derives from `CLAUDE_SECURESTORAGE_CONFIG_DIR` (design §8.1.1): the first 8 hex of
 * sha256(directory) appended to `Claude Code-credentials`, or the bare name for `""`.
 *
 * Writing the keychain is allowed only where `FY_CONTRACT_KEYCHAIN=1` AND `CI=true` — the throwaway
 * `macos-15` runner. A macOS suite that needs a credential is skipped everywhere else, because the
 * bare item is the one a person's own `claude` login lives in.
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { contract, run } from './harness.ts';

const onMac = process.platform === 'darwin';
export const keychainWritable = onMac && process.env.FY_CONTRACT_KEYCHAIN === '1' && process.env.CI === 'true';
/** Whether this platform can hold a planted Claude credential at all. */
export const claudeCredentialPlantable = contract.enabled && (!onMac || keychainWritable);

export const BARE_SERVICE = 'Claude Code-credentials';
const account = process.env.USER ?? '';

export const serviceFor = (storeDirectory: string): string =>
  `${BARE_SERVICE}-${createHash('sha256').update(storeDirectory.normalize('NFC')).digest('hex').slice(0, 8)}`;

const security = (args: string[]) =>
  run(['/usr/bin/security', ...args], { env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '' } });

const planted = new Set<string>();

export async function plantKeychainItem(service: string, secret: string): Promise<void> {
  if (!keychainWritable) throw new Error('refusing to write the keychain outside the CI macOS runner');
  if (account === '') throw new Error('USER is unset, so the keychain account Claude uses cannot be named');
  const done = await security(['add-generic-password', '-U', '-a', account, '-s', service, '-w', secret]);
  if (done.code !== 0) throw new Error(`could not plant keychain item ${service}: ${done.stderr}`);
  planted.add(service);
}

export async function readKeychainItem(service: string): Promise<string | undefined> {
  const found = await security(['find-generic-password', '-a', account, '-s', service, '-w']);
  return found.code === 0 ? found.stdout.trim() : undefined;
}

export async function removeKeychainItem(service: string): Promise<void> {
  await security(['delete-generic-password', '-a', account, '-s', service]);
  planted.delete(service);
}

/** Remove every item this process planted. Each suite calls it from `afterAll`. */
export async function removePlantedKeychainItems(): Promise<void> {
  for (const service of [...planted]) await removeKeychainItem(service);
}

/** Put `credential` in the store at `storeDirectory` the way this platform's Claude reads it. */
export async function plantClaudeCredential(storeDirectory: string, credential: string): Promise<void> {
  if (onMac) await plantKeychainItem(serviceFor(storeDirectory), credential);
  else await writeFile(path.join(storeDirectory, '.credentials.json'), credential, { mode: 0o600 });
}

/** The refresh token in a stored secret, which Claude may have written hex-encoded. */
export function refreshTokenIn(secret: string | undefined): string | undefined {
  if (secret === undefined) return undefined;
  const text = /^[0-9a-f]+$/i.test(secret) ? Buffer.from(secret, 'hex').toString('utf8') : secret;
  try {
    return (JSON.parse(text) as { claudeAiOauth?: { refreshToken?: string } }).claudeAiOauth?.refreshToken;
  } catch {
    return undefined;
  }
}

/**
 * Whether `security` finds `service` when run with `home` as HOME — a diagnostic, never a secret:
 * without `-w` it prints the item's attributes, not its password.
 */
export async function keychainVisibleFrom(home: string, service: string): Promise<string> {
  const found = await run(['/usr/bin/security', 'find-generic-password', '-a', account, '-s', service], {
    env: { PATH: '/usr/bin:/bin', HOME: home, USER: account },
  });
  return found.code === 0 ? 'found' : `not found (exit ${found.code}: ${found.stderr.trim().split('\n')[0] ?? ''})`;
}
