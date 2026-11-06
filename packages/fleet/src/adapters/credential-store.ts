/**
 * The credential store — where each harness keeps one home's provider login.
 *
 * Three storage shapes, all of them the harness's own and none of them this product's invention:
 *
 * | harness | platform | location                                           |
 * | ------- | -------- | -------------------------------------------------- |
 * | claude  | macOS    | keychain item `Claude Code-credentials[-<suffix>]` |
 * | claude  | macOS    | `<home>/.credentials.json`, when the keychain write failed |
 * | claude  | other    | `<home>/.credentials.json`                         |
 * | codex   | any      | `<home>/auth.json`                                 |
 *
 * where `<suffix>` is the first eight hex digits of `sha256(<home>)` — the name Claude Code derives
 * from its own config directory, which is why the home path must be the resolved absolute one.
 *
 * ## THE SUFFIX IS NOT UNCONDITIONAL, AND THAT COST THIS PRODUCT ITS FIRST-RUN SEED
 *
 * Claude Code appends `-<suffix>` **only when `CLAUDE_CONFIG_DIR` is set**; a default install
 * stores its credential under the bare name `Claude Code-credentials`. Every fleet account is
 * launched by a generated wrapper that exports that variable, so every fleet home is suffixed — but
 * the ONE home nobody launches that way is the operator's own `~/.claude`, which is precisely the
 * donor the first-run seed reads. Asking the keychain for a suffixed item there is asking for an
 * item that does not exist, so a host that was signed in produced a fleet that was not, and the
 * boot said `no-donor` about a login sitting on the same machine.
 *
 * So {@link keychainServices} returns the names the harness could have used for one home, most
 * specific first, and the bare name is offered ONLY for a home the harness reaches with no
 * `CLAUDE_CONFIG_DIR` set. It is deliberately not offered for every home: the bare item is the
 * default install's credential, and reading it for a fleet home would report an account as signed
 * in on somebody else's login and then let it donate that login to its siblings.
 *
 * ## MACOS IS KEYCHAIN-WITH-PLAINTEXT-FALLBACK, NOT KEYCHAIN-ONLY
 *
 * The harness composes the two stores on darwin: it reads the keychain and falls back to
 * `<home>/.credentials.json`, and it WRITES the file when the keychain write fails. A store that
 * looked only in the keychain therefore reported `missing` for a home that is signed in, which is
 * the hard negative that condemns a login. The fallback here is on ABSENCE — a keychain that could
 * not be read stays `unreadable`, because papering an unknown over with a file that may be the
 * credential the harness replaced is the mistake `unreadable` exists to prevent. The account-model
 * read makes ONE exception, the one Claude itself makes: `security` exit 36 (locked, or an approval no
 * window can show) is read past to the file, because that is where Claude both reads and writes then.
 *
 * ## THE ACCOUNT MODEL READS A CREDENTIAL BY ITS STORE, NOT BY A HOME
 *
 * A version-2 credential is kept once and every runtime reaches that one store (design §8.1.1,
 * §8.2.1), so {@link PlatformFleetCredentialStore.storedMaterial} reads by the resolution
 * `resolveCredentialStore` produced: for Claude, the ONE keychain item named from the
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` value (the bare item for `""`, the person's own login) and the
 * storage directory's file; for Codex, the canonical `auth.json`. Nothing in that path copies a
 * credential, and nothing links a Claude one.
 *
 * ## THAT ONE ITEM IS NAMED BY TWO ATTRIBUTES, AND READING BY ONE OF THEM SIGNED THE OWNER OUT
 *
 * Claude looks its item up by the PAIR (`acct`, `svce`): `find-generic-password -a <user> -w -s
 * <service>` (claude-code 2.1.296), where `<user>` is `$USER`, else the OS login name ({@link claudeKeychainAccount}). `security` asked by `-s` alone
 * answers with WHICHEVER item of that name it meets first — and a Mac that ever ran an older Ferretry
 * holds a second `Claude Code-credentials` beside the harness's, under another `acct`. Reading that stale copy, `storedMaterial` reported a login Claude
 * had just written as `missing`, and a web sign-in that succeeded ended with "no usable login was
 * written". So the account model reads with `-a` as well, and therefore reads exactly the item Claude
 * itself would read — never a stranger with the same name.
 *
 * **Credential material never leaves this adapter layer.** `read` returns a classification, so no
 * service, renderer or log line is ever handed a token. Nothing here writes a message containing
 * material, and the classifiers it calls are pure functions over it.
 *
 * **A failed read is not an empty home.** `security` exits 44 for "no such item", which is an absence;
 * every other non-zero exit — a locked keychain, a denied prompt, a timeout, a machine with no
 * `security` at all — is `unreadable`. That distinction is the whole reason a sibling's working
 * credential does not get overwritten by a read that merely failed.
 */
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CredentialMaterial,
  type CredentialReading,
  classifyCredential,
  type FleetCredentialStore,
  type FleetIdentityMember,
} from '../lib/identity.ts';
import type { HarnessKind } from '../lib/manifest.ts';
import type { StoredCredentialResolution } from '../lib/account/credentials.ts';
import type { CredentialStoreCheck, CredentialStoreInspection } from '../lib/account/store-inspection.ts';

