import { join } from 'node:path';
import type {
  KitCredentialInput,
  KitCredentialResolution,
  RuntimesHarnessKit,
} from '@ferretry/plugin-runtimes/contract';

/** The undocumented variable that moves Claude's credential store away from its config dir. */
const SECURE_STORAGE_VARIABLE = 'CLAUDE_SECURESTORAGE_CONFIG_DIR';

/** The secure-storage value that selects the person's OWN Claude login: empty, never a path. */
const HOST_SECURE_STORAGE = '';

/** The file Claude keeps a credential in, inside its storage directory. */
const CREDENTIAL_FILE = '.credentials.json';

/**
 * The directory Claude reads its store from for one secure-storage value: the value itself, or `<home>/.claude` when it is
 * empty, in Unicode NFC (the macOS keychain item name is a hash of this exact string).
 */
const storageDirectory = (secureStorage: string, userHome: string): string =>
  (secureStorage.length > 0 ? secureStorage : join(userHome, '.claude')).normalize('NFC');

const stored = (secureStorage: string, userHome: string): KitCredentialResolution => {
  const directory = storageDirectory(secureStorage, userHome);
  return { kind: 'stored', directory, file: join(directory, CREDENTIAL_FILE), secureStorage };
};

/**
 * Where a Claude credential lives. `host` is the EMPTY secure-storage value, never the absolute `~/.claude` (the harness reads
 * empty as "the default store"; a path would hash to a different keychain item than the person's own `claude` uses). A
 * `ferretry` login lives where Logins says, and with no answer there is no store to reach. A Claude credential is never linked:
 * Claude writes its store by temp-file-and-rename, so sharing is the secure-storage variable and nothing else.
 */
function credentialStore(input: KitCredentialInput): KitCredentialResolution {
  if (input.store === 'environment') return { kind: 'environment', env: input.env ?? {} };
  if (input.store === 'host') return stored(HOST_SECURE_STORAGE, input.userHome);
  const secureStorage = input.variables?.[SECURE_STORAGE_VARIABLE];
  if (secureStorage === undefined || secureStorage.length === 0)
    return { kind: 'unavailable', reason: 'Logins names no store for it' };
  return stored(secureStorage, input.userHome);
}

/** Claude gets its one secure-storage value, the empty string included: that is a value, not an absence. Never `HOME`. */
function credentialEnvironment(resolution: KitCredentialResolution): Readonly<Record<string, string>> {
  if (resolution.kind === 'environment') return resolution.env;
  if (resolution.kind === 'unavailable') return {};
  return { [SECURE_STORAGE_VARIABLE]: resolution.secureStorage ?? HOST_SECURE_STORAGE };
}

/** Where Claude's credential lives, as Runtimes asks for it. */
export const claudeCredentialsKit: RuntimesHarnessKit = { credentialStore, credentialEnvironment };
