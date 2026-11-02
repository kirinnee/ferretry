import type {
  AccountHintList,
  AccountList,
  AccountLookAlike,
  AccountSummary,
  AddSignInRequest,
  AddTwoFactorKeyRequest,
  LoginRecipeDecision,
  PutAccountDefaultRequest,
  PutAccountDefaultResult,
  PutAccountRequest,
  PutSignInRequest,
  RemovedAccount,
  RemovedSignIn,
  RemovedTwoFactorKey,
  SignInSummary,
  TwoFactorKeySummary,
} from '@ferretry/protocol';
import { DAEMON_FEATURES } from '@ferretry/protocol';
import { Command } from 'commander';
import { AccountController } from '../../../src/lib/secrets/account-controller';
import { type AccountControllers, registerAccountCommands } from '../../../src/lib/secrets/account-commands';
import type { IAccountGateway, IAccountPrompt } from '../../../src/lib/secrets/account-ports';
import { TwoFactorSeedController } from '../../../src/lib/secrets/factor-controller';
import type { ITwoFactorSeedGateway } from '../../../src/lib/secrets/factor-gateway';
import { FactorKeyController } from '../../../src/lib/secrets/factor-keys-controller';
import { SignInController } from '../../../src/lib/secrets/sign-in-controller';

export const SI_GITHUB = 'si_0123456789abcdef';
export const SI_TERMINAL = 'si_fedcba9876543210';
export const TF_AUTO = 'tf_0123456789ab';
export const TF_SMS = 'tf_ba9876543210';
export const AT = '2026-01-01T00:00:00.000Z';

const totp: TwoFactorKeySummary = {
  id: TF_AUTO,
  kind: 'totp',
  label: 'Authenticator app',
  addedAt: AT,
  addedBy: 'owner',
  automatic: true,
  params: { algorithm: 'SHA1', digits: 6, period: 30 },
} as unknown as TwoFactorKeySummary;

const sms: TwoFactorKeySummary = {
  id: TF_SMS,
  kind: 'sms',
  label: 'Phone text',
  endsWith: '42',
  addedAt: AT,
  addedBy: 'owner',
  automatic: false,
} as unknown as TwoFactorKeySummary;

export const GITHUB_SIGN_IN: SignInSummary = {
  id: SI_GITHUB,
  account: 'GITHUB',
  place: { kind: 'site', domains: ['github.com'], match: ['github.com'] },
  method: { kind: 'password' },
  createdAt: AT,
  updatedAt: AT,
};

export const BOX_SIGN_IN: SignInSummary = {
  id: SI_TERMINAL,
  account: 'SUDO_BOX',
  place: { kind: 'terminal', tool: 'sudo', host: 'box' },
  method: { kind: 'password' },
  createdAt: AT,
  updatedAt: AT,
};

export const GITHUB: AccountSummary = {
  id: 'GITHUB',
  label: 'GitHub',
  username: 'kirinnee',
  fields: { password: true, totp: true },
  factors: [totp, sms],
  signIns: [SI_GITHUB],
  createdAt: AT,
  updatedAt: AT,
};

const SUDO_BOX: AccountSummary = {
  id: 'SUDO_BOX',
  label: 'sudo on box',
  fields: { password: true, totp: false },
  factors: [],
  signIns: [SI_TERMINAL],
  createdAt: AT,
  updatedAt: AT,
};

export const LIST: AccountList = {
  v: 1,
  health: 'ready',
  accounts: [GITHUB, SUDO_BOX],
  signIns: [GITHUB_SIGN_IN, BOX_SIGN_IN],
} as AccountList;

/** An in-memory account gateway: records each call, answers from the list, and can be told to fail one verb. */
export class FakeAccountGateway implements IAccountGateway {
  readonly calls: { readonly op: string; readonly args: readonly unknown[] }[] = [];
  readonly failures = new Map<string, unknown>();
  constructor(private readonly list_: AccountList = LIST) {}