/** What running one command produced. `stdout` may be credential material, so it is never logged. */
export interface CredentialCommandResult {
  readonly code: number;
  readonly stdout: string;
}

/**
 * Running one bounded command.
 *
 * A seam rather than a direct spawn because the macOS keychain cannot be exercised on any other
 * platform, and a test must be able to drive every exit code this store distinguishes.
 */
export interface CredentialCommand {
  run(command: readonly [string, ...string[]], timeoutMs: number): Promise<CredentialCommandResult>;
}

/** The exit code `security` uses for "the specified item could not be found in the keychain". */
export const KEYCHAIN_ITEM_NOT_FOUND = 44;

/** The exit code reported when the command could not be run, or its output could not be collected. */
export const COMMAND_FAILED = -1;

/**
 * `security` exits with the low byte of the keychain's status code. 36 is `errSecInteractionNotAllowed`
 * (-25308): the keychain is locked, or the read needs an approval and there is no window to show it in
 * — the answer a background service gets. Claude Code calls the same exit "keychain locked".
 */
export const KEYCHAIN_INTERACTION_NOT_ALLOWED = 36;

/** The other `security` exits a keychain read can end with, each its own remedy. */
const KEYCHAIN_FAILURES: Readonly<Record<number, string>> = {
  // errSecNoDefaultKeychain (-25307), errSecNoSuchKeychain (-25294), errSecNotAvailable (-25291).
  37: 'this user has no keychain the daemon can open',
  50: 'this user has no keychain the daemon can open',
  53: 'this user has no keychain the daemon can open',
  // errSecAuthFailed (-25293): the item's access list refused this reader.
  51: 'the keychain refused this read: the item’s access list does not allow it',
  // userCanceledErr (-128): somebody pressed Deny, or the prompt was dismissed.
  128: 'the keychain prompt for this read was denied or dismissed',
};

/**
 * Why one `security find-generic-password` failed, in words — the exit code kept, so a person can match
 * it against what `security` prints for them. Never called for 0 or 44.
 */
export function keychainReadFailure(code: number): string {
  if (code === COMMAND_FAILED) return 'the `security` command could not be run, or did not answer in time';
  if (code === KEYCHAIN_INTERACTION_NOT_ALLOWED) {
    return 'the keychain is locked, or reading it needs an approval that a background service cannot show (security exit 36)';
  }
  return `${KEYCHAIN_FAILURES[code] ?? 'the keychain read failed'} (security exit ${String(code)})`;
}

const DEFAULT_KEYCHAIN_TIMEOUT_MS = 5_000;

