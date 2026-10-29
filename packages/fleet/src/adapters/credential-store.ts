/**
 * The credential store — where each harness keeps one home's provider login, and how a credential is
 * copied from one home to another.
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
 * storage directory's file; for Codex, the canonical `auth.json`. {@link FileCredentialStoreLinks}
 * puts each Codex runtime's link in place. Nothing in that path copies a credential, and nothing links
 * a Claude one.
 *
 * ## THAT ONE ITEM IS NAMED BY TWO ATTRIBUTES, AND READING BY ONE OF THEM SIGNED THE OWNER OUT
 *
 * Claude looks its item up by the PAIR (`acct`, `svce`): `find-generic-password -a <user> -w -s
 * <service>` (claude-code 2.1.296), where `<user>` is `$USER`, else the OS login name ({@link claudeKeychainAccount}). `security` asked by `-s` alone
 * answers with WHICHEVER item of that name it meets first — and a Mac that ever ran an older Ferretry
 * holds a second `Claude Code-credentials` beside the harness's, under another `acct` (see
 * {@link harnessKeychainAccount}). Reading that stale copy, `storedMaterial` reported a login Claude
 * had just written as `missing`, and a web sign-in that succeeded ended with "no usable login was
 * written". So the account model reads with `-a` as well, and therefore reads exactly the item Claude
 * itself would read — never a stranger with the same name.
 *
 * **Credential material never leaves this adapter layer.** `read` returns a classification and `clone` copies
 * end to end, so no service, renderer or log line is ever handed a token. Nothing here writes a
 * message containing material, and the classifiers it calls are pure functions over it.
 *
 * **A failed read is not an empty home.** `security` exits 44 for "no such item", which is an absence;
 * every other non-zero exit — a locked keychain, a denied prompt, a timeout, a machine with no
 * `security` at all — is `unreadable`. That distinction is the whole reason a sibling's working
 * credential does not get overwritten by a read that merely failed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readlink, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  type CredentialCloneOutcome,
  type CredentialMaterial,
  type CredentialReading,
  classifyCredential,
  type FleetCredentialStore,
  type FleetIdentityMember,
} from '../lib/identity.ts';
import type { HarnessKind } from '../lib/manifest.ts';
import type { CodexCredentialLink, StoredCredentialResolution } from '../lib/account/credentials.ts';
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
 *
 * `stdin`, when given, is written to the child and closed. It is how material reaches a command
 * without being in its argument list, which any local process can read.
 */
export interface CredentialCommand {
  run(command: readonly [string, ...string[]], timeoutMs: number, stdin?: string): Promise<CredentialCommandResult>;
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

const CREDENTIAL_FILE_MODE = 0o600;
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
  async run(
    command: readonly [string, ...string[]],
    timeoutMs: number,
    stdin?: string,
  ): Promise<CredentialCommandResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const spawned = Bun.spawn({
        cmd: [...command],
        stdout: 'pipe',
        stderr: 'ignore',
        stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
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
   * under (Claude looks its item up by `acct` and `svce` together), and the one written when the item
   * being written does not exist yet and the donor item does not name one. Supplied by the composition
   * root, which is the only place that may read the environment. See {@link harnessKeychainAccount} for
   * why it must never be empty.
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

/** The `acct` attribute in `security find-generic-password` attribute output. */
const KEYCHAIN_ACCOUNT_PATTERN = /"acct"<blob>="([^"]*)"/;

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
 * Replace a file with owner-only content, atomically, and never through a link.
 *
 * The content goes to a temporary file created exclusively at the final mode and is then renamed over
 * the destination, so a crash or a harness refreshing the same credential at the same moment leaves
 * the old file or the new one and never a truncated credential. A destination that is a symlink is
 * refused rather than replaced: somebody linked it on purpose — a home sharing one login file — and
 * neither writing through the link nor silently breaking it is this copy's decision to make.
 */
async function replaceOwnerOnlyFile(path: string, content: string): Promise<void> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink() === true) {
    throw new Error(`${path} is a symbolic link, so it was left as it is rather than replaced`);
  }
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: CREDENTIAL_FILE_MODE });
    // `wx` honours the umask, which can only narrow; this pins the mode the harness expects.
    await chmod(temporary, CREDENTIAL_FILE_MODE);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
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