  #call<T>(op: string, args: readonly unknown[], answer: () => T): T {
    this.calls.push({ op, args });
    const failure = this.failures.get(op);
    if (failure !== undefined) throw failure;
    return answer();
  }
  ops(): string[] {
    return this.calls.map(call => call.op);
  }
  last(op: string): readonly unknown[] {
    return this.calls.filter(call => call.op === op).at(-1)?.args ?? [];
  }

  async list(): Promise<AccountList> {
    return this.#call('list', [], () => this.list_);
  }
  async putAccount(id: string, body: PutAccountRequest): Promise<AccountSummary> {
    return this.#call('putAccount', [id, body], () => ({
      ...(this.list_.accounts.find(account => account.id === id) ?? { ...SUDO_BOX, id, signIns: [] }),
      label: body.label ?? 'Saved',
    }));
  }
  async renameAccount(id: string, to: string): Promise<AccountSummary> {
    return this.#call('renameAccount', [id, to], () => ({ ...GITHUB, id: to }));
  }
  async removeAccount(id: string): Promise<RemovedAccount> {
    return this.#call('removeAccount', [id], () => ({ id, removed: true }) as RemovedAccount);
  }
  async merge(id: string, from: string): Promise<AccountSummary> {
    return this.#call('merge', [id, from], () => GITHUB);
  }
  async apart(id: string, from: string): Promise<AccountSummary> {
    return this.#call('apart', [id, from], () => GITHUB);
  }
  async lookAlike(): Promise<AccountLookAlike> {
    return this.#call('lookAlike', [], () => ({ v: 1, groups: [['GITHUB', 'SUDO_BOX']] }));
  }
  async hint(site: string): Promise<AccountHintList> {
    return this.#call('hint', [site], () => ({ v: 1, site, hints: [], passkeys: 'off' }) as AccountHintList);
  }
  async addSignIn(account: string, body: AddSignInRequest): Promise<SignInSummary> {
    return this.#call('addSignIn', [account, body], () => ({
      ...GITHUB_SIGN_IN,
      account,
      place: body.place,
      method: body.method ?? { kind: 'password' },
    }));
  }
  async putSignIn(signIn: string, body: PutSignInRequest): Promise<SignInSummary> {
    return this.#call('putSignIn', [signIn, body], () => ({
      ...(this.list_.signIns.find(candidate => candidate.id === signIn) ?? GITHUB_SIGN_IN),
      ...(body.place === undefined ? {} : { place: body.place }),
      ...(body.method === undefined ? {} : { method: body.method }),
    }));
  }
  async removeSignIn(signIn: string): Promise<RemovedSignIn> {
    return this.#call('removeSignIn', [signIn], () => ({ id: signIn, removed: true }) as RemovedSignIn);
  }
  async decideRecipe(
    signIn: string,
    proposalId: string,
    decision: LoginRecipeDecision['decision'],
  ): Promise<SignInSummary> {
    return this.#call('decideRecipe', [signIn, proposalId, decision], () => GITHUB_SIGN_IN);
  }
  async putDefault(body: PutAccountDefaultRequest): Promise<PutAccountDefaultResult> {
    return this.#call('putDefault', [body], () => ({
      defaults: body.account === null ? {} : { sites: { [body.key]: body.account } },
    }));
  }
  async addFactor(account: string, body: AddTwoFactorKeyRequest): Promise<TwoFactorKeySummary> {
    return this.#call('addFactor', [account, body], () => ({ ...sms, ...body, id: TF_SMS }) as TwoFactorKeySummary);
  }
  async removeFactor(account: string, factor: string): Promise<RemovedTwoFactorKey> {
    return this.#call(
      'removeFactor',
      [account, factor],
      () => ({ account, factor, removed: true }) as RemovedTwoFactorKey,
    );
  }
}

export class FakePrompt implements IAccountPrompt {
  readonly asked: string[] = [];
  readonly hidden: string[] = [];
  constructor(
    private readonly hiddenAnswers: string[] = [],
    private readonly answers: string[] = ['yes'],
  ) {}
  async ask(message: string): Promise<string> {
    this.asked.push(message);
    return this.answers.shift() ?? '';
  }
  async askHidden(message: string): Promise<string> {
    this.hidden.push(message);
    return this.hiddenAnswers.shift() ?? '';
  }
}

class FakeSeedGateway implements ITwoFactorSeedGateway {
  readonly calls: string[] = [];
  async stage(account: string) {
    this.calls.push(`stage ${account}`);
    return {
      stage: `st_${'a'.repeat(24)}`,
      account,
      label: 'Authenticator app',
      expiresAt: '2026-01-01T00:02:00.000Z',
      parsed: { params: { algorithm: 'SHA1', digits: 6, period: 30 } },
    } as Awaited<ReturnType<ITwoFactorSeedGateway['stage']>>;
  }
  async confirmInApp(account: string, stage: string, body: { session: string }) {
    this.calls.push(`confirm ${account}`);
    return { stage, session: body.session, agendaItemId: 'A7' } as Awaited<
      ReturnType<ITwoFactorSeedGateway['confirmInApp']>
    >;
  }
  async view(account: string, stage: string) {
    this.calls.push(`view ${account}`);
    return {
      stage,
      account,
      label: 'Authenticator app',
      state: 'saved',
      expiresAt: '2026-01-01T00:02:00.000Z',
    } as Awaited<ReturnType<ITwoFactorSeedGateway['view']>>;
  }
  async features(): Promise<readonly string[]> {
    return [DAEMON_FEATURES.twoFactorKeys];
  }
}

export interface Rig {
  readonly gateway: FakeAccountGateway;
  readonly seeds: FakeSeedGateway;
  readonly prompt: FakePrompt;
  readonly messages: string[];
  readonly controllers: AccountControllers;
  /** Runs `fy <words…>` through the real command tree. */
  readonly run: (...words: string[]) => Promise<void>;
  readonly root: Command;
}

export function rig(
  options: {
    list?: AccountList;
    prompt?: FakePrompt;
    interactive?: boolean;
    recipe?: string;
    session?: string;
    mount?: (root: Command, controllers: AccountControllers) => void;
  } = {},
): Rig {
  const gateway = new FakeAccountGateway(options.list);
  const seeds = new FakeSeedGateway();
  const prompt = options.prompt ?? new FakePrompt(['correct-horse-battery']);
  const messages: string[] = [];
  const out = { success: (message: string) => void messages.push(message) };
  const ports = {
    gateway,
    out,
    prompt,
    interactive: options.interactive ?? true,
    readRecipe: async () => options.recipe ?? 'Open github.com, press Sign in, type the password.',
  };
  const controllers: AccountControllers = {
    accounts: new AccountController(ports),
    signIns: new SignInController(ports),
    factorKeys: new FactorKeyController(ports),
    seeds: new TwoFactorSeedController({
      gateway: seeds,
      accounts: gateway,
      out,
      prompt: new FakePrompt(['JBSWY3DPEHPK3PXP'], ['yes']),
      interactive: true,
      ownSessionId: options.session ?? 'lead-1',
      sleep: async () => {},
      nowMs: () => 0,
    }),
  };
  const root = new Command().name('fy').exitOverride();
  root.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  (options.mount ?? ((command, mounted) => registerAccountCommands(command, mounted)))(root, controllers);
  return {
    gateway,
    seeds,
    prompt,
    messages,
    controllers,
    root,
    run: async (...words) => {
      await root.parseAsync(['node', 'fy', ...words]);
    },
  };
}

export const refusal = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
};
