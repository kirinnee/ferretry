import { join } from 'node:path';
import type {
  KitCredentialInput,
  KitCredentialResolution,
  RuntimesHarnessKit,
} from '@ferretry/plugin-runtimes/contract';

/** The file Codex keeps a credential in, inside its home. */
const CREDENTIAL_FILE = 'auth.json';

/**
 * Where a Codex credential lives. The person's own (`host`) is `auth.json` in their own Codex home, and with no home to name
 * (`CODEX_HOME` is a relative path) there is no file to share (fail closed). A `ferretry` login lives in the file Logins names,
 * and with no answer there is no store to reach. Either way a runtime reaches it through a link in its own home, never a copy.
 */
function credentialStore(input: KitCredentialInput): KitCredentialResolution {
  if (input.store === 'environment') return { kind: 'environment', env: input.env ?? {} };
  if (input.store === 'host') {
    if (input.hostHome === undefined)
      return {
        kind: 'unavailable',
        reason: 'your own Codex home could not be named, because CODEX_HOME is set to a relative path',
      };
    return { kind: 'stored', file: join(input.hostHome, CREDENTIAL_FILE) };
  }
  if (input.signInFile === undefined || input.signInFile.length === 0)
    return { kind: 'unavailable', reason: 'Logins names no store for it' };
  return { kind: 'stored', file: input.signInFile };
}

/** Codex gets nothing from its credential store: its login arrives through the link in its home. An environment login gets its own `env`. */
function credentialEnvironment(resolution: KitCredentialResolution): Readonly<Record<string, string>> {
  return resolution.kind === 'environment' ? resolution.env : {};
}

/** Where Codex's credential lives, as Runtimes asks for it. */
export const codexCredentialsKit: RuntimesHarnessKit = { credentialStore, credentialEnvironment, namesHostHome: true };