/** A harness config file, read for a merge: absent, a JSON object, or something that is neither. */
type JsonObjectReading =
  | { readonly kind: 'absent' }
  | { readonly kind: 'object'; readonly value: Record<string, unknown> }
  | { readonly kind: 'unusable' };

async function readJsonObject(path: string): Promise<JsonObjectReading> {
  const material = await readFileMaterial(path);
  if (material.outcome !== 'found') return { kind: 'absent' };
  try {
    const parsed = JSON.parse(material.blob) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { kind: 'object', value: parsed as Record<string, unknown> }
      : { kind: 'unusable' };
  } catch {
    return { kind: 'unusable' };
  }
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
   * Copy the donor's credential onto the target.
   *
   * The donor is re-read and re-classified here, not trusted from the survey that chose it. A
   * credential can change between the two, and this is the last point at which a copy can be refused:
   * cloning something that is no longer usable turns one broken lane into every lane.
   */
  async clone(
    kind: HarnessKind,
    donor: FleetIdentityMember,
    target: FleetIdentityMember,
  ): Promise<CredentialCloneOutcome> {
    const material = await this.#material(kind, donor);
    if (material.outcome !== 'found') {
      return { ok: false, reason: 'the donor credential could not be read at copy time' };
    }
    const reading = classifyCredential(kind, material, this.deps.now());
    if (reading.state !== 'valid' && reading.state !== 'refreshable') {
      return { ok: false, reason: `the donor credential is no longer usable (${reading.state})` };
    }

    const written = await this.#write(kind, target, material.blob);
    if (!written.ok) return written;
    if (kind === 'claude') await this.#copyOauthAccount(donor.home, target.home);
    return { ok: true };
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

  /** {@link storedMaterial}, classified: the verdict, never the secret. */
  async readStored(resolution: StoredCredentialResolution): Promise<CredentialReading> {
    return classifyCredential(resolution.harness, await this.storedMaterial(resolution), this.deps.now());
  }

  /**
   * {@link readStored} with its trail: every place the store was looked in, and what each held — so a
   * sign-in that found no usable login can say WHERE it looked and WHY nothing there counted.
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

  async #write(kind: HarnessKind, target: FleetIdentityMember, blob: string): Promise<CredentialCloneOutcome> {
    if (kind === 'claude' && this.deps.platform === 'darwin') return await this.#writeKeychain(target.home, blob);
    // A write that fails throws: the service turns that into a refusal with the underlying reason,
    // and duplicating the conversion here would mean two definitions of a failed copy.
    await replaceOwnerOnlyFile(kind === 'codex' ? codexPath(target.home) : claudeFilePath(target.home), blob);
    return { ok: true };
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

  /**
   * Add or update the target's keychain item, with the material never in an argument list.
   *
   * `security add-generic-password -w <blob>` put the credential in argv, where `ps` shows it to every
   * local process for as long as the command runs. So the command is handed to `security -i` on its
   * standard input instead, carrying the material hex-encoded through `-X` so no quoting of the
   * credential is ever needed; only the item's name and `acct` are quoted, and one that cannot be
   * quoted safely is refused.
   *
   * `security -i` does not reliably report a command that failed through its own exit status, so the
   * write is then PROVED by reading the item back under the same (`acct`, `svce`) pair and comparing
   * — inside this adapter, where the material already is.
   */
  async #writeKeychain(home: string, blob: string): Promise<CredentialCloneOutcome> {
    const { service, account } = await this.#writeTarget(home);
    const line = keychainWriteLine(account, service, blob);
    if (line === undefined) {
      return {
        ok: false,
        reason: 'the keychain write was refused, because it could not be made without exposing the credential',
      };
    }
    const { code } = await this.deps.command.run(['security', '-i'], this.#timeout(), line);
    if (code !== 0) return { ok: false, reason: `the keychain write failed (exit ${code})` };
    const stored = await this.deps.command.run(
      ['security', 'find-generic-password', '-a', account, '-s', service, '-w'],
      this.#timeout(),
    );
    return stored.code === 0 && stored.stdout.trim() === blob
      ? { ok: true }
      : { ok: false, reason: `the keychain write could not be confirmed (exit ${stored.code})` };
  }

  /**
   * Which item to write, and under whose `acct`.
   *
   * `add-generic-password -U` matches on the PAIR (`acct`, `svce`), so both halves have to be the
   * ones the harness itself uses or the write silently adds a second item beside the harness's
   * instead of updating it — after which this store's own `-s` read can return either one. An
   * existing item therefore decides both: its name is the name this home is already stored under,
   * and its `acct` is the one the harness will look the item up by.
   */
  async #writeTarget(home: string): Promise<{ readonly service: string; readonly account: string }> {
    const services = this.#services(home);
    for (const service of services) {
      const { code, stdout } = await this.deps.command.run(
        ['security', 'find-generic-password', '-s', service],
        this.#timeout(),
      );
      if (code !== 0) continue;
      const found = KEYCHAIN_ACCOUNT_PATTERN.exec(stdout)?.[1];
      return { service, account: found !== undefined && found.length > 0 ? found : this.deps.keychainAccount };
    }
    return { service: services[0], account: this.deps.keychainAccount };
  }

  /**
   * Copy the donor's `oauthAccount` — the email and organization the harness displays — onto the
   * target, so `/status` and usage attribution name the account the credential actually belongs to.
   *
   * Display metadata only. A failure here is swallowed: the credential copy already succeeded, and
   * reporting the wrong email is not worth undoing a working login over.
   *
   * The target is MERGED into, so it is written only when it is absent or parsed as a JSON object. A
   * file that is there but unreadable as one — damaged, mid-edit, or a format this build does not
   * know — holds the harness's projects, trust decisions and MCP servers, and replacing it with
   * `{ oauthAccount }` would delete all of them to fix a display name. It is left byte for byte.
   */
  async #copyOauthAccount(donorHome: string, targetHome: string): Promise<void> {
    try {
      const donor = await readJsonObject(claudeConfigPath(donorHome));
      if (donor.kind !== 'object' || donor.value.oauthAccount === undefined) return;
      const path = claudeConfigPath(targetHome);
      const target = await readJsonObject(path);
      if (target.kind === 'unusable') return;
      const merged = { ...(target.kind === 'object' ? target.value : {}), oauthAccount: donor.value.oauthAccount };
      await replaceOwnerOnlyFile(path, `${JSON.stringify(merged, null, 2)}\n`);
    } catch {
      /* display-only metadata — never fail a completed credential copy over it */
    }
  }

  #timeout(): number {
    return this.deps.keychainTimeoutMs ?? DEFAULT_KEYCHAIN_TIMEOUT_MS;
  }
}

