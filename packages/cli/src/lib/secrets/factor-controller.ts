import { FyHttpError } from '@ferretry/protocol/client';
import {
  LOGIN_TOTP_WARNING,
  AccountIdSchema,
  padInputValue,
  parseTotpInput,
  TOTP_INPUT_MAX_BYTES,
  TWO_FACTOR_ERROR_CODES,
  TWO_FACTOR_LABEL_MAX_LENGTH,
  TWO_FACTOR_STAGE_TTL_SECONDS,
  type TwoFactorSeedStaged,
  type TwoFactorSeedStageView,
} from '@ferretry/protocol';
import { accountRefusal } from './account-gateway.ts';
import type { IAccountGateway, IAccountPrompt } from './account-ports.ts';
import type { ITwoFactorSeedGateway } from './factor-gateway.ts';

/** `fy account factor add <id> --totp`. The key is typed at a hidden prompt; there is no flag that carries one. */
export interface TwoFactorAddOptions {
  readonly totp?: boolean | undefined;
  readonly label?: string | undefined;
  /** The agenda board the confirm card goes on; defaults to the session this runs inside. */
  readonly session?: string | undefined;
  readonly iUnderstandTotp?: boolean | undefined;
}

export interface TwoFactorSeedPorts {
  readonly gateway: ITwoFactorSeedGateway;
  /** The person-only account read that runs before anything is typed, so a caller who may not stage is refused first. */
  readonly accounts: Pick<IAccountGateway, 'list'>;
  readonly out: { success(message: string): void };
  readonly prompt: IAccountPrompt;
  readonly interactive: boolean;
  /** `FY_SESSION_ID`: the session this CLI runs inside, absent at the person's own shell. */
  readonly ownSessionId?: string | undefined;
  readonly sleep: (ms: number) => Promise<void>;
  readonly nowMs: () => number;
}

const POLL_MS = 1_000;

/**
 * `fy account factor add --totp` (docs/secrets.md, "2FA keys"): STAGES the seed and puts a card on the owner's agenda,
 * then waits while the owner confirms it with a passkey in the app. It never saves a seed: there is no route this CLI
 * could call to do that without a passkey, the machine's own admin token included.
 */
export class TwoFactorSeedController {
  constructor(private readonly ports: TwoFactorSeedPorts) {}

  async add(id: string, options: TwoFactorAddOptions): Promise<void> {
    const account = AccountIdSchema.safeParse(id.trim());
    if (!account.success) throw new Error(`"${id}" is not a usable account handle (see \`account ls\`)`);
    if (options.totp !== true)
      throw new Error(
        'name the kind of 2FA key: --totp saves a TOTP key so Ferretry makes the codes (other kinds: Settings › Accounts)',
      );
    const session = options.session?.trim() || this.ports.ownSessionId?.trim() || '';
    if (session === '')
      throw new Error(
        'name the agenda board the confirm card goes on with --session <id> (fy session ls): a seed is saved only with your passkey, in the app',
      );
    const label = options.label === undefined ? undefined : this.#label(options.label);
    await this.#preflight(account.data);
    const staged = await this.#askAndStage(account.data, options.iUnderstandTotp === true, label);
    const card = await this.ports.gateway.confirmInApp(account.data, staged.stage, { session });
    this.ports.out.success(
      `Confirm it with your passkey on the card !${card.agendaItemId} in the Ferretry app (agenda of ${session}). Nothing is saved until you do; waiting up to ${String(TWO_FACTOR_STAGE_TTL_SECONDS / 60)} minutes…`,
    );
    const final = await this.#wait(account.data, staged.stage);
    this.ports.out.success(OUTCOME[final.state](account.data));
  }

