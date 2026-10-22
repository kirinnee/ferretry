/**
 * Where each credential of the account model is kept, and what a runtime needs to reach it
 * (docs/design/account-model.md §3.2 C1–C4, §8.1.1, §8.2.1).
 *
 * A credential is stored **exactly once** and never copied. Every runtime on it reaches that one store
 * through a mechanism its harness already honours, and the two harnesses need different ones:
 *
 * | harness | store      | what the runtime is given                                   | where the login lives                              |
 * | ------- | ---------- | ----------------------------------------------------------- | -------------------------------------------------- |
 * | claude  | `ferretry` | `CLAUDE_SECURESTORAGE_CONFIG_DIR=<fleet>/credentials/<id>`  | that dir's `.credentials.json`, or on macOS the keychain item named from it |
 * | claude  | `host`     | `CLAUDE_SECURESTORAGE_CONFIG_DIR=""`                        | `<home>/.claude/.credentials.json`, or on macOS the bare keychain item |
 * | codex   | `ferretry` | `<runtime home>/auth.json` linked to `<fleet>/credentials/<id>/auth.json` | the canonical file                    |
 * | codex   | `host`     | `<runtime home>/auth.json` linked to the person's own `auth.json`         | `$CODEX_HOME/auth.json`, else `<home>/.codex/auth.json` |
 * | either  | `environment` | the credential's own `env`                               | nowhere on disk                                    |
 *
 * MEASURED, and the measurement wins over the design where they differed:
 *
 * - **`host` is the EMPTY string for Claude, never the absolute `~/.claude`.** The harness reads an
 *   empty value as "the default store": the bare keychain item on macOS and `<home>/.claude` on every
 *   platform for the file. An explicit path would hash to a different keychain item than the one the
 *   person's own `claude` uses, and sign the runtime in to nothing.
 * - **A Claude credential is never linked.** Claude writes its store by temp-file-and-rename, so the
 *   first refresh forks a link into a private copy, and its newest store reads a link as signed out.
 *   Sharing is the secure-storage variable and nothing else; this module has no Claude link to offer.
 * - **The launch keeps the person's real `HOME`.** On macOS Claude finds the login keychain through the
 *   search list under the real `~/Library`, so a runtime launched with a different `HOME` reads no
 *   keychain at all and reports signed out; on Linux the `host` file is under `HOME` too. The runtime's
 *   config dir (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) is what isolates it, which is why nothing here
 *   ever names `HOME`.
 * - **Codex is kept on file storage.** A runtime's `config.toml` forces
 *   `cli_auth_credentials_store = "file"`, because a credential moved into a keyring is one no link can
 *   follow.
 *
 * Pure: paths in, paths and names out. The keychain item name is a hash of the storage directory and
 * is computed by the credential-store adapter, which is where every platform fact is applied.
 */
import { isAbsolute, join } from 'node:path';
import type { HarnessKind } from '../manifest.ts';
import { CREDENTIALS_DIRECTORY, ferretryCredentialDirectory } from './credential-directory.ts';
import {
  cloudCredentialEnvironment,
  codexProviderArgs,
  codexProviderModelArgs,
  parseCloudCredential,
} from './environment.ts';
import { credentialHalf } from './halves.ts';
import type { Credential } from './schema.ts';

export { CREDENTIALS_DIRECTORY, ferretryCredentialDirectory };

/** The undocumented variable that moves Claude's credential store away from its config dir (§9.5). */
export const CLAUDE_SECURE_STORAGE_VARIABLE = 'CLAUDE_SECURESTORAGE_CONFIG_DIR';

/** The secure-storage value that selects the person's OWN Claude login: empty, never a path. */
export const HOST_CLAUDE_SECURE_STORAGE = '';

/** The file Claude keeps a credential in, inside its storage directory. */
export const CLAUDE_CREDENTIAL_FILE = '.credentials.json';

/** The file Codex keeps a credential in, inside its home. */
export const CODEX_CREDENTIAL_FILE = 'auth.json';

/** The `config.toml` key, and its value, that keep every Codex runtime's credential in a file. */
export const CODEX_CREDENTIAL_STORE_KEY = 'cli_auth_credentials_store';
export const CODEX_CREDENTIAL_STORE_FILE = 'file';

