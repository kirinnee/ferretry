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
 * the hard negative that condemns a login. The fallback here is on ABSENCE only — a keychain that
 * could not be read stays `unreadable`, because papering an unknown over with a file that may be
 * the credential the harness replaced is the mistake `unreadable` exists to prevent.
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
import { createHash } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CredentialCloneOutcome,
  type CredentialMaterial,
  type CredentialReading,
  classifyCredential,
  type FleetCredentialStore,
  type FleetIdentityMember,
} from '../lib/identity.ts';
import type { HarnessKind } from '../lib/manifest.ts';

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
  async run(command: readonly [string, ...string[]], timeoutMs: number): Promise<CredentialCommandResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const spawned = Bun.spawn({ cmd: [...command], stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
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
   * The keychain `acct` attribute to use when the item being written does not exist yet and the donor
   * item does not name one. Supplied by the composition root, which is the only place that may read
   * the environment. See {@link harnessKeychainAccount} for why it must never be empty.
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

/** Write credential material with an owner-only mode, on a fresh file and on an existing one alike. */
async function writeCredentialFile(path: string, blob: string): Promise<void> {
  await writeFile(path, blob, { mode: CREDENTIAL_FILE_MODE });
  await chmod(path, CREDENTIAL_FILE_MODE);
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  const material = await readFileMaterial(path);
  if (material.outcome !== 'found') return undefined;
  try {
    const parsed = JSON.parse(material.blob) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
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

  async #material(kind: HarnessKind, member: FleetIdentityMember): Promise<CredentialMaterial> {
    return await this.material(kind, member.home);
  }

  async #write(kind: HarnessKind, target: FleetIdentityMember, blob: string): Promise<CredentialCloneOutcome> {
    if (kind === 'claude' && this.deps.platform === 'darwin') return await this.#writeKeychain(target.home, blob);
    // A write that fails throws: the service turns that into a refusal with the underlying reason,
    // and duplicating the conversion here would mean two definitions of a failed copy.
    await writeCredentialFile(kind === 'codex' ? codexPath(target.home) : claudeFilePath(target.home), blob);
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
   * Add or update the target's keychain item.
   *
   * The material is passed as an argument, which is how `security` accepts it and therefore how this
   * is done at all; it is briefly visible to anyone who can already enumerate this user's running
   * commands, which on a single-user host is the same person who can read the keychain.
   */
  async #writeKeychain(home: string, blob: string): Promise<CredentialCloneOutcome> {
    const { service, account } = await this.#writeTarget(home);
    const { code } = await this.deps.command.run(
      ['security', 'add-generic-password', '-U', '-a', account, '-s', service, '-w', blob],
      this.#timeout(),
    );
    return code === 0 ? { ok: true } : { ok: false, reason: `the keychain write failed (exit ${code})` };
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
   */
  async #copyOauthAccount(donorHome: string, targetHome: string): Promise<void> {
    try {
      const donor = await readJsonObject(claudeConfigPath(donorHome));
      if (donor?.oauthAccount === undefined) return;
      const path = claudeConfigPath(targetHome);
      const target = (await readJsonObject(path)) ?? {};
      await writeFile(path, `${JSON.stringify({ ...target, oauthAccount: donor.oauthAccount }, null, 2)}\n`);
    } catch {
      /* display-only metadata — never fail a completed credential copy over it */
    }
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
    if (named.length > 0) return named;
  }
  return FALLBACK_KEYCHAIN_ACCOUNT;
}

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