  /** Owner-only read first: a refused caller never sees the warning or the seed prompt, and an older daemon is named before typing. */
  async #preflight(account: string): Promise<void> {
    const list = await this.ports.accounts.list().catch((error: unknown) => {
      throw accountRefusal(error);
    });
    if (list.health === 'damaged')
      throw new Error(
        `this daemon cannot read its secret store (${list.diagnosis ?? 'no diagnosis was given'}): its accounts are NOT gone, so nothing was changed`,
      );
    if (!list.accounts.some(candidate => candidate.id === account))
      throw new Error(`no account ${account} (see \`account ls\`)`);
  }

  /** The typed key lives only in this call: it is unreachable once the stage request has been answered. */
  async #askAndStage(account: string, understood: boolean, label: string | undefined): Promise<TwoFactorSeedStaged> {
    const text = await this.#askKey(understood);
    return await this.#stage(account, text, label);
  }

  async #stage(account: string, text: string, label: string | undefined): Promise<TwoFactorSeedStaged> {
    const body = {
      padded: padInputValue(text),
      totpAcknowledged: true as const,
      ...(label === undefined ? {} : { label }),
    };
    try {
      return await this.ports.gateway.stage(account, body);
    } catch (error) {
      if (!(error instanceof FyHttpError) || error.code !== TWO_FACTOR_ERROR_CODES.mismatch) throw seedRefusal(error);
      this.ports.out.success(error.message);
      const answer = await this.ports.prompt.ask('Save it to this account anyway? Type yes: ');
      if (answer.trim().toLowerCase() !== 'yes') throw new Error('no 2FA key was staged: nothing was changed');
      return await this.ports.gateway
        .stage(account, { ...body, mismatchAcknowledged: true })
        .catch((again: unknown) => {
          throw seedRefusal(again);
        });
    }
  }

  async #wait(account: string, stage: string): Promise<TwoFactorSeedStageView> {
    const until = this.ports.nowMs() + (TWO_FACTOR_STAGE_TTL_SECONDS + 5) * 1_000;
    for (;;) {
      const view = await this.ports.gateway.view(account, stage).catch((error: unknown) => {
        if (error instanceof FyHttpError && error.status === 404) return undefined;
        throw error;
      });
      if (view === undefined) return { state: 'expired' } as TwoFactorSeedStageView;
      if (view.state !== 'waiting' || this.ports.nowMs() >= until) return view;
      await this.ports.sleep(POLL_MS);
    }
  }

  /** The warning, a typed "yes" (or --i-understand-totp), then the key at a hidden prompt, checked here first. */
  async #askKey(understood: boolean): Promise<string> {
    if (!this.ports.interactive)
      throw new Error(
        'this needs a terminal you are sitting at: the 2FA key is typed at a prompt, never given as a flag',
      );
    this.ports.out.success(`Saving a 2FA key: ${LOGIN_TOTP_WARNING}`);
    if (!understood) {
      const answer = await this.ports.prompt.ask('Type yes to save it anyway: ');
      if (answer.trim().toLowerCase() !== 'yes') throw new Error('no 2FA key was staged: nothing was changed');
    }
    const text = await this.ports.prompt.askHidden('2FA key, or its otpauth://totp link (hidden): ');
    if (new TextEncoder().encode(text).length > Math.min(TOTP_INPUT_MAX_BYTES, 1_024))
      throw new Error('that is too long to be a 2FA key');
    const parsed = parseTotpInput(text);
    if (!parsed.ok) throw new Error(parsed.error);
    return text;
  }

  #label(value: string): string {
    const text = value.trim();
    if (text === '' || text.length > TWO_FACTOR_LABEL_MAX_LENGTH || /[\p{Cc}\p{Cf}]/u.test(text))
      throw new Error(`--label must be one line of 1 to ${String(TWO_FACTOR_LABEL_MAX_LENGTH)} characters`);
    return text;
  }
}

const OUTCOME: Readonly<Record<TwoFactorSeedStageView['state'], (account: string) => string>> = {
  saved: account => `Saved: Ferretry makes the codes for ${account} now.`,
  dropped: () => 'Denied: nothing was saved.',
  expired: () => 'Timed out: nothing was saved. Run it again to save the key.',
  waiting: () => 'Still waiting: nothing is saved until you confirm it with your passkey in the app.',
};

/** The owner's words for what the daemon refused about a seed, by its code. */
function seedRefusal(error: unknown): unknown {
  if (!(error instanceof FyHttpError)) return error;
  const known = accountRefusal(error);
  return known === error ? new Error(error.message) : known;
}