/** The facts a store resolution needs from the machine. All absolute paths. */
export interface CredentialStorePaths {
  /** `<FY_HOME>/fleet`. */
  readonly fleetRoot: string;
  /** The person's REAL home: Claude's default store and Codex's default home are both under it. */
  readonly userHome: string;
  /**
   * The person's own Codex home, as {@link hostCodexHome} resolved it. Absent means it could not be
   * named, and a `host` Codex credential then has no file to share (fail closed).
   */
  readonly hostCodexHome?: string;
}

/** A Claude credential kept in a store: the person's own (`host`) or Ferretry's (`ferretry`). */
export interface ClaudeStoreResolution {
  readonly harness: 'claude';
  readonly store: 'host' | 'ferretry';
  /** The exact value every runtime on this credential exports as {@link CLAUDE_SECURE_STORAGE_VARIABLE}. */
  readonly secureStorage: string;
  /** The directory Claude resolves that value to: the file store, and the `<dir>.lock` refresh lock. */
  readonly storageDirectory: string;
  /** Where the credential file is, wherever the platform keeps it in a file. */
  readonly credentialFile: string;
  /** A directory Ferretry must create (0700) before a sign-in can write into it; absent for `host`. */
  readonly ownedDirectory?: string;
}

/** A Codex credential kept in ONE canonical `auth.json`; every runtime's own `auth.json` links to it. */
export interface CodexStoreResolution {
  readonly harness: 'codex';
  readonly store: 'host' | 'ferretry';
  readonly canonicalFile: string;
  readonly ownedDirectory?: string;
}

/**
 * A credential that is no login at all: its own `env` authenticates every runtime on it, plus the
 * variable its cloud credential reference is handed over as and, for Codex, the launch flags that
 * point it at its model provider (`./environment.ts`).
 */
export interface EnvironmentStoreResolution {
  readonly harness: HarnessKind;
  readonly store: 'environment';
  /** A secret travels as a `${secret:NAME}` reference, never a value. */
  readonly env: Readonly<Record<string, string>>;
  /** Launch arguments every runtime on it starts with: Codex's `-c model_provider…` flags. */
  readonly args?: readonly string[];
  /** Why it cannot launch, when its Codex provider cannot be put together from its variables. */
  readonly problem?: string;
  /** The flags that start it on its Codex provider's own model, used when the profile names none. */
  readonly modelArgs?: readonly string[];
}

/** A `host` Codex credential on a machine whose Codex home cannot be named: nothing to share. */
export interface UnavailableStoreResolution {
  readonly harness: 'codex';
  readonly store: 'host';
  readonly unavailable: string;
}

/** A resolution that has a login on disk (or in a keychain) to read. */
export type StoredCredentialResolution = ClaudeStoreResolution | CodexStoreResolution;

/** Where one credential's login lives and how a runtime reaches it. */
export type CredentialStoreResolution =
  | StoredCredentialResolution
  | EnvironmentStoreResolution
  | UnavailableStoreResolution;

/**
 * The person's own Codex home, resolved the way Codex itself resolves it: `CODEX_HOME` when it is set
 * to something, else `<home>/.codex`.
 *
 * A RELATIVE `CODEX_HOME` returns `undefined`. Codex would read it against the directory the person's
 * shell was in, which the daemon cannot know, and guessing would link a runtime to some other file.
 */
export function hostCodexHome(codexHomeVariable: string | undefined, userHome: string): string | undefined {
  const named = codexHomeVariable?.trim() ?? '';
  if (named.length === 0) return join(userHome, '.codex');
  return isAbsolute(named) ? join(named) : undefined;
}

/** The person's own Codex `auth.json`, or `undefined` when their Codex home cannot be named. */
export function hostCodexCredentialFile(codexHomeVariable: string | undefined, userHome: string): string | undefined {
  const home = hostCodexHome(codexHomeVariable, userHome);
  return home === undefined ? undefined : join(home, CODEX_CREDENTIAL_FILE);
}

/**
 * The directory Claude reads its store from for one secure-storage value.
 *
 * The harness's own rule: the value itself, or `<home>/.claude` when it is empty, in Unicode NFC. The
 * NFC matters because the macOS keychain item name is a hash of this exact string.
 */
export function claudeStorageDirectory(secureStorage: string, userHome: string): string {
  return (secureStorage.length > 0 ? secureStorage : join(userHome, '.claude')).normalize('NFC');
}

/**
 * Where a credential is kept, and what every runtime on it is given to reach it. `harness` picks the
 * half of an environment login that drives both CLIs (`./halves.ts`); left out, it is the login's own.
 */
