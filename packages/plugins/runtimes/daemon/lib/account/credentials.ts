// Where a Ferretry-kept login lives is LOGINS' fact (`LoginsApi.launchStores`): this module consumes it and never spells a store path.
/**
 * Where each credential of the account model is kept, and what a runtime needs to reach it
 * (docs/design/account-model.md §3.2 C1–C4, §8.1.1, §8.2.1).
 *
 * A credential is stored **exactly once** and never copied. Every runtime on it reaches that one store
 * through a mechanism its harness already honours, and the two harnesses need different ones:
 *
 * | harness | store      | what the runtime is given                                   | where the login lives                              |
 * | ------- | ---------- | ----------------------------------------------------------- | -------------------------------------------------- |
 * | claude  | `ferretry` | `CLAUDE_SECURESTORAGE_CONFIG_DIR=<the store Logins names>`  | that dir's `.credentials.json`, or on macOS the keychain item named from it |
 * | claude  | `host`     | `CLAUDE_SECURESTORAGE_CONFIG_DIR=""`                        | `<home>/.claude/.credentials.json`, or on macOS the bare keychain item |
 * | codex   | `ferretry` | the wrapper links `<runtime home>/auth.json` to the file Logins names (`signInFile`)       | Logins' own `auth.json`          |
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
import type { KitCredentialResolution, RuntimesHarnessKit } from '../../../contract/index.ts';
import { unsupportedHarnessSentence } from '../../../contract/harness-words.ts';
import { harnessKeyOfKind, isSupportedKind, supportedKindOfKey, UnsupportedHarnessError } from '../harness-kind.ts';
import type { HarnessKind } from '../manifest.ts';
import type { LoginLaunchStore } from '@ferretry/plugin-logins/contract';
import {
  cloudCredentialEnvironment,
  codexProviderArgs,
  codexProviderModelArgs,
  parseCloudCredential,
} from './environment.ts';
import { credentialHalf } from './halves.ts';
import type { Credential } from './schema.ts';

/** No stores named: a `ferretry` credential then has none to reach. */
const NO_STORES: ReadonlyMap<string, LoginLaunchStore> = new Map();

/** The file Claude keeps a credential in, inside its storage directory (the kit spells where; this is the name readers match). */
const CLAUDE_CREDENTIAL_FILE = '.credentials.json';

/** The file Codex keeps a credential in, inside its home. */
export const CODEX_CREDENTIAL_FILE = 'auth.json';

/**
 * The names a harness's sign-in lives in (Claude's, Codex's): the ONE list every reader and copier of a harness home
 * consults, so none keeps its own. A name is judged in any letter case.
 */
const SIGN_IN_FILES: ReadonlySet<string> = new Set([CLAUDE_CREDENTIAL_FILE, CODEX_CREDENTIAL_FILE]);

/** Whether `name` (any letter case) is the name of a harness's sign-in file. */
export const isSignInName = (name: string): boolean => SIGN_IN_FILES.has(name.toLowerCase());

/** The `config.toml` key, and its value, that keep every Codex runtime's credential in a file. */
export const CODEX_CREDENTIAL_STORE_KEY = 'cli_auth_credentials_store';
export const CODEX_CREDENTIAL_STORE_FILE = 'file';

/** The facts a store resolution needs from the machine. All absolute paths. */
export interface CredentialStorePaths {
  /** The person's REAL home: Claude's default store and Codex's default home are both under it. */
  readonly userHome: string;
  /**
   * The person's own Codex home, as {@link hostCodexHome} resolved it. Absent means it could not be
   * named, and a `host` Codex credential then has no file to share (fail closed).
   */
  readonly hostCodexHome?: string;
}

/**
 * A credential shared through ONE secure-storage variable (Claude's): the person's own (`host`) or Ferretry's (`ferretry`). The
 * harness's own plugin says where it lives.
 */
interface SecureStorageResolution {
  readonly harness: HarnessKind;
  readonly store: 'host' | 'ferretry';
  /** The exact value every runtime on this credential exports as its secure-storage variable. */
  readonly secureStorage: string;
  /** The directory the harness resolves that value to: the file store, and the `<dir>.lock` refresh lock. */
  readonly storageDirectory: string;
  /** Where the credential file is, wherever the platform keeps it in a file. */
  readonly credentialFile: string;
}

/**
 * A credential shared through a LINK in each runtime's home (Codex's `auth.json`). A `host` one is ONE canonical file every
 * runtime's own file links to (the provisioner places the link). A `ferretry` one has no `canonicalFile`: its file is Logins'
 * private one, which the provisioner may not link, so it names it as `signInFile` (what Logins said, never spelled here) and the
 * runtime's WRAPPER links to it each time a person runs it. Nothing reads, copies or shows the file.
 */
interface LinkedFileResolution {
  readonly harness: HarnessKind;
  readonly store: 'host' | 'ferretry';
  readonly canonicalFile?: string;
  /** A `ferretry` one: the file Logins named, which the wrapper links the runtime home's `auth.json` to. */
  readonly signInFile?: string;
}

/**
 * A credential that is no login at all: its own `env` authenticates every runtime on it, plus the
 * variable its cloud credential reference is handed over as and, for Codex, the launch flags that
 * point it at its model provider (`./environment.ts`).
 */
