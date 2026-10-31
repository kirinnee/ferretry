import { FyHttpError } from '@ferretry/protocol/client';
import {
  LOGIN_LABEL_MAX_LENGTH,
  LOGIN_PASSWORD_MAX_LENGTH,
  LOGIN_PASSWORD_MIN_LENGTH,
  LOGIN_TOTP_WARNING,
  LOGIN_USERNAME_MAX_LENGTH,
  LoginEntryIdSchema,
  type LoginEntrySummary,
  type LoginMethod,
  LoginMethodKindSchema,
  LoginMethodChangeSchema,
  LoginRecipeProposalIdSchema,
  LoginRecipeSchema,
  LOGIN_METHODS,
  LoginMatchSchema,
  loginHintSite,
  loginMethodOf,
  namesPasskey,
  normalizedLoginDomain,
  type PutLoginEntryRequest,
  TotpSeedSchema,
} from '@ferretry/protocol';
import type { LoginEntryPorts } from './entry-ports.ts';
import { renderLoginEntryLine, renderLoginEntryList, renderLoginHint, renderLoginRecipe } from './entry-render.ts';

export interface LoginEntryListOptions {
  readonly json?: boolean | undefined;
}

/** `fy account add`. There is no value flag: the password is typed at the prompt. */
export interface LoginEntryAddOptions {
  readonly label: string;
  readonly match?: readonly string[] | undefined;
  readonly username?: string | undefined;
  /** `--no-password` is `false`: an entry with no password yet. */
  readonly password?: boolean | undefined;
  readonly method?: string | undefined;
  readonly ssoName?: string | undefined;
  readonly via?: string | undefined;
  readonly domain?: readonly string[] | undefined;
}

/** `fy account edit`. Each flag names a field to change; a field not named is kept. */
export interface LoginEntryEditOptions {
  readonly label?: string | undefined;
  readonly match?: readonly string[] | undefined;
  /** `--username U` is the text; `--no-username` is `false`. */
  readonly username?: string | false | undefined;
  /** `--password`: prompt for a new one. */
  readonly password?: boolean | undefined;
  /** `--totp`: prompt for a seed; `--no-totp` is `false` and removes it. */
  readonly totp?: boolean | undefined;
  readonly iUnderstandTotp?: boolean | undefined;
  readonly method?: string | undefined;
  readonly ssoName?: string | undefined;
  /** `--via ID` is the handle; `--no-via` is `false`. */
  readonly via?: string | false | undefined;
  readonly domain?: readonly string[] | undefined;
  /** `--auto-apply-recipe on|off`: let a ferret's recipe proposal for this login apply without asking. */
  readonly autoApplyRecipe?: string | undefined;
}

export interface LoginEntryRecipeShowOptions {
  readonly json?: boolean | undefined;
}

/** `fy account recipe set`: where the Markdown comes from, a file path or `-` for standard input. */
export interface LoginEntryRecipeSetOptions {
  readonly file?: string | undefined;
}

export interface LoginEntryHintOptions {
  readonly json?: boolean | undefined;
}

export interface LoginEntryRemoveOptions {
  readonly yes?: boolean | undefined;
}

function handle(value: string): string {
  const parsed = LoginEntryIdSchema.safeParse(value.trim());
  if (!parsed.success)
    throw new Error(
      `"${value}" is not a usable handle: use uppercase letters, digits and underscores, like SUDO_KIRIN_BOX`,
    );
  return parsed.data;
}

/** The owner's words for what the daemon refused about a recipe, by its code. */
function recipeRefusal(error: unknown): unknown {
  if (!(error instanceof FyHttpError)) return error;
  if (error.code === 'recipe_holds_value')
    return new Error(
      'that recipe holds a saved or vaulted value, which a recipe never may: name the login with [[ID]] and describe the step instead. Nothing was changed',
    );
  if (error.code === 'stale_proposal')
    return new Error(
      'the recipe changed after the ferret proposed this one, so approving it would undo that change unseen: decline it (`recipe decline`) or edit the recipe yourself',
    );
  if (error.code === 'unknown_proposal')
    return new Error('there is no such proposal: it was already answered or replaced (see `account recipe show`)');
  return error;
}

function onOrOff(value: string): boolean {
  const word = value.trim().toLowerCase();
  if (word === 'on') return true;
  if (word === 'off') return false;
  throw new Error('--auto-apply-recipe is on or off');
}

