/**
 * The OpenPGP half of a Git account's signing key: one ISOLATED `GNUPGHOME` per account, in the same private folder the
 * ssh-agents live in, so a ferret signs as the account with a keyring that is not the person's own (`~/.gnupg`) and not
 * any other account's. This module owns the facts about GnuPG; the service decides what to do with them.
 *
 * - The secret key reaches gpg on `--import`'s STDIN and nowhere else: not an argument, not the environment. It leaves
 *   gpg only on a `--export-secret-keys` stdout that goes straight into the sealed document.
 * - Both programs (`gpg`, `gpgconf`) run by the absolute path the locator found OUTSIDE the state home, and with none found
 *   nothing starts and no key is read (the same rule as `ssh-add`).
 * - GnuPG has no equivalent of an ssh-agent that holds a key out of reach of its caller: gpg-agent keeps the key file in
 *   `private-keys-v1.d` of the home it serves. A ferret is therefore handed the HOME and signs with it, and a process of the
 *   same user could read that file. That is a declared GAP (docs/secrets.md, "A Git account's GPG key"); what holds is
 *   that no route, port or log returns the key, and no OTHER account's or the person's keyring is reachable from it.
 */
import type { Log, SpawnPort } from '@ferretry/kernel/contract';
import { ApiError } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import { GIT_ACCOUNT_CODES, type GitAccountId } from '../../../contract/index.ts';
import type { TrustedLaunch } from '../../lib/program-locator.ts';
import type { RunFolder } from '../ssh-keys/agents.ts';

/** What a launch is told: paths and a fingerprint. Nothing here is key material. */
export interface GpgKit {
  /** The account's isolated `GNUPGHOME`. */
  readonly home: string;
  /** The key's fingerprint, for `user.signingkey`. */
  readonly fingerprint: string;
  /** The absolute path of the real `gpg`, for `gpg.program`. */
  readonly program: string;
}

/** What a key is, once gpg has read it back: the fingerprint and both armored halves. The secret half is sealed at once. */
export interface GpgMaterial {
  readonly fingerprint: string;
  readonly secretKey: string;
  readonly publicKey: string;
}

/** Who the key's user id names: GitHub marks a commit Verified when the committer address is one of the key's. */
export interface GpgIdentity {
  readonly name: string;
  readonly email: string;
}

export interface GpgPrograms {
  gpg(): Promise<TrustedLaunch>;
  gpgconf(): Promise<TrustedLaunch>;
}

const TIMEOUT = milliseconds(30_000);
/** `S.gpg-agent` is made inside the home when there is no `/run/user`; a unix socket path is limited (108 on Linux). */
const MAX_AGENT_PATH = 100;
const FINGERPRINT = /^[A-F0-9]{40}$/u;

const unavailable = (): ApiError =>
  new ApiError(503, 'the GPG key for this Git account could not be set up', GIT_ACCOUNT_CODES.agentUnavailable);
const refused = (message: string): ApiError => new ApiError(400, message, GIT_ACCOUNT_CODES.invalidRequest);

