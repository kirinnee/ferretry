import {
  type AccountHintList,
  type AccountList,
  type AccountLookAlike,
  type AccountSummary,
  type PutAccountDefaultRequest,
  type SignInSummary,
  type TwoFactorKeySummary,
  withAccountDefault,
} from '../../../contract/routes/index.ts';
import type { AccountPorts, IAccountGateway } from '../../../cli/lib/account-ports.ts';

export const AT = '2026-11-01T12:00:00.000Z';
export const SI = (n: number): string => `si_${String(n).repeat(16)}`;
export const TF = (n: number): string => `tf_${String(n).repeat(12)}`;
export const RP = (n: number): string => `rp_${String(n).repeat(16)}`;

export const signIn = (over: Partial<SignInSummary> = {}): SignInSummary => ({
  id: SI(1),
  account: 'GITHUB_WORK',
  place: { kind: 'site', domains: ['github.com'], match: [] },
  method: { kind: 'password' },
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const account = (over: Partial<AccountSummary> = {}): AccountSummary => ({
  id: 'GITHUB_WORK',
  label: 'work github',
  fields: { password: true },
  factors: [],
  signIns: [],
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const factorKey = (n: number, over: Record<string, unknown> = {}): TwoFactorKeySummary =>
  ({
    id: TF(n),
    label: 'phone',
    addedAt: AT,
    addedBy: 'owner',
    kind: 'security-key',
    automatic: false,
    ...over,
  }) as TwoFactorKeySummary;

/** `GITHUB_WORK` has one sign-in and no 2FA key; `GITHUB_HOME` has two 2FA keys and no sign-in. */
export const LIST: AccountList = {
  v: 1,
  health: 'ready',
  accounts: [
    account({ signIns: [SI(1)] }),
    account({
      id: 'GITHUB_HOME',
      label: 'home github',
      factors: [
        factorKey(1, { kind: 'sms', label: 'text', endsWith: '42' }),
        factorKey(2, {
          kind: 'totp',
          label: 'authy',
          automatic: true,
          params: { algorithm: 'SHA1', digits: 6, period: 30 },
        }),
      ],
    }),
  ],
  signIns: [signIn()],
};

export const DAMAGED: AccountList = {
  v: 1,
  health: 'damaged',
  diagnosis: 'index is not valid JSON',
  accounts: [],
  signIns: [],
};

export interface RigOptions {
  readonly list?: AccountList;
  readonly interactive?: boolean;
  /** Answers to `ask`, in order. */
  readonly typed?: readonly string[];
  /** Answers to `askHidden`, in order. */
  readonly hidden?: readonly string[];
  /** Per gateway method, what it throws instead of answering. */
  readonly fail?: Partial<Record<keyof IAccountGateway, unknown>>;
  readonly lookAlike?: AccountLookAlike;
  readonly hint?: AccountHintList;
  readonly recipeFiles?: Readonly<Record<string, string>>;
}

/** A gateway that records `[method, ...args]`, answers from `LIST` and the request, and throws what `fail` names. */
class FakeAccountGateway implements IAccountGateway {
  readonly calls: unknown[][] = [];
  constructor(private readonly options: RigOptions) {}

  async #go<T>(name: keyof IAccountGateway, args: unknown[], answer: () => T): Promise<T> {
    this.calls.push([name, ...args]);
    const failure = this.options.fail?.[name];
    if (failure !== undefined) throw failure;
    return answer();
  }

  async list(): Promise<AccountList> {
    return await this.#go('list', [], () => this.options.list ?? LIST);
  }
  async putAccount(id: string, body: Parameters<IAccountGateway['putAccount']>[1]): Promise<AccountSummary> {
    return await this.#go('putAccount', [id, body], () => account({ id, label: body.label ?? 'work github' }));
  }
  async renameAccount(id: string, to: string): Promise<AccountSummary> {
    return await this.#go('renameAccount', [id, to], () => account({ id: to }));
  }
  async removeAccount(id: string) {
    return await this.#go('removeAccount', [id], () => ({ id, removed: true as const }));
  }
  async merge(id: string, from: string): Promise<AccountSummary> {
    return await this.#go('merge', [id, from], () => account({ id }));
  }
  async apart(id: string, from: string): Promise<AccountSummary> {
    return await this.#go('apart', [id, from], () => account({ id }));
  }
  async lookAlike(): Promise<AccountLookAlike> {
    return await this.#go('lookAlike', [], () => this.options.lookAlike ?? { v: 1, groups: [] });
  }
  async hint(site: string): Promise<AccountHintList> {
    return await this.#go('hint', [site], () => this.options.hint ?? { v: 1, site, hints: [], passkeys: 'off' });
  }
  async addSignIn(accountId: string, body: Parameters<IAccountGateway['addSignIn']>[1]): Promise<SignInSummary> {
    return await this.#go('addSignIn', [accountId, body], () =>
      signIn({ account: accountId, place: body.place, method: body.method ?? { kind: 'password' } }),
    );
  }
  async putSignIn(id: string, body: Parameters<IAccountGateway['putSignIn']>[1]): Promise<SignInSummary> {
    return await this.#go('putSignIn', [id, body], () => signIn({ id }));
  }
  async removeSignIn(id: string) {
    return await this.#go('removeSignIn', [id], () => ({ id, removed: true as const }));
  }
  async decideRecipe(id: string, proposalId: string, decision: 'approve' | 'decline'): Promise<SignInSummary> {
    return await this.#go('decideRecipe', [id, proposalId, decision], () => signIn({ id }));
  }
  async putDefault(body: PutAccountDefaultRequest) {
    return await this.#go('putDefault', [body], () => ({ defaults: withAccountDefault({}, body, body.account) }));
  }
  async addFactor(accountId: string, body: Parameters<IAccountGateway['addFactor']>[1]): Promise<TwoFactorKeySummary> {
    return await this.#go('addFactor', [accountId, body], () =>
      factorKey(3, { ...body, label: body.label, automatic: false }),
    );
  }
  async removeFactor(accountId: string, factor: string) {
    return await this.#go('removeFactor', [accountId, factor], () => ({
      account: accountId,
      factor,
      removed: true as const,
    }));
  }
}

/** The ports of a `fy account` run, every one a fake: what was said, asked and read is recorded. */
export function accountPorts(options: RigOptions = {}) {
  const gateway = new FakeAccountGateway(options);
  const said: string[] = [];
  const asked: string[] = [];
  const askedHidden: string[] = [];
  const typed = [...(options.typed ?? [])];
  const hidden = [...(options.hidden ?? [])];
  const reads: string[] = [];
  const ports: AccountPorts = {
    gateway,
    out: { success: message => void said.push(message) },
    prompt: {
      ask: async message => {
        asked.push(message);
        const answer = typed.shift();
        if (answer === undefined) throw new Error(`unexpected question: ${message}`);
        return answer;
      },
      askHidden: async message => {
        askedHidden.push(message);
        const answer = hidden.shift();
        if (answer === undefined) throw new Error(`unexpected hidden question: ${message}`);
        return answer;
      },
    },
    interactive: options.interactive ?? true,
    readRecipe: async file => {
      reads.push(file);
      const text = options.recipeFiles?.[file];
      if (text === undefined) throw new Error(`no such file ${file}`);
      return text;
    },
  };
  return { ports, gateway, said, asked, askedHidden, reads };
}

/** The message of the error `run` rejects with. */
export async function rejection(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('did not reject');
}