export function resolveCredentialStore(
  id: string,
  credential: Credential,
  paths: CredentialStorePaths,
  harness: HarnessKind = credential.harness,
): CredentialStoreResolution {
  if (credential.store === 'environment') return environmentResolution(credential, harness, paths.userHome);
  const owned = credential.store === 'ferretry' ? ferretryCredentialDirectory(paths.fleetRoot, id) : undefined;
  if (credential.harness === 'claude') {
    const secureStorage = owned ?? HOST_CLAUDE_SECURE_STORAGE;
    const storageDirectory = claudeStorageDirectory(secureStorage, paths.userHome);
    return {
      harness: 'claude',
      store: credential.store,
      secureStorage,
      storageDirectory,
      credentialFile: join(storageDirectory, CLAUDE_CREDENTIAL_FILE),
      ...(owned === undefined ? {} : { ownedDirectory: owned }),
    };
  }
  if (owned !== undefined) {
    return {
      harness: 'codex',
      store: 'ferretry',
      canonicalFile: join(owned, CODEX_CREDENTIAL_FILE),
      ownedDirectory: owned,
    };
  }
  return paths.hostCodexHome === undefined
    ? {
        harness: 'codex',
        store: 'host',
        unavailable: 'your own Codex home could not be named, because CODEX_HOME is set to a relative path',
      }
    : { harness: 'codex', store: 'host', canonicalFile: join(paths.hostCodexHome, CODEX_CREDENTIAL_FILE) };
}

/**
 * The variables a runtime on this credential exports, beyond its own config dir.
 *
 * Claude gets its one secure-storage value — the empty string included, which is a value and not an
 * absence. Codex gets nothing: its credential arrives through the link in its home. An environment
 * credential gets its own `env`. Never `HOME` (see the module note).
 */
export function credentialLaunchEnvironment(resolution: CredentialStoreResolution): Readonly<Record<string, string>> {
  if (resolution.store === 'environment') return resolution.env;
  if (resolution.harness === 'claude') return { [CLAUDE_SECURE_STORAGE_VARIABLE]: resolution.secureStorage };
  return {};
}

/** The link one Codex runtime's home holds: its own `auth.json`, pointing at the canonical file. */
export interface CodexCredentialLink {
  readonly path: string;
  readonly target: string;
}

/** The link a Codex runtime with this home needs, or `undefined` when its credential is not a file. */
export function codexCredentialLink(
  runtimeHome: string,
  resolution: CredentialStoreResolution,
): CodexCredentialLink | undefined {
  if (resolution.harness !== 'codex' || !('canonicalFile' in resolution)) return undefined;
  return { path: join(runtimeHome, CODEX_CREDENTIAL_FILE), target: resolution.canonicalFile };
}

/**
 * An environment credential, resolved for one CLI: that half's variables, its cloud reference's
 * variable, its Codex flags. A CLI the login does not drive gets no variables — the runtime that asked
 * was refused by the schema, so only a hand-built model reaches that.
 */
function environmentResolution(
  credential: Credential,
  harness: HarnessKind,
  userHome: string,
): EnvironmentStoreResolution {
  const half = credentialHalf(credential, harness);
  const own = half?.env ?? {};
  const codexProvider = half?.codexProvider;
  const reference =
    credential.cloudCredential === undefined ? undefined : parseCloudCredential(credential.cloudCredential);
  const env = { ...own, ...(reference === undefined ? {} : cloudCredentialEnvironment(reference, userHome)) };
  const provider = codexProvider === undefined ? undefined : codexProviderArgs(codexProvider, own);
  return {
    harness,
    store: 'environment',
    env,
    ...(provider !== undefined && 'args' in provider ? { args: provider.args } : {}),
    ...(provider !== undefined && 'problem' in provider ? { problem: provider.problem } : {}),
    ...(codexProvider?.model === undefined ? {} : { modelArgs: codexProviderModelArgs(codexProvider.model) }),
  };
}

/**
 * The launch arguments a runtime on this credential starts with, before its profile's own: its Codex
 * model provider, and that provider's model when the runtime's profile names none.
 */
export function credentialLaunchArguments(
  resolution: CredentialStoreResolution,
  profileNamesModel = false,
): readonly string[] {
  if (resolution.store !== 'environment') return [];
  return [...(resolution.args ?? []), ...(profileNamesModel ? [] : (resolution.modelArgs ?? []))];
}