/** A name that gpg reads as one user-id: no angle brackets, no control characters. */
const plainName = (text: string): string =>
  text
    .replace(/[<>\p{Cc}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

export class GnupgHomes {
  /** Accounts whose home holds the key THIS run (a ferret that outlived a restart finds the same path again). */
  readonly #ready = new Map<GitAccountId, string>();
  readonly #known = new Set<GitAccountId>();

  constructor(
    private readonly spawn: Pick<SpawnPort, 'run'>,
    private readonly folder: RunFolder,
    private readonly log: Pick<Log, 'warn'>,
    private readonly programs: GpgPrograms,
  ) {}

  homePath(id: GitAccountId): string {
    return `${this.folder.path}/${id}.gnupg`;
  }

  /** Makes a new ed25519 signing key for `identity` in an empty home and returns both halves. */
  async generate(id: GitAccountId, identity: GpgIdentity): Promise<GpgMaterial> {
    const gpg = await this.#fresh(id);
    const user = `${plainName(identity.name) || identity.email} <${identity.email}>`;
    const made = await this.#gpg(gpg, id, [
      '--batch',
      '--pinentry-mode',
      'loopback',
      '--passphrase',
      '',
      '--quick-generate-key',
      user,
      'ed25519',
      'cert,sign',
      'never',
    ]);
    if (made.exitCode !== 0) throw this.#failed(id, 'gpg could not make a key');
    return await this.#settle(gpg, id, undefined);
  }

  /**
   * Takes a key the person hands over: it is read into an empty home, must be ONE key that can sign and needs no
   * passphrase (a signing run proves it), and gains a user id for the account's noreply address when it has none (GitHub
   * only calls a commit Verified when its committer address is one of the key's).
   */
  async receive(id: GitAccountId, secretKey: string, identity: GpgIdentity): Promise<GpgMaterial> {
    const gpg = await this.#fresh(id);
    const imported = await this.#gpg(gpg, id, ['--batch', '--import'], secretKey);
    if (imported.exitCode !== 0) throw this.#failed(id, 'that is not a usable OpenPGP secret key', 400);
    return await this.#settle(gpg, id, identity);
  }

  /**
   * The account's kit, loading the sealed key into its home when this run has not yet. Loading empties the home first, so
   * what is in it is exactly the sealed key.
   */
  async kit(id: GitAccountId, secretKey: string): Promise<GpgKit> {
    const gpg = await this.programs.gpg().catch(() => {
      throw unavailable();
    });
    const loaded = this.#ready.get(id);
    if (loaded !== undefined) return { home: this.homePath(id), fingerprint: loaded, program: gpg.program };
    await this.#emptied(id);
    const imported = await this.#gpg(gpg, id, ['--batch', '--import'], secretKey);
    if (imported.exitCode !== 0) throw this.#failed(id, 'the sealed key could not be loaded');
    const material = await this.#settle(gpg, id, undefined);
    return { home: this.homePath(id), fingerprint: material.fingerprint, program: gpg.program };
  }

  /** Ends the account's gpg-agent and removes its home (the key leaves memory and disk with it). */
  async forget(id: GitAccountId): Promise<void> {
    await this.#kill(id);
    this.#ready.delete(id);
    this.#known.delete(id);
    await this.folder.remove(`${id}.gnupg`).catch(() => undefined);
  }

  /** The daemon is stopping: every account's agent ends. The homes stay: a running ferret's paths must keep their meaning. */
  async stopAll(): Promise<void> {
    for (const id of [...this.#known]) await this.#kill(id);
    this.#ready.clear();
  }

  async #fresh(id: GitAccountId): Promise<TrustedLaunch> {
    const gpg = await this.programs.gpg().catch(() => {
      throw unavailable();
    });
    await this.#emptied(id);
    return gpg;
  }

  /** The home exists, is empty and private; the agent that served the old contents is ended first. */
  async #emptied(id: GitAccountId): Promise<void> {
    if (
      `${this.folder.path}/gha_99999999999999999999.gnupg/S.gpg-agent.extra`.length > MAX_AGENT_PATH ||
      !(await this.folder.isPrivate())
    ) {
      this.log.warn('git-accounts: the key folder is not private or its path is too long for gpg-agent');
      throw unavailable();
    }
    await this.#kill(id);
    this.#ready.delete(id);
    await this.folder.emptyDirectory(`${id}.gnupg`, 0o700);
    this.#known.add(id);
  }

  /**
   * The key in the home, made ready: the one sign-capable key (its fingerprint), trusted, with a user id for the account's
   * address, proven to sign without a passphrase, and exported back (the sealed copy is what a restart loads).
   */
  async #settle(gpg: TrustedLaunch, id: GitAccountId, identity: GpgIdentity | undefined): Promise<GpgMaterial> {
    let fingerprint = await this.#fingerprint(gpg, id);
    if (identity !== undefined && !(await this.#hasAddress(gpg, id, fingerprint, identity.email))) {
      const added = await this.#gpg(gpg, id, [
        '--batch',
        '--pinentry-mode',
        'error',
        '--quick-add-uid',
        fingerprint,
        `${plainName(identity.name) || identity.email} <${identity.email}>`,
      ]);
      if (added.exitCode !== 0)
        throw refused('that key could not be given this account’s address (does it need a passphrase?)');
      fingerprint = await this.#fingerprint(gpg, id);
    }
    const trusted = await this.#gpg(gpg, id, ['--batch', '--import-ownertrust'], `${fingerprint}:6:\n`);
    if (trusted.exitCode !== 0) throw this.#failed(id, 'gpg could not trust the key');
    // A key that asks for a passphrase cannot sign for a ferret that has no terminal: found out here, in words.
    const proof = await this.#gpg(
      gpg,
      id,
      ['--batch', '--pinentry-mode', 'error', '--detach-sign', '--local-user', fingerprint],
      'proof\n',
    );
    if (proof.exitCode !== 0) throw refused('that key could not sign: it needs a passphrase, or it cannot sign');
    const secret = await this.#gpg(gpg, id, ['--batch', '--armor', '--export-secret-keys', fingerprint]);
    const pub = await this.#gpg(gpg, id, ['--batch', '--armor', '--export', fingerprint]);
    if (secret.exitCode !== 0 || pub.exitCode !== 0 || !secret.stdout.includes('PRIVATE KEY BLOCK'))
      throw this.#failed(id, 'gpg could not export the key');
    this.#ready.set(id, fingerprint);
    return { fingerprint, secretKey: secret.stdout, publicKey: pub.stdout };
  }

  /** The fingerprint of the account's ONE sign-capable secret key, or a refusal. */
  async #fingerprint(gpg: TrustedLaunch, id: GitAccountId): Promise<string> {
    const listed = await this.#gpg(gpg, id, ['--batch', '--list-secret-keys', '--with-colons', '--with-fingerprint']);
    if (listed.exitCode !== 0) throw this.#failed(id, 'gpg could not list the key');
    const rows = listed.stdout.split('\n').map(line => line.split(':'));
    const primaries = rows.filter(row => row[0] === 'sec');
    if (primaries.length !== 1) throw refused('give one OpenPGP secret key, not several');
    const first = rows.findIndex(row => row[0] === 'sec');
    const fingerprint = rows.slice(first + 1).find(row => row[0] === 'fpr')?.[9] ?? '';
    const capabilities = (primaries[0]?.[11] ?? '').toLowerCase();
    if (!FINGERPRINT.test(fingerprint)) throw this.#failed(id, 'gpg named no fingerprint');
    if (!capabilities.includes('s')) throw refused('that OpenPGP key cannot sign');
    return fingerprint;
  }

  async #hasAddress(gpg: TrustedLaunch, id: GitAccountId, fingerprint: string, email: string): Promise<boolean> {
    const listed = await this.#gpg(gpg, id, ['--batch', '--list-keys', '--with-colons', fingerprint]);
    return listed.stdout
      .split('\n')
      .filter(line => line.startsWith('uid:'))
      .some(line => (line.split(':')[9] ?? '').toLowerCase().includes(`<${email.toLowerCase()}>`));
  }

  async #kill(id: GitAccountId): Promise<void> {
    if (!this.#known.has(id)) return;
    try {
      const conf = await this.programs.gpgconf();
      await this.spawn.run(conf.program, ['--kill', 'gpg-agent'], {
        sealed: true,
        env: { GNUPGHOME: this.homePath(id), PATH: conf.path },
        timeout: milliseconds(10_000),
      });
    } catch {
      this.log.warn('git-accounts: an account gpg-agent could not be asked to stop', { account: id });
    }
  }

  async #gpg(gpg: TrustedLaunch, id: GitAccountId, args: readonly string[], stdin?: string) {
    try {
      return await this.spawn.run(gpg.program, args, {
        sealed: true,
        env: { GNUPGHOME: this.homePath(id), PATH: gpg.path },
        ...(stdin === undefined ? {} : { stdin }),
        timeout: TIMEOUT,
      });
    } catch {
      throw unavailable();
    }
  }

  #failed(id: GitAccountId, message: string, status = 503): ApiError {
    // Nothing gpg said is kept: its stderr can quote the key. The account and the step are enough to find it.
    this.log.warn('git-accounts: gpg refused a step for an account key', { account: id, step: message });
    return status === 400 ? refused(message) : unavailable();
  }
}