/**
 * Runs a command, bounded by a timer.
 *
 * The bound matters more than it looks: a locked keychain leaves `security` waiting on a GUI prompt
 * nobody is going to answer, and an unbounded read there hangs the whole fleet command.
 *
 * The deadline **returns** rather than only signalling the child, because killing it is not enough to
 * unblock the read. Anything the child spawned inherits the same stdout pipe, so the pipe can stay open
 * after the child is gone and a read waiting on end-of-stream would wait forever — which is exactly the
 * hang the bound exists to prevent. So the timeout races the read and wins: the result is a failure, and
 * the store reads a failure as unreadable rather than as a home with no credential.
 */
export class SpawnCredentialCommand implements CredentialCommand {
  async run(command: readonly [string, ...string[]], timeoutMs: number): Promise<CredentialCommandResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const spawned = Bun.spawn({
        cmd: [...command],
        stdout: 'pipe',
        stderr: 'ignore',
        stdin: 'ignore',
      });
      const collected = Promise.all([new Response(spawned.stdout).text(), spawned.exited]).then(([stdout, code]) => ({
        code,
        stdout,
      }));
      const expired = new Promise<CredentialCommandResult>(resolve => {
        timer = setTimeout(() => {
          spawned.kill('SIGKILL');
          resolve({ code: COMMAND_FAILED, stdout: '' });
        }, timeoutMs);
      });
      return await Promise.race([collected, expired]);
    } catch {
      // A binary this host does not have, or output that could not be collected. Both are "no
      // usable answer", which the store reads as unreadable rather than as an empty home.
      return { code: COMMAND_FAILED, stdout: '' };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface PlatformCredentialStoreDeps {
  /** The host platform, as `process.platform` names it. Injected so a test can be either. */
  readonly platform: string;
  readonly command: CredentialCommand;
  /** The clock classification compares an expiry against. */
  readonly now: () => number;
  /**
   * The keychain `acct` attribute Claude uses on this host: the one an account-model credential is READ
   * under (Claude looks its item up by `acct` and `svce` together). Supplied by the composition root,
   * which is the only place that may read the environment. It must never be empty: an empty `acct`
   * names no item the harness would look up.
   */
  readonly keychainAccount: string;
  /**
   * This host's DEFAULT Claude home — the one the harness reaches with no `CLAUDE_CONFIG_DIR` set,
   * and therefore the one whose keychain item carries no suffix. Absent means every home is treated
   * as configured, which is the fail-closed reading: it can cost a seed its donor, never send a read
   * to the wrong login.
   */
  readonly defaultClaudeHome?: string;
  readonly keychainTimeoutMs?: number;
}

/**
 * Read a file as credential material, keeping absence and unreadability apart.
 *
 * A file that is not there — and a path whose parent is not a directory, which `exists` also reports
 * as absent — is a home with no credential. A file that is there but cannot be read throws, and the
 * throw is deliberately not caught here: {@link FleetIdentityService} is the single place that turns an
 * exception into an `unreadable` reading, and catching it twice would mean two definitions of what
 * "could not be read" means.
 */
async function readFileMaterial(path: string): Promise<CredentialMaterial> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { outcome: 'absent' };
  const blob = (await file.text()).trim();
  return blob.length === 0 ? { outcome: 'absent' } : { outcome: 'found', blob };
}

/**
 * Read a Claude store's credential file, refusing one that is a symbolic link.
 *
 * A link there was planted by somebody — Ferretry never links a Claude credential (design §8.1.1) — and
 * the harness itself does not keep one: its first refresh forks the link into a private copy, and its
 * newest store reads a link as signed out. Reporting such a store as signed in would promise a sharing
 * that the next refresh silently undoes, so it is `unreadable`, with the reason.
 */
async function readClaudeStoreFile(path: string): Promise<CredentialMaterial> {
  const information = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
    throw error;
  });
  if (information?.isSymbolicLink() === true) {
    return {
      outcome: 'unreadable',
      reason:
        'the Claude credential file is a symbolic link, which Claude replaces with a private copy on its next refresh',
    };
  }
  return await readFileMaterial(path);
}

/** Why a file could not be read, by its error code alone — a message could quote a path, never a value, but a code is enough. */
function fileFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return `the file could not be read (${code ?? 'an unknown error'})`;
}