function proposalHandle(value: string): string {
  const parsed = LoginRecipeProposalIdSchema.safeParse(value.trim());
  if (!parsed.success) throw new Error(`"${value}" is not a proposal id: they look like rp_0123456789abcdef`);
  return parsed.data;
}

function oneLine(value: string, name: string, maximum: number): string {
  const text = value.trim();
  if (text === '' || text.length > maximum || /[\p{Cc}\p{Cf}]/u.test(text))
    throw new Error(`${name} must be one line of 1 to ${maximum} characters`);
  return text;
}

function matches(values: readonly string[]): string[] {
  return values.map(value => {
    const parsed = LoginMatchSchema.safeParse(value.trim().toLowerCase());
    if (!parsed.success)
      throw new Error(
        `"${value}" is not something a login matches: use program@host (sudo@kirin-box) or a web host (github.com)`,
      );
    return parsed.data;
  });
}

function domains(values: readonly string[]): string[] {
  return values.map(value => {
    const host = normalizedLoginDomain(value);
    if (host === undefined)
      throw new Error(`"${value}" is not a web host a sign-in happens on, like accounts.google.com`);
    return host;
  });
}

/** The method flags, over what the entry has now: `--via` alone keeps the method, `--method` alone keeps a via. */
function method(
  current: LoginMethod | undefined,
  options: {
    readonly method?: string | undefined;
    readonly ssoName?: string | undefined;
    readonly via?: string | false | undefined;
  },
): LoginMethod | undefined {
  if (options.method === undefined && options.ssoName === undefined && options.via === undefined) return undefined;
  if (options.method !== undefined && namesPasskey(options.method))
    throw new Error('passkeys are off: an account signs in with a password or a provider (google, github, ...)');
  const kind = LoginMethodKindSchema.safeParse((options.method ?? current?.kind ?? 'password').trim().toLowerCase());
  if (!kind.success) throw new Error(`--method is one of ${LOGIN_METHODS.join(', ')}`);
  const via = options.via === false ? undefined : options.via === undefined ? current?.via : handle(options.via);
  const name = options.ssoName ?? (kind.data === 'sso' ? current?.name : undefined);
  const parsed = LoginMethodChangeSchema.safeParse({
    kind: kind.data,
    ...(name === undefined ? {} : { name: name.trim() }),
    ...(via === undefined || kind.data === 'password' ? {} : { via }),
  });
  if (!parsed.success) throw new Error(parsed.error.issues.map(issue => issue.message).join('; '));
  if (options.via !== undefined && options.via !== false && kind.data === 'password')
    throw new Error('--via is for a provider method: add --method google (or github, microsoft, apple, sso)');
  return parsed.data;
}

/** Said without the value: a problem with a typed password never repeats what was typed. */
function passwordProblem(value: string): string | undefined {
  if (value.length < LOGIN_PASSWORD_MIN_LENGTH)
    return `a saved password must be at least ${LOGIN_PASSWORD_MIN_LENGTH} characters: a shorter one cannot be masked out of output safely`;
  if (value.length > LOGIN_PASSWORD_MAX_LENGTH)
    return `a saved password is at most ${LOGIN_PASSWORD_MAX_LENGTH} characters`;
  if (/\p{Cc}/u.test(value)) return 'a password with a control character or line break would press keys';
  return undefined;
}

/**
 * Drives `fy account ls|add|edit|rename|rm`: the owner's accounts, the password manager the input
 * bridge places values from.
 *
 * VALUES GO IN, ONLY AT A PROMPT. A password or a 2FA seed is read hidden from a terminal a person is
 * sitting at, sent once in the PUT body, and dropped. There is no flag, argument, environment variable or
 * pipe that carries one, and nothing here prints one, echoes one back in an error, or keeps one past the
 * call. Reading one back is not a command: the daemon serves no route that could.
 */
export class LoginEntryController {
  constructor(private readonly ports: LoginEntryPorts) {}

  async list(options: LoginEntryListOptions): Promise<void> {
    const list = await this.ports.gateway.list();
    this.ports.out.success(options.json === true ? JSON.stringify(list, null, 2) : renderLoginEntryList(list));
  }

