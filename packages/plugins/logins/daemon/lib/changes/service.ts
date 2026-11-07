/**
 * Logins' own change path (today's reviewed `credential.*` account changes): stage one intent, show what it would do,
 * apply exactly what was shown.
 *
 * A change edits this plugin's own `config/logins/<id>.yaml` through the kernel's config write port, so the one
 * writer's rules hold as they did: only the changed keys are edited (comments survive), a raw secret is refused, the
 * last good version is kept, and an edit that LOOSENS spend (a removed budget) is held for the owner. Signing out runs
 * the harness's own logout against the one store. The review authorizes the act; the capability layer already decided
 * whether the caller may ask.
 */
import type { ConfigWriteOutcome } from '@ferretry/kernel/contract';
import { type Instant, instantFromEpochMs } from '@ferretry/std';
import type {
  LoginChange,
  LoginChangeOutcome,
  LoginChangeRefusalCode,
  LoginChangeView,
  LoginFile,
  LoginView,
} from '../../../contract/index.ts';
import type { LoginSignOutOutcome } from '../credentials/credentials-service.ts';
import type { ProviderPreset } from '../presets/schema.ts';
import { deriveLoginChange, type LoginEdit, LoginChangeRefusal } from './derive.ts';
import { type HeldChange, LoginChangeHoldRefusal, LoginChangeStore } from './store.ts';

/** A refusal in the transport's taxonomy: a code a client branches on, and a sentence for the person. */
export class LoginChangeError extends Error {
  constructor(
    readonly code: LoginChangeRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'LoginChangeError';
  }
}

const HOLD_CODES: Readonly<Record<LoginChangeHoldRefusal['problem'], LoginChangeRefusalCode>> = {
  unknown: 'login_change_unknown',
  expired: 'login_change_expired',
  consumed: 'login_change_consumed',
  exhausted: 'login_change_refused',
};

type Payload =
  | {
      readonly kind: 'edit';
      readonly change: Exclude<LoginChange, { kind: 'login.signout' }>;
      readonly edit: LoginEdit;
    }
  | { readonly kind: 'sign-out'; readonly id: string };

type Held = HeldChange<{
  readonly change: LoginChange;
  readonly summary: string;
  readonly consequences: readonly string[];
  readonly orphanedSecrets: readonly string[];
  readonly run: Payload;
}>;

export interface LoginChangeServiceDeps {
  readonly files: () => ReadonlyMap<string, LoginFile>;
  readonly presets: () => Promise<readonly ProviderPreset[]>;
  readonly machineName: () => string;
  /** The runtimes on a login, by name, when known. */
  readonly usedBy?: (id: string) => readonly string[];
  /** One login as the list shows it, for a sign-out's sentence. */
  readonly view: (id: string) => Promise<LoginView | undefined>;
  readonly signOut: (id: string) => Promise<LoginSignOutOutcome>;
  /** Write or remove one of this plugin's own login files through the kernel config port. */
  readonly write: (id: string, patch: Readonly<Record<string, unknown>>) => Promise<ConfigWriteOutcome>;
  readonly remove: (id: string) => Promise<ConfigWriteOutcome>;
  readonly changed: (
    id: string,
    change: 'added' | 'removed' | 'edited' | 'signed-out' | 'enabled' | 'disabled',
  ) => void;
  readonly now: () => number;
  readonly mintId: () => string;
}