/**
 * Read one credential file and record what it held in `checked`. A read that throws is recorded as
 * unreadable and then thrown on, so a caller that wants the throw still gets it.
 */
async function checkedFile(
  path: string,
  read: (path: string) => Promise<CredentialMaterial>,
  checked: CredentialStoreCheck[],
): Promise<CredentialMaterial> {
  const location = `the file ${path}`;
  let material: CredentialMaterial;
  try {
    material = await read(path);
  } catch (error) {
    checked.push({ location, found: 'unreadable', why: fileFailure(error) });
    throw error;
  }
  if (material.outcome === 'found') checked.push({ location, found: 'present' });
  else if (material.outcome === 'absent') checked.push({ location, found: 'nothing' });
  else checked.push({ location, found: 'unreadable', why: material.reason });
  return material;
}

/**
 * This host's credential store.
 *
 * Every method is total: a missing home, an absent item, a locked keychain and a machine without
 * `security` all produce a value rather than an exception.
 */
export class PlatformFleetCredentialStore implements FleetCredentialStore {
  constructor(private readonly deps: PlatformCredentialStoreDeps) {}

  async read(kind: HarnessKind, member: FleetIdentityMember): Promise<CredentialReading> {
    return classifyCredential(kind, await this.#material(kind, member), this.deps.now());
  }

  /**
   * The raw credential for one home.
   *
   * **Adapter-to-adapter only.** The usage probe genuinely needs the bearer token — a classification
   * cannot be sent to a provider — and it is an adapter, so the material stays inside this layer. No
   * `src/lib` module and no service may call this: everything above the adapters is served by
   * {@link read}, which returns a verdict and never a secret.
   */
  async material(kind: HarnessKind, home: string): Promise<CredentialMaterial> {
    if (kind === 'codex') return await readFileMaterial(codexPath(home));
    if (this.deps.platform !== 'darwin') return await readFileMaterial(claudeFilePath(home));
    const keychain = await this.#readKeychain(home);
    // The harness's own darwin store is keychain-with-plaintext-fallback, so a home whose keychain
    // write failed is signed in and its credential is in the file. Absence only: a keychain that
    // could not be READ stays unreadable rather than being answered from a file beside it.
    return keychain.outcome === 'absent' ? await readFileMaterial(claudeFilePath(home)) : keychain;
  }

  /**
   * The raw credential of one account-model credential, read from its ONE store (design §8.1.1, §8.2.1).
   *
   * Adapter-to-adapter only, for the same reason as {@link material}. Claude's store is the keychain item
   * named from its secure-storage value on macOS — exactly one name, never a list, because the value
   * already says which login it is — and the storage directory's file everywhere else, and on macOS when
   * the keychain has no item (the harness's own fallback). Codex's is its canonical `auth.json`.
   */
  async storedMaterial(resolution: StoredCredentialResolution): Promise<CredentialMaterial> {
    return await this.#walkStored(resolution, []);
  }

  /**
   * {@link storedMaterial}, classified, with its trail: every place the store was looked in, and what each
   * held — so a sign-in that found no usable login can say WHERE it looked and WHY nothing there counted.
   *
   * Total: a file that throws is recorded as unreadable rather than thrown, because the trail up to that
   * point is exactly what the person needs. Names locations, never values.
   */
  async inspectStored(resolution: StoredCredentialResolution): Promise<CredentialStoreInspection> {
    const checked: CredentialStoreCheck[] = [];
    let material: CredentialMaterial;
    try {
      material = await this.#walkStored(resolution, checked);
    } catch (error) {
      material = { outcome: 'unreadable', reason: fileFailure(error) };
    }
    return { reading: classifyCredential(resolution.harness, material, this.deps.now()), checked };
  }

  /**
   * The one read every account-model reader shares, recording each place it looks in `checked`.
   *
   * Claude on macOS is read the way Claude itself reads it (claude-code 2.1.281 and 2.1.303, the darwin
   * build's keychain-with-plaintext-fallback store): the keychain item by the PAIR (`acct`, `svce`) — see
   * the module note — and then the storage directory's file when the item is ABSENT, or when `security`
   * exits 36. Claude reads 36 (the keychain is locked, or the read needs an approval no window can show)
   * as "no keychain item" and falls through to the file, and when its own keychain WRITE fails that way it
   * writes the file instead. A daemon started by launchd is exactly where that happens, so stopping at
   * `unreadable` there reported a login Claude had just written as not written. 36 with no file stays
   * unreadable, with the keychain's reason. Every other failure stops the walk, as before.
   */
  async #walkStored(
    resolution: StoredCredentialResolution,
    checked: CredentialStoreCheck[],
  ): Promise<CredentialMaterial> {
    if (resolution.harness === 'codex') return await checkedFile(resolution.canonicalFile, readFileMaterial, checked);
    let locked: CredentialMaterial | undefined;
    if (this.deps.platform === 'darwin') {
      const service = secureStorageKeychainService(resolution.secureStorage);
      const account = this.deps.keychainAccount;
      const { code, stdout } = await this.deps.command.run(
        ['security', 'find-generic-password', '-a', account, '-s', service, '-w'],
        this.#timeout(),
      );
      const location = `the keychain item "${service}" (account "${account}")`;
      const blob = code === 0 ? stdout.trim() : '';
      if (blob.length > 0) {
        checked.push({ location, found: 'present' });
        return { outcome: 'found', blob };
      }
      if (code === 0 || code === KEYCHAIN_ITEM_NOT_FOUND) checked.push({ location, found: 'nothing' });
      else {
        const why = keychainReadFailure(code);
        checked.push({ location, found: 'unreadable', why });
        if (code !== KEYCHAIN_INTERACTION_NOT_ALLOWED) return { outcome: 'unreadable', reason: why };
        locked = { outcome: 'unreadable', reason: why };
      }
    }
    const file = await checkedFile(resolution.credentialFile, readClaudeStoreFile, checked);
    return file.outcome === 'absent' && locked !== undefined ? locked : file;
  }