/**
 * The longest command line handed to `security -i`. Its interactive reader takes a line into a fixed
 * buffer of a few kilobytes, and a line cut short there would store a truncated credential — so a
 * longer one is refused, never split and never moved back into an argument.
 */
export const KEYCHAIN_INTERACTIVE_LINE_LIMIT = 4_000;

/** An `acct` or `svce` value that a double-quoted `security -i` word carries literally. */
const KEYCHAIN_QUOTABLE = /^[^"'\\\r\n]+$/u;

/**
 * The `security -i` line that writes one keychain item, or `undefined` when it cannot be written safely.
 *
 * The material travels as `-X <hex>`, which has nothing to quote. The two names are double-quoted, and
 * a name holding a quote, a backslash or a line break is refused rather than escaped, because the
 * escaping rules of that reader are not a contract anyone publishes.
 */
export function keychainWriteLine(account: string, service: string, blob: string): string | undefined {
  if (!KEYCHAIN_QUOTABLE.test(account) || !KEYCHAIN_QUOTABLE.test(service)) return undefined;
  const hex = Buffer.from(blob, 'utf8').toString('hex');
  const line = `add-generic-password -U -a "${account}" -s "${service}" -X ${hex}\n`;
  return line.length <= KEYCHAIN_INTERACTIVE_LINE_LIMIT ? line : undefined;
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
 * The `acct` attribute to store a keychain item under, from the environment names the harness reads.
 *
 * IT MUST NEVER BE EMPTY, and it used to be: the composition roots passed `USER ?? ''`, and
 * `security add-generic-password -U` matches on the pair (`acct`, `svce`) — so an empty `acct` does
 * not update the harness's item, it adds a second one beside it under the same service name. A
 * later `-s`-only read then returns whichever of the two the keychain yields first, which is how a
 * home that had just been signed in could keep reading as the stale copy this store wrote.
 *
 * Pure, and takes candidates rather than reading them: the composition root owns the environment.
 * `claude-code-user` is the harness's own last resort, spelled the same way here so that a host with
 * no `USER` at all still agrees with it.
 */
export function harnessKeychainAccount(candidates: readonly (string | undefined)[]): string {
  for (const candidate of candidates) {
    const named = candidate?.trim() ?? '';
    // The harness falls back to its own name for an account outside this alphabet, so this does too:
    // an item stored under a name the harness would never look up is a login it cannot see.
    if (named.length > 0) return HARNESS_KEYCHAIN_ACCOUNT.test(named) ? named : FALLBACK_KEYCHAIN_ACCOUNT;
  }
  return FALLBACK_KEYCHAIN_ACCOUNT;
}

/**
 * The keychain `acct` Claude Code itself uses on this host — its own rule, spelled out (claude-code
 * 2.1.281 and 2.1.303 alike): `$USER` when it is set to anything, otherwise the OS login name, and
 * {@link FALLBACK_KEYCHAIN_ACCOUNT} when that lookup throws or the name is outside its alphabet.
 *
 * **`LOGNAME` is not in it, and neither is falling back to `claude-code-user` while a login name
 * exists.** A daemon started by launchd or systemd is handed a bare environment, so `USER` can be unset
 * there; the Claude child it launches then names its item after the OS login name. Reading with
 * {@link harnessKeychainAccount}`([USER, LOGNAME])` there asked for `claude-code-user` — an item Claude
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

/** The harness config file that carries the displayed account identity. */
export function claudeConfigPath(home: string): string {
  return join(home, '.claude.json');
}

const CREDENTIAL_DIRECTORY_MODE = 0o700;

/** What putting one Codex runtime's credential link in place did. */
export type CodexLinkOutcome =
  | { readonly ok: true; readonly change: 'linked' | 'unchanged' | 'relinked' }
  | { readonly ok: false; readonly reason: string };

/**
 * Making a credential's store reachable on disk: Ferretry's own store directory, and each Codex
 * runtime's link to its one canonical `auth.json` (design §8.2.1).
 *
 * There is deliberately no Claude counterpart to {@link linkCodex}: a Claude runtime reaches its store
 * through `CLAUDE_SECURESTORAGE_CONFIG_DIR`, and a linked Claude credential is forked by its first
 * refresh. Nothing here ever copies a credential, and nothing here ever deletes one.
 */
export class FileCredentialStoreLinks {
  /** Create a `store: ferretry` credential's directory, owner-only, so a sign-in has somewhere to write. */
  async prepare(resolution: StoredCredentialResolution): Promise<void> {
    if (resolution.ownedDirectory === undefined) return;
    await mkdir(resolution.ownedDirectory, { recursive: true, mode: CREDENTIAL_DIRECTORY_MODE });
    await chmod(resolution.ownedDirectory, CREDENTIAL_DIRECTORY_MODE);
  }

  /**
   * Point one Codex runtime's `auth.json` at the canonical file, by absolute path.
   *
   * A link that already points there is left alone; a link to another credential — the runtime was
   * moved to a different login — is replaced atomically (a new link renamed over it). A REGULAR file is
   * refused: it is a credential of its own, and replacing it would delete a login. Moving one into a
   * store is migration's job, never a link's. The canonical file need not exist yet: an empty slot is
   * linked before its sign-in, and Codex writes through the link.
   */
  async linkCodex(link: CodexCredentialLink): Promise<CodexLinkOutcome> {
    const existing = await lstat(link.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing === undefined) {
      await symlink(link.target, link.path);
      return { ok: true, change: 'linked' };
    }
    if (!existing.isSymbolicLink()) {
      return {
        ok: false,
        reason: `${link.path} holds a credential of its own, so it was left as it is rather than replaced by a link`,
      };
    }
    if ((await readlink(link.path)) === link.target) return { ok: true, change: 'unchanged' };
    const temporary = join(dirname(link.path), `.${basename(link.path)}.${randomUUID()}.tmp`);
    try {
      await symlink(link.target, temporary);
      await rename(temporary, link.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return { ok: true, change: 'relinked' };
  }
}