/** A small deterministic fingerprint of the logins in effect: what a staged change was derived from. */
export function fingerprint(files: ReadonlyMap<string, LoginFile>): string {
  const text = JSON.stringify([...files].toSorted(([a], [b]) => (a < b ? -1 : 1)));
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export class LoginChangeService {
  readonly #held: LoginChangeStore<Held['payload']>;

  constructor(private readonly deps: LoginChangeServiceDeps) {
    this.#held = new LoginChangeStore({ now: deps.now, mintId: deps.mintId });
  }

  async stage(change: LoginChange): Promise<LoginChangeView> {
    const files = this.deps.files();
    try {
      const staged = await this.#derive(files, change);
      const held = this.#holdOf(() => this.#held.open({ revision: fingerprint(files), payload: staged }));
      return this.#view(held);
    } catch (error) {
      throw asError(error);
    }
  }

  view(id: string): LoginChangeView {
    return this.#view(this.#holdOf(() => this.#held.require(id)));
  }

  async apply(id: string): Promise<LoginChangeOutcome> {
    const held = this.#holdOf(() => this.#held.consume(id));
    try {
      if (held.revision !== fingerprint(this.deps.files())) {
        throw new LoginChangeError(
          'login_change_stale',
          'the logins on this machine changed after this change was previewed; review it again',
        );
      }
      return await this.#run(held.payload.run);
    } catch (error) {
      // An apply that never reached the host leaves the change reviewable.
      if (error instanceof LoginChangeError && error.code !== 'login_change_failed') this.#held.restore(held);
      throw asError(error);
    }
  }

  async #derive(files: ReadonlyMap<string, LoginFile>, change: LoginChange): Promise<Held['payload']> {
    if (change.kind === 'login.signout') {
      const login = await this.deps.view(change.id);
      if (login === undefined) throw new LoginChangeRefusal(`no login ${change.id} exists on this machine`);
      if (!login.signOut.available) throw new LoginChangeRefusal(login.signOut.sentence);
      return {
        change,
        summary: `Sign out of login ${change.id}`,
        consequences: [login.signOut.sentence],
        orphanedSecrets: [],
        run: { kind: 'sign-out', id: change.id },
      };
    }
    const edit = deriveLoginChange(files, change, {
      machineName: this.deps.machineName(),
      presets: change.kind === 'login.add' ? await this.deps.presets() : [],
      usedBy: id => this.deps.usedBy?.(id) ?? [],
    });
    return {
      change,
      summary: edit.summary,
      consequences: edit.consequences,
      orphanedSecrets: edit.orphanedSecrets,
      run: { kind: 'edit', change, edit },
    };
  }

  async #run(run: Payload): Promise<LoginChangeOutcome> {
    if (run.kind === 'sign-out') {
      const result = await this.deps.signOut(run.id);
      this.deps.changed(run.id, 'signed-out');
      return result.outcome === 'signed-out'
        ? { outcome: 'signed-out', login: result.credential }
        : { outcome: 'sign-out-failed', reason: result.reason, login: result.credential };
    }
    const held: string[] = [];
    for (const write of run.edit.writes) {
      const outcome =
        'remove' in write ? await this.deps.remove(write.id) : await this.deps.write(write.id, write.patch);
      if (outcome.kind === 'conflict') {
        throw new LoginChangeError(
          'login_change_stale',
          `login ${write.id} changed while this was being applied; review it again`,
        );
      }
      if (outcome.kind === 'refused') {
        throw new LoginChangeError(
          'login_change_failed',
          outcome.issues.map(issue => issue.message).join('; ') || 'the file was refused',
        );
      }
      if (outcome.kind === 'held') held.push(...outcome.sentences);
      this.deps.changed(write.id, changeKind(run.change));
    }
    return held.length > 0 ? { outcome: 'held', sentences: held } : { outcome: 'applied' };
  }

  #holdOf<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof LoginChangeHoldRefusal) throw new LoginChangeError(HOLD_CODES[error.problem], error.message);
      throw error;
    }
  }

  #view(held: Held): LoginChangeView {
    const { change, summary, consequences, orphanedSecrets } = held.payload;
    return {
      id: held.id,
      change,
      summary,
      consequences,
      ...(orphanedSecrets.length === 0 ? {} : { orphanedSecrets }),
      expiresAt: instantFromEpochMs(held.expiresAt) as Instant,
      state: held.state,
    };
  }
}

function changeKind(change: Exclude<LoginChange, { kind: 'login.signout' }>) {
  switch (change.kind) {
    case 'login.add':
      return 'added' as const;
    case 'login.remove':
      return 'removed' as const;
    case 'login.enable':
      return 'enabled' as const;
    case 'login.disable':
      return 'disabled' as const;
    case 'login.label':
      return 'edited' as const;
  }
}

function asError(error: unknown): unknown {
  return error instanceof LoginChangeRefusal ? new LoginChangeError('login_change_refused', error.message) : error;
}