  async #material(kind: HarnessKind, member: FleetIdentityMember): Promise<CredentialMaterial> {
    return await this.material(kind, member.home);
  }

  /**
   * Read the first keychain item this home could have been written under.
   *
   * Every name is tried in order and the first item that EXISTS answers, however it answers: an item
   * that is there but unreadable is this home's credential and stops the walk, because falling
   * through to the next name would answer a locked keychain with a different login's credential.
   * Only "no such item" moves on, and running out of names is an absence.
   */
  async #readKeychain(home: string): Promise<CredentialMaterial> {
    let material: CredentialMaterial = { outcome: 'absent' };
    for (const service of this.#services(home)) {
      material = await this.#readKeychainItem(service);
      if (material.outcome !== 'absent') return material;
    }
    return material;
  }

  /**
   * One keychain item's material: the first item of that name, which is only right where nothing else
   * could carry the name (the legacy per-home path).
   */
  async #readKeychainItem(service: string): Promise<CredentialMaterial> {
    const { code, stdout } = await this.deps.command.run(
      ['security', 'find-generic-password', '-s', service, '-w'],
      this.#timeout(),
    );
    if (code === KEYCHAIN_ITEM_NOT_FOUND) return { outcome: 'absent' };
    if (code !== 0) {
      return { outcome: 'unreadable', reason: `the keychain read for this home failed (exit ${code})` };
    }
    const blob = stdout.trim();
    return blob.length === 0 ? { outcome: 'absent' } : { outcome: 'found', blob };
  }

  #services(home: string): readonly [string, ...string[]] {
    return keychainServices(home, this.deps.defaultClaudeHome);
  }

  #timeout(): number {
    return this.deps.keychainTimeoutMs ?? DEFAULT_KEYCHAIN_TIMEOUT_MS;
  }
}