interface EnvironmentStoreResolution {
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

/**
 * A credential with no store a runtime can reach: its plugin is off or names none, a `host` Codex credential on a machine whose
 * Codex home cannot be named, or a `ferretry` one Logins names no store for. Nothing to share (fail closed).
 */
interface UnavailableStoreResolution {
  readonly harness: HarnessKind;
  readonly store: 'host' | 'ferretry';
  readonly unavailable: string;
}

/** A resolution that has a login on disk (or in a keychain) to read. */
type StoredCredentialResolution = SecureStorageResolution | LinkedFileResolution;

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

/**
 * Where a credential is kept, and what every runtime on it is given to reach it. `harness` picks the
 * half of an environment login that drives both CLIs (`./halves.ts`); left out, it is the login's own.
 *
 * A `ferretry` credential is kept where LOGINS says (`stores`, from `LoginsApi.launchStores`): never a path this module
 * spells, so a person-run wrapper and a ferret are signed in at the one store. Without Logins' answer it is unreachable.
 */
export function resolveCredentialStore(
  id: string,
  credential: Credential,
  paths: CredentialStorePaths,
  kits: ReadonlyMap<HarnessKind, RuntimesHarnessKit> | undefined,
  harness: HarnessKind = credential.harness,
  stores: ReadonlyMap<string, LoginLaunchStore> = NO_STORES,
): CredentialStoreResolution {
  if (credential.store === 'environment') return environmentResolution(credential, harness, paths.userHome);
  const store = credential.store;
  const kind = isSupportedKind(credential.harness) ? credential.harness : supportedKindOfKey(credential.harness);
  if (kind === undefined) throw new UnsupportedHarnessError(credential.harness);
  const kit = kits?.get(kind);
  if (kit?.credentialStore === undefined)
    return { harness: kind, store, unavailable: unsupportedHarnessSentence(harnessKeyOfKind(kind)) };
  const login = stores.get(id);
  const found = kit.credentialStore({
    store,
    userHome: paths.userHome,
    ...(store === 'ferretry'
      ? {
          variables: login?.variables ?? {},
          ...(login?.signInFile === undefined ? {} : { signInFile: login.signInFile }),
        }
      : {}),
    // The one host home a caller names today is the one `$CODEX_HOME` says; a kit that finds its own under `userHome` leaves it.
    ...(store === 'host' && kit.namesHostHome === true && paths.hostCodexHome !== undefined
      ? { hostHome: paths.hostCodexHome }
      : {}),
  });
  return storedResolution(kind, store, found);
}

/** A credential in a store, as its harness's own plugin says where it lives. A kit that names no store leaves it unreachable and says so. */
function storedResolution(
  harness: HarnessKind,
  store: 'host' | 'ferretry',
  found: KitCredentialResolution,
): CredentialStoreResolution {
  if (found.kind === 'unavailable') return { harness, store, unavailable: found.reason };
  if (found.kind === 'stored' && found.file !== undefined) {
    // A kit that names a secure-storage value shares by that variable; one that names only a file shares by a link to it.
    if (found.secureStorage === undefined)
      return store === 'host'
        ? { harness, store, canonicalFile: found.file }
        : { harness, store, signInFile: found.file };
    if (found.directory !== undefined)
      return {
        harness,
        store,
        secureStorage: found.secureStorage,
        storageDirectory: found.directory,
        credentialFile: found.file,
      };
  }
  return { harness, store, unavailable: 'its plugin named no store for it' };
}

/**
 * The variables a runtime on this credential exports, beyond its own config dir.
 *
 * What the harness's kit says: Claude's one secure-storage value (the empty string included, which is a value and not an
 * absence), nothing for Codex (its credential arrives through the link in its home). An environment credential gets its own
 * `env`. Never `HOME` (see the module note).
 */
export function credentialLaunchEnvironment(
  resolution: CredentialStoreResolution,
  kits: ReadonlyMap<HarnessKind, RuntimesHarnessKit> | undefined,
): Readonly<Record<string, string>> {
  if (resolution.store === 'environment') return resolution.env;
  if ('unavailable' in resolution) return {};
  // A stored resolution came from its harness's kit, so a kit with no way to name its variables is a wiring fault.
  const environment = kits?.get(resolution.harness)?.credentialEnvironment;
  if (environment === undefined)
    throw new UnsupportedHarnessError(
      isSupportedKind(resolution.harness) ? harnessKeyOfKind(resolution.harness) : String(resolution.harness),
    );
  const file =
    'secureStorage' in resolution ? resolution.credentialFile : (resolution.canonicalFile ?? resolution.signInFile);
  return environment({
    kind: 'stored',
    ...(file === undefined ? {} : { file }),
    ...('secureStorage' in resolution
      ? { directory: resolution.storageDirectory, secureStorage: resolution.secureStorage }
      : {}),
  });
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
  if (!('canonicalFile' in resolution) || resolution.canonicalFile === undefined) return undefined;
  return { path: join(runtimeHome, CODEX_CREDENTIAL_FILE), target: resolution.canonicalFile };
}

/**
 * The link a Codex runtime's WRAPPER makes when a person runs it: `auth.json` in the runtime home, pointing at the file Logins named
 * for a Ferretry-kept login. The provisioner cannot place it (Logins' file is outside every folder it may link into), so the wrapper
 * does, as the person who is about to run Codex. `undefined` when the credential has no such file.
 */
export function codexWrapperLink(
  runtimeHome: string,
  resolution: CredentialStoreResolution,
): CodexCredentialLink | undefined {
  if (!('signInFile' in resolution) || resolution.signInFile === undefined) return undefined;
  return { path: join(runtimeHome, CODEX_CREDENTIAL_FILE), target: resolution.signInFile };
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
