/**
 * The SSH key of a Git account: made here, registered at GitHub by its PUBLIC half, and used through an ssh-agent.
 * One ed25519 key per account serves `auth` (push and pull over SSH) and `signing` (signed commits): two registrations
 * of the same public key. The private half is sealed in `keys.json` and leaves it only on `ssh-add -`'s stdin.
 */
import { ApiError } from '@ferretry/kernel/contract';
import type { SealedDocumentHandle, SealedName } from '@ferretry/core-vault/contract';
import {
  GIT_ACCOUNT_CODES,
  type GitAccount,
  type GitAccountId,
  type GitAccountKey,
  type GitAccountKeys,
  type GitApiAnswer,
  type GitApiCall,
  type GitKeyKind,
  type GitKeyRemoved,
  type GitKeyRequest,
  type GitKeyResult,
  isGpgKey,
} from '../../../contract/index.ts';
import type { AccountKit } from '../launch/environment.ts';
import type { AgentSupervisor } from './agents.ts';
import { generateEd25519, parsePublicKey } from './openssh.ts';

/** What the key feature needs from the account service: nothing that returns a token. */
export interface KeyAccounts {
  find(id: GitAccountId): Promise<GitAccount | undefined>;
  api(id: GitAccountId, call: GitApiCall): Promise<GitApiAnswer>;
  recordKeys(id: GitAccountId, keys: GitAccountKeys): Promise<void>;
}

/** The two registrations: the record's slot, and where GitHub keeps each. */
const KINDS = {
  auth: { slot: 'ssh', path: '/user/keys' },
  signing: { slot: 'signing', path: '/user/ssh_signing_keys' },
} as const satisfies Record<GitKeyKind, { slot: 'ssh' | 'signing'; path: string }>;

interface SealedKey {
  readonly privateKey: string;
  readonly publicKey: string;
  readonly fingerprint: string;
}

const kindsOf = (purpose: GitKeyRequest['purpose']): readonly GitKeyKind[] =>
  purpose === 'both' ? ['auth', 'signing'] : [purpose];

/** A GitHub key title: plain printable characters, the machine's name after `Ferretry`. */
function titleFor(machine: string): string {
  const plain = machine.replace(/[^\x20-\x7e]/gu, '?').trim();
  return `Ferretry ${plain === '' ? 'machine' : plain}`.slice(0, 200);
}

const refused = (message: string, code: string = GIT_ACCOUNT_CODES.keyRefused, status = 409): ApiError =>
  new ApiError(status, message, code);

export class SshKeyService {
  readonly #queues = new Map<GitAccountId, Promise<unknown>>();

  constructor(
    private readonly accounts: KeyAccounts,
    private readonly sealed: SealedDocumentHandle,
    private readonly agents: AgentSupervisor,
    private readonly machineName: () => string,
  ) {}