  async add(id: string, options: LoginEntryAddOptions): Promise<void> {
    const handleId = handle(id);
    const body: PutLoginEntryRequest = {
      label: oneLine(options.label, '--label', LOGIN_LABEL_MAX_LENGTH),
      match: matches(options.match ?? []),
    };
    if (options.username !== undefined)
      body.username = oneLine(options.username, '--username', LOGIN_USERNAME_MAX_LENGTH);
    const chosen = method(undefined, options);
    if (chosen !== undefined) body.method = chosen;
    if (options.domain !== undefined) body.domains = domains(options.domain);
    if ((await this.#find(handleId)) !== undefined)
      throw new Error(`${handleId} already exists: change it with \`account edit ${handleId}\``);
    if (options.password !== false) body.password = await this.#askPassword(`password for ${handleId} (hidden): `);
    const saved = await this.ports.gateway.put(handleId, body);
    this.ports.out.success(`Added ${renderLoginEntryLine(saved)}`);
  }

  async edit(id: string, options: LoginEntryEditOptions): Promise<void> {
    const handleId = handle(id);
    if (
      options.label === undefined &&
      options.match === undefined &&
      options.username === undefined &&
      options.password !== true &&
      options.totp === undefined &&
      options.method === undefined &&
      options.ssoName === undefined &&
      options.via === undefined &&
      options.domain === undefined &&
      options.autoApplyRecipe === undefined
    )
      throw new Error(
        'nothing to change: name a field (--label, --match, --method, --via, --domain, --username, --password, --totp, --auto-apply-recipe ...)',
      );
    const body: PutLoginEntryRequest = {};
    if (options.label !== undefined) body.label = oneLine(options.label, '--label', LOGIN_LABEL_MAX_LENGTH);
    if (options.match !== undefined) body.match = matches(options.match);
    if (options.username === false) body.username = null;
    else if (options.username !== undefined)
      body.username = oneLine(options.username, '--username', LOGIN_USERNAME_MAX_LENGTH);
    if (options.totp === false) body.totp = null;
    if (options.domain !== undefined) body.domains = domains(options.domain);
    if (options.autoApplyRecipe !== undefined) body.autoApplyRecipe = onOrOff(options.autoApplyRecipe);
    const existing = await this.#find(handleId);
    if (existing === undefined) throw new Error(`no account ${handleId} (see \`account ls\`)`);
    const chosen = method(loginMethodOf(existing), options);
    if (chosen !== undefined) body.method = chosen;
    if (options.password === true) body.password = await this.#askPassword(`new password for ${handleId} (hidden): `);
    if (options.totp === true) {
      body.totp = { seed: await this.#askSeed(options.iUnderstandTotp === true) };
      body.totpAcknowledged = true;
    }
    const saved = await this.ports.gateway.put(handleId, body);
    this.ports.out.success(`Updated ${renderLoginEntryLine(saved)}`);
  }

  /** What a ferret's `account_hint` is told about a site: never a value, nor which secret fields exist. */
  async hint(site: string, options: LoginEntryHintOptions): Promise<void> {
    const key = loginHintSite(site);
    if (key === undefined) throw new Error(`"${site}" is not a site: use a host like github.com, or a URL`);
    const hint = await this.ports.gateway.hint(key);
    this.ports.out.success(options.json === true ? JSON.stringify(hint, null, 2) : renderLoginHint(hint));
  }

  /** The recipe, what the daemon saw, and each ferret's proposal as the diff it would make. */
  async recipeShow(id: string, options: LoginEntryRecipeShowOptions): Promise<void> {
    const entry = await this.#entry(handle(id));
    this.ports.out.success(options.json === true ? JSON.stringify(entry, null, 2) : renderLoginRecipe(entry));
  }

  /** Replaces the whole recipe with Markdown from a file or standard input. A recipe never holds a value. */
  async recipeSet(id: string, options: LoginEntryRecipeSetOptions): Promise<void> {
    const handleId = handle(id);
    if (options.file === undefined)
      throw new Error('name the Markdown: --file <path>, or --file - to read standard input');
    const text = await this.ports.readRecipe(options.file);
    const parsed = LoginRecipeSchema.safeParse(text);
    if (!parsed.success)
      throw new Error(
        `that is not a usable recipe: ${parsed.error.issues.map(issue => issue.message).join('; ')} (1 to 4000 characters of plain lines)`,
      );
    await this.#entry(handleId);
    const saved = await this.ports.gateway.put(handleId, { recipe: parsed.data }).catch(error => {
      throw recipeRefusal(error);
    });
    this.ports.out.success(`Saved the recipe of ${renderLoginEntryLine(saved)}`);
  }

  async recipeClear(id: string): Promise<void> {
    const handleId = handle(id);
    const entry = await this.#entry(handleId);
    if (entry.recipe === undefined) {
      this.ports.out.success(`${handleId} has no recipe to clear.`);
      return;
    }
    await this.ports.gateway.put(handleId, { recipe: null });
    this.ports.out.success(`Cleared the recipe of ${handleId}.`);
  }

  /** Makes the ferret's proposal the recipe, unless the recipe changed since it was made. */
  async recipeDecide(id: string, proposalId: string, decision: 'approve' | 'decline'): Promise<void> {
    const handleId = handle(id);
    const proposal = proposalHandle(proposalId);
    const saved = await this.ports.gateway.decideRecipe(handleId, proposal, decision).catch(error => {
      throw recipeRefusal(error);
    });
    this.ports.out.success(
      decision === 'approve'
        ? `Approved ${proposal}: that is now the recipe of ${renderLoginEntryLine(saved)}`
        : `Declined ${proposal}: the recipe of ${handleId} is as it was.`,
    );
  }

  async rename(id: string, to: string): Promise<void> {
    const from = handle(id);
    const next = handle(to);
    const saved = await this.ports.gateway.rename(from, next);
    this.ports.out.success(`Renamed ${from} to ${saved.id}.`);
  }

  async remove(id: string, options: LoginEntryRemoveOptions): Promise<void> {
    const handleId = handle(id);
    const entry = await this.#find(handleId);
    if (entry === undefined) throw new Error(`no account ${handleId} (see \`account ls\`)`);
    if (options.yes !== true) {
      this.#needTerminal('removing an account asks first; pass --yes to skip the question');
      const answer = await this.ports.prompt.ask(
        `Remove ${handleId} (${entry.label})? This cannot be undone. Type yes: `,
      );
      if (answer.trim().toLowerCase() !== 'yes') {
        this.ports.out.success(`Kept ${handleId}.`);
        return;
      }
    }
    await this.ports.gateway.remove(handleId);
    this.ports.out.success(`Removed ${handleId}.`);
  }

  async #entry(id: string): Promise<LoginEntrySummary> {
    const entry = await this.#find(id);
    if (entry === undefined) throw new Error(`no account ${id} (see \`account ls\`)`);
    return entry;
  }

  async #find(id: string): Promise<LoginEntrySummary | undefined> {
    const list = await this.ports.gateway.list();
    if (list.health === 'damaged')
      throw new Error(
        `this daemon cannot read its secret store (${list.diagnosis ?? 'no diagnosis was given'}): its accounts are NOT gone, so nothing was changed`,
      );
    return list.entries.find(entry => entry.id === id);
  }

  async #askPassword(message: string): Promise<string> {
    this.#needTerminal('the password is typed at a prompt, never given as a flag');
    const value = await this.ports.prompt.askHidden(message);
    const problem = passwordProblem(value);
    if (problem !== undefined) throw new Error(problem);
    return value;
  }

  /** The warning first, then a typed "yes" (or --i-understand-totp), and only then the seed. */
  async #askSeed(understood: boolean): Promise<string> {
    this.#needTerminal('the 2FA seed is typed at a prompt, never given as a flag');
    this.ports.out.success(`Keeping a 2FA seed: ${LOGIN_TOTP_WARNING}`);
    if (!understood) {
      const answer = await this.ports.prompt.ask('Type yes to keep the seed anyway: ');
      if (answer.trim().toLowerCase() !== 'yes') throw new Error('no 2FA seed was kept: nothing was changed');
    }
    const seed = await this.ports.prompt.askHidden('2FA seed, as the setup page shows it (hidden): ');
    if (!TotpSeedSchema.safeParse(seed).success)
      throw new Error('that is not a base32 2FA seed of 16 to 128 characters');
    return seed;
  }

  #needTerminal(why: string): void {
    if (!this.ports.interactive) throw new Error(`this needs a terminal you are sitting at: ${why}`);
  }
}