/** The item name Claude Code uses when no `CLAUDE_CONFIG_DIR` names a home for it. */
export const DEFAULT_KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** The keychain item name Claude Code derives from a CONFIGURED config directory. */
export function keychainService(home: string): string {
  return `${DEFAULT_KEYCHAIN_SERVICE}-${createHash('sha256').update(home).digest('hex').slice(0, 8)}`;
}

/**
 * The keychain item Claude reads for one `CLAUDE_SECURESTORAGE_CONFIG_DIR` value — MEASURED on macOS
 * (design §8.1.1, gap G1): the bare item for the empty value, which is the person's own login, and
 * otherwise the bare name suffixed with the first eight hex digits of `sha256` of the value in NFC.
 *
 * The hash is over the value exactly as exported, so the value a wrapper exports and the value this
 * reads must be one string — which is why both come from `resolveCredentialStore`.
 */
export function secureStorageKeychainService(secureStorage: string): string {
  return secureStorage.length === 0 ? DEFAULT_KEYCHAIN_SERVICE : keychainService(secureStorage.normalize('NFC'));
}

/**
 * Every keychain item name this home's credential could be under, most specific first.
 *
 * Two, and only for the default home: the harness appends its `sha256(home)` suffix only when
 * `CLAUDE_CONFIG_DIR` is set, so a default install stores its login under the bare name. The
 * suffixed name still comes first there, because an operator who exports `CLAUDE_CONFIG_DIR` at
 * their own default home makes the suffixed item the real one and it must win.
 *
 * Any other home gets exactly one name. Offering the bare name everywhere would let a fleet account
 * with no credential of its own read the OPERATOR's login, report itself signed in, and then donate
 * that login to its siblings — a single wrong read turning into a fleet-wide one.
 */
export function keychainServices(home: string, defaultHome?: string): readonly [string, ...string[]] {
  const configured = keychainService(home);
  return defaultHome !== undefined && normalizeHome(home) === normalizeHome(defaultHome)
    ? [configured, DEFAULT_KEYCHAIN_SERVICE]
    : [configured];
}

/** Trailing separators only: the hash is over the harness's own string, so nothing else may move. */
const normalizeHome = (home: string): string => home.replace(/\/+$/u, '');

/** What Claude Code falls back to when it can name neither `$USER` nor this host's login name. */
export const FALLBACK_KEYCHAIN_ACCOUNT = 'claude-code-user';

/**
 * The keychain `acct` Claude Code itself uses on this host — its own rule, spelled out (claude-code
 * 2.1.281 and 2.1.303 alike): `$USER` when it is set to anything, otherwise the OS login name, and
 * {@link FALLBACK_KEYCHAIN_ACCOUNT} when that lookup throws or the name is outside its alphabet.
 *
 * **`LOGNAME` is not in it, and neither is falling back to `claude-code-user` while a login name
 * exists.** A daemon started by launchd or systemd is handed a bare environment, so `USER` can be unset
 * there; the Claude child it launches then names its item after the OS login name. Reading with
 * `$USER` / `LOGNAME` there asked for `claude-code-user` — an item Claude
 * never writes — and a sign-in that had just written the login ended "no usable login was written".
 *
 * `loginName` is the composition root's `os.userInfo().username`, passed in because the root is the only
 * place that may read the host.
 */
export function claudeKeychainAccount(user: string | undefined, loginName: () => string): string {
  let named: string;
  try {
    named = user !== undefined && user.length > 0 ? user : loginName();
  } catch {
    return FALLBACK_KEYCHAIN_ACCOUNT;
  }
  return HARNESS_KEYCHAIN_ACCOUNT.test(named) ? named : FALLBACK_KEYCHAIN_ACCOUNT;
}

/** The account names Claude Code accepts as a keychain `acct`; anything else becomes its fallback. */
const HARNESS_KEYCHAIN_ACCOUNT = /^[a-zA-Z0-9._-]+$/u;

/** Where Claude Code keeps its credential when there is no keychain. */
export function claudeFilePath(home: string): string {
  return join(home, '.credentials.json');
}

/** Where Codex keeps its credential, on every platform. */
export function codexPath(home: string): string {
  return join(home, 'auth.json');
}