  /** Makes (or reuses) the account's key and registers it for `purpose`; or records a key the person already has. */
  create(id: GitAccountId, request: GitKeyRequest): Promise<GitKeyResult> {
    return this.#serial(id, async () => {
      const account = await this.#account(id);
      return request.publicKey === undefined
        ? await this.#createOwn(account, request.purpose)
        : await this.#recordOwn(account, request.purpose, request.publicKey);
    });
  }

  /** Takes one registration off the account at GitHub and out of the record; the key itself goes when none is left. */
  remove(id: GitAccountId, kind: GitKeyKind): Promise<GitKeyRemoved> {
    return this.#serial(id, async () => {
      const account = await this.#account(id);
      const { slot, path } = KINDS[kind];
      const key = account.keys[slot];
      if (key === undefined) throw new ApiError(404, 'this account has no such key', GIT_ACCOUNT_CODES.unknownAccount);
      // A key the person already had is only forgotten here: it was never ours to delete at GitHub.
      if (key.source !== 'own' && key.githubKeyId !== undefined) {
        const answer = await this.accounts.api(id, { method: 'DELETE', path: `${path}/${key.githubKeyId}` });
        if (answer.status !== 204 && answer.status !== 404)
          throw refused('GitHub did not delete the key; try again', GIT_ACCOUNT_CODES.providerRefused, 502);
      }
      const left = without(account.keys, slot);
      await this.accounts.recordKeys(id, left);
      // The sealed SSH key goes with its last SSH registration (a GPG signing key is not one).
      if ([left.ssh, left.signing].every(each => each === undefined || isGpgKey(each))) await this.#dropOwnKey(id);
      return { id, purpose: kind, removed: true };
    });
  }

  /** The socket of the agent holding this account's Ferretry-made key; `undefined` without one. */
  agentSocket(id: GitAccountId): Promise<string | undefined> {
    return this.#serial(id, async () => {
      const account = await this.accounts.find(id);
      const made = [account?.keys.ssh, account?.keys.signing].some(
        key => key !== undefined && key.source !== 'own' && !isGpgKey(key),
      );
      if (!made) return undefined;
      return await this.agents.socketFor(id, async () => (await this.#sealedKey(id))?.privateKey);
    });
  }

  /**
   * What a ferret's launch is handed for this account: its agent's socket and the files beside it (paths only; a public
   * key file, the pinned `known_hosts`). `undefined` without a key Ferretry made (the person's own key is the host's
   * agent's to hold, and a ferret is not given the host's socket).
   */
  launchKit(id: GitAccountId): Promise<AccountKit | undefined> {
    return this.#serial(id, async () => {
      const account = await this.accounts.find(id);
      const auth = account?.keys.ssh?.source === 'generated';
      const signing = account?.keys.signing?.source === 'generated' && !isGpgKey(account.keys.signing);
      // No key Ferretry made: nothing to hand over, and the launch is what it always was.
      if (!auth && !signing) return undefined;
      const publicKey = (auth ? account?.keys.ssh : account?.keys.signing)?.publicKey;
      const socket =
        publicKey === undefined
          ? undefined
          : await this.agents.socketFor(id, async () => (await this.#sealedKey(id))?.privateKey);
      // A key IS recorded but cannot be served (its sealed entry is gone, or its agent will not start): that is said, never
      // answered as "no key", which would let the launch fall back silently to the machine's own ssh identity.
      if (publicKey === undefined || socket === undefined)
        throw new ApiError(
          503,
          'the ssh-agent for this Git account could not be started',
          GIT_ACCOUNT_CODES.agentUnavailable,
        );
      return {
        socket,
        publicKeyFile: await this.agents.publicKeyFile(id, publicKey),
        knownHosts: await this.agents.knownHostsFile(),
        auth,
        signing,
      };
    });
  }

  /**
   * At boot: every account with a key Ferretry made gets its agent back at its own path, so a ferret that outlived a
   * daemon restart or update finds its `SSH_AUTH_SOCK` where it left it. One that cannot start is skipped, said in the log.
   */
  async warm(ids: readonly GitAccountId[], log: (id: GitAccountId) => void): Promise<void> {
    for (const id of ids)
      await this.launchKit(id).catch(() => {
        log(id);
        return undefined;
      });
  }

  /** The account is going: stop its agent and forget the private key. */
  forget(id: GitAccountId): Promise<void> {
    return this.#serial(id, () => this.#dropOwnKey(id));
  }

  async #createOwn(account: GitAccount, purpose: GitKeyRequest['purpose']): Promise<GitKeyResult> {
    const wanted = kindsOf(purpose);
    let key = await this.#sealedKey(account.id);
    const fresh = key === undefined;
    if (key === undefined) {
      const made = generateEd25519(titleFor(this.machineName()));
      key = { privateKey: made.privateKey, publicKey: made.publicKey, fingerprint: made.fingerprint };
      await this.sealed.put(account.id as SealedName, JSON.stringify(key));
    }
    let keys: GitAccountKeys = account.keys;
    let registeredNow = 0;
    try {
      for (const kind of wanted) {
        const { slot, path } = KINDS[kind];
        const held = keys[slot];
        if (held !== undefined) {
          if (held.source !== 'own' && held.fingerprint === key.fingerprint) continue;
          throw refused(`this account already has a ${kind} key; remove it first`);
        }
        const title = titleFor(this.machineName());
        const answer = await this.accounts.api(account.id, {
          method: 'POST',
          path,
          body: { title, key: key.publicKey.split(' ').slice(0, 2).join(' ') },
        });
        const githubKeyId = githubIdOf(answer);
        if (githubKeyId === undefined) throw providerFailure(answer.status);
        const entry: GitAccountKey = {
          githubKeyId,
          title,
          publicKey: key.publicKey,
          fingerprint: key.fingerprint,
          source: 'generated',
        };
        keys = { ...keys, [slot]: entry };
        await this.accounts.recordKeys(account.id, keys);
        registeredNow += 1;
      }
    } catch (error) {
      // A key made for this call that GitHub never took (and the record never named) must not stay sealed.
      if (fresh && keys.ssh === undefined && keys.signing === undefined && registeredNow === 0)
        await this.sealed.delete(account.id as SealedName).catch(() => undefined);
      throw error;
    }
    return {
      publicKey: key.publicKey,
      fingerprint: key.fingerprint,
      registered: registrations(keys, key.fingerprint),
      source: 'generated',
    };
  }

  /** "I already have a key on GitHub": confirm the account holds it, record the public half, ask for nothing else. */
  async #recordOwn(account: GitAccount, purpose: GitKeyRequest['purpose'], line: string): Promise<GitKeyResult> {
    const parsed = parsePublicKey(line);
    if (parsed === undefined) throw refused('that is not an OpenSSH public key', GIT_ACCOUNT_CODES.invalidRequest, 400);
    let keys: GitAccountKeys = account.keys;
    for (const kind of kindsOf(purpose)) {
      const { slot, path } = KINDS[kind];
      if (keys[slot] !== undefined) throw refused(`this account already has a ${kind} key; remove it first`);
      const title = await this.#titleOnAccount(account.id, path, parsed.bare);
      if (title === undefined)
        throw refused(
          `GitHub does not list that key as a ${kind} key on this account`,
          GIT_ACCOUNT_CODES.keyNotOnAccount,
          422,
        );
      keys = {
        ...keys,
        [slot]: {
          title,
          publicKey: parsed.bare,
          fingerprint: parsed.fingerprint,
          source: 'own',
        } satisfies GitAccountKey,
      };
    }
    await this.accounts.recordKeys(account.id, keys);
    return {
      publicKey: parsed.bare,
      fingerprint: parsed.fingerprint,
      registered: registrations(keys, parsed.fingerprint),
      source: 'own',
    };
  }

  /** The title GitHub holds a key under, or `undefined` when the account lists no such key (a few pages at most). */
  async #titleOnAccount(id: GitAccountId, path: string, bare: string): Promise<string | undefined> {
    for (let page = 1; page <= 5; page += 1) {
      const answer = await this.accounts.api(id, { method: 'GET', path: `${path}?per_page=100&page=${page}` });
      if (answer.status !== 200 || !Array.isArray(answer.body)) throw providerFailure(answer.status);
      for (const entry of answer.body as readonly unknown[]) {
        const listed = entry as { key?: unknown; title?: unknown };
        if (typeof listed.key === 'string' && listed.key.split(' ').slice(0, 2).join(' ') === bare)
          return typeof listed.title === 'string' && listed.title !== '' ? listed.title.slice(0, 200) : 'GitHub key';
      }
      if (answer.body.length < 100) break;
    }
    return undefined;
  }

  async #dropOwnKey(id: GitAccountId): Promise<void> {
    this.agents.stop(id);
    await this.sealed.delete(id as SealedName);
  }

  async #sealedKey(id: GitAccountId): Promise<SealedKey | undefined> {
    const text = await this.sealed.get(id as SealedName);
    if (text === undefined) return undefined;
    try {
      const value = JSON.parse(text) as Partial<SealedKey>;
      if (
        typeof value.privateKey === 'string' &&
        typeof value.publicKey === 'string' &&
        typeof value.fingerprint === 'string'
      )
        return { privateKey: value.privateKey, publicKey: value.publicKey, fingerprint: value.fingerprint };
    } catch {
      // fall through: a damaged entry is treated as no key (a new one is made on the next ask)
    }
    return undefined;
  }

  async #account(id: GitAccountId): Promise<GitAccount> {
    const account = await this.accounts.find(id);
    if (account === undefined) throw new ApiError(404, 'no such Git account', GIT_ACCOUNT_CODES.unknownAccount);
    return account;
  }

  /** One operation at a time per account, so two asks never make two keys or race a removal. The GPG key shares it. */
  exclusive<T>(id: GitAccountId, work: () => Promise<T>): Promise<T> {
    return this.#serial(id, work);
  }

  #serial<T>(id: GitAccountId, work: () => Promise<T>): Promise<T> {
    const before = this.#queues.get(id) ?? Promise.resolve();
    const run = before.then(work, work);
    const tail = run.catch(() => undefined);
    this.#queues.set(id, tail);
    void tail.then(() => {
      if (this.#queues.get(id) === tail) this.#queues.delete(id);
    });
    return run;
  }
}

/** The keys with one registration taken out. */
function without(keys: GitAccountKeys, slot: 'ssh' | 'signing'): GitAccountKeys {
  const other = slot === 'ssh' ? keys.signing : keys.ssh;
  return other === undefined ? {} : { [slot === 'ssh' ? 'signing' : 'ssh']: other };
}

function registrations(keys: GitAccountKeys, fingerprint: string): GitKeyKind[] {
  const out: GitKeyKind[] = [];
  if (keys.ssh?.fingerprint === fingerprint) out.push('auth');
  if (keys.signing?.fingerprint === fingerprint) out.push('signing');
  return out;
}

/** GitHub's `201 {id}`; a 422 ("key is already in use") is the person's to fix, anything else is GitHub's failure. */
function githubIdOf(answer: GitApiAnswer): string | undefined {
  if (answer.status === 422) throw refused('GitHub refused the key (it may already be used by another account)');
  if (answer.status !== 201 && answer.status !== 200) return undefined;
  const id = (answer.body as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? String(id) : undefined;
}

function providerFailure(status: number): ApiError {
  return new ApiError(502, `GitHub answered ${status}`, GIT_ACCOUNT_CODES.providerRefused);
}
