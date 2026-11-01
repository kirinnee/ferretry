import { FyHttpError } from '@ferretry/protocol/client';
import {
  type AccountDefaultScope,
  accountDefaultScopeWords,
  type AccountSummary,
  LOGIN_LABEL_MAX_LENGTH,
  LOGIN_USERNAME_MAX_LENGTH,
  LoginMatchSchema,
  loginHintSite,
  type PutAccountDefaultRequest,
  type PutAccountRequest,
} from '@ferretry/protocol';
import {
  accountHandle,
  methodOf,
  type MethodFlags,
  namesPlace,
  oneLine,
  passwordProblem,
  placeOf,
  type PlaceFlags,
} from './account-input.ts';
import type { AccountPorts } from './account-ports.ts';
import {
  renderAccountHint,
  renderAccountLine,
  renderAccountList,
  renderDefaults,
  renderSignInLine,
} from './account-render.ts';

export interface AccountListOptions {
  readonly json?: boolean | undefined;
}

/** `fy account add`. There is no value flag: the password is typed at the prompt. Place and method flags add a first sign-in. */
export interface AccountAddOptions extends PlaceFlags, MethodFlags {
  readonly label: string;
  readonly username?: string | undefined;
  /** `--no-password` is `false`: an account with no password yet. */
  readonly password?: boolean | undefined;
}

/** `fy account edit`. Each flag names a field to change; a field not named is kept. */
export interface AccountEditOptions {
  readonly label?: string | undefined;
  /** `--username U` is the text; `--no-username` is `false`. */
  readonly username?: string | false | undefined;
  /** `--password`: prompt for a new one. */
  readonly password?: boolean | undefined;
  readonly totp?: boolean | undefined;
}

export interface AccountHintOptions {
  readonly json?: boolean | undefined;
}

export interface AccountYesOptions {
  readonly yes?: boolean | undefined;
}

/** Where a default applies: the whole machine, one board project, or one folder. */
export interface AccountDefaultOptions {
  readonly project?: string | undefined;
  readonly folder?: string | undefined;
}

function defaultAddress(
  key: string,
  options: AccountDefaultOptions,
): Pick<PutAccountDefaultRequest, 'scope' | 'within' | 'key'> {
  if (options.project !== undefined && options.folder !== undefined)
    throw new Error('a default is for the whole machine, one --project or one --folder, not both');
  const place = LoginMatchSchema.safeParse(key.trim().toLowerCase());
  if (!place.success)
    throw new Error(`"${key}" is not a place a default is for: use a web host (github.com) or program@host (ssh@box)`);
  const scope: AccountDefaultScope =
    options.project !== undefined ? 'projects' : options.folder !== undefined ? 'folders' : 'sites';
  const within = (options.project ?? options.folder)?.trim();
  if (within === '') throw new Error('--project and --folder need a project name or a folder path');
  return { scope, key: place.data, ...(within === undefined ? {} : { within }) };
}

/**
 * Drives `fy account ls|add|edit|rename|rm|merge|apart|look-alike|hint|default`: the owner's accounts, the password
 * manager the input bridge places values from.
 *
 * VALUES GO IN, ONLY AT A PROMPT. A password is read hidden from a terminal a person is sitting at, sent once in the
 * PUT body, and dropped. There is no flag, argument, environment variable or pipe that carries one, and nothing here
 * prints one, echoes one back in an error, or keeps one past the call. A 2FA seed is not here at all (`factor add`).
 *
 * EVERY WRITE IS THE OWNER'S. The daemon refuses a ferret on these routes; the gateway says so in one sentence, and
 * nothing here retries with another credential.
 */
export class AccountController {
  constructor(private readonly ports: AccountPorts) {}

  async list(options: AccountListOptions): Promise<void> {
    const list = await this.ports.gateway.list();
    this.ports.out.success(options.json === true ? JSON.stringify(list, null, 2) : renderAccountList(list));
  }

  async add(id: string, options: AccountAddOptions): Promise<void> {
    const handle = accountHandle(id);
    const body: PutAccountRequest = { label: oneLine(options.label, '--label', LOGIN_LABEL_MAX_LENGTH) };
    if (options.username !== undefined)
      body.username = oneLine(options.username, '--username', LOGIN_USERNAME_MAX_LENGTH);
    const place = namesPlace(options) ? placeOf(options) : undefined;
    const method = methodOf(undefined, options);
    if (place === undefined && method !== undefined)
      throw new Error('a sign-in method needs a place: add --domain <host> (or --tool and --host)');
    if ((await this.#find(handle)) !== undefined)
      throw new Error(`${handle} already exists: change it with \`account edit ${handle}\``);
    if (options.password !== false) body.password = await this.#askPassword(`password for ${handle} (hidden): `);
    const saved = await this.ports.gateway.putAccount(handle, body);
    this.ports.out.success(`Added ${renderAccountLine(saved)}`);
    if (place === undefined) {
      this.ports.out.success(
        `${handle} has no sign-in yet, so it is never offered: add one with \`account site add ${handle} --domain <host>\`.`,
      );
      return;
    }
    const signIn = await this.ports.gateway
      .addSignIn(handle, { place, ...(method === undefined ? {} : { method }) })
      .catch((error: unknown) => {
        throw new Error(
          `${handle} was saved, but its sign-in was not: ${error instanceof Error ? error.message : 'the daemon refused it'}. Add it with \`account site add ${handle}\``,
        );
      });
    this.ports.out.success(`Sign-in ${renderSignInLine(signIn)}`);
  }

  async edit(id: string, options: AccountEditOptions): Promise<void> {
    const handle = accountHandle(id);
    if (options.totp === true)
      throw new Error(
        `saving a 2FA seed needs your passkey: run \`account factor add ${handle} --totp\` and confirm it in the app. Nothing was changed`,
      );
    if (options.label === undefined && options.username === undefined && options.password !== true)
      throw new Error('nothing to change: name a field (--label, --username, --no-username, --password)');
    const body: PutAccountRequest = {};
    if (options.label !== undefined) body.label = oneLine(options.label, '--label', LOGIN_LABEL_MAX_LENGTH);
    if (options.username === false) body.username = null;
    else if (options.username !== undefined)
      body.username = oneLine(options.username, '--username', LOGIN_USERNAME_MAX_LENGTH);
    await this.#account(handle);
    if (options.password === true) body.password = await this.#askPassword(`new password for ${handle} (hidden): `);
    const saved = await this.ports.gateway.putAccount(handle, body);
    this.ports.out.success(`Updated ${renderAccountLine(saved)}`);
  }

  async rename(id: string, to: string): Promise<void> {
    const from = accountHandle(id);
    const saved = await this.ports.gateway.renameAccount(from, accountHandle(to));
    this.ports.out.success(`Renamed ${from} to ${saved.id}. Its sign-ins, 2FA keys and defaults follow it.`);
  }

  async remove(id: string, options: AccountYesOptions): Promise<void> {
    const handle = accountHandle(id);
    const account = await this.#account(handle);
    const goes = `${String(account.signIns.length)} sign-in${account.signIns.length === 1 ? '' : 's'} and ${String(account.factors.length)} 2FA key${account.factors.length === 1 ? '' : 's'}`;
    if (
      !(await this.#confirmed(
        options,
        `Remove ${handle} (${account.label}) with its ${goes}? This cannot be undone. Type yes: `,
      ))
    )
      return void this.ports.out.success(`Kept ${handle}.`);
    await this.ports.gateway.removeAccount(handle);
    this.ports.out.success(`Removed ${handle}.`);
  }

  /** Folds `from` into `keep`: `keep`'s handle and password stay; `from`'s sign-ins and 2FA keys move over; `from` goes. */
  async merge(keep: string, from: string, options: AccountYesOptions): Promise<void> {
    const keepId = accountHandle(keep);
    const fromId = accountHandle(from);
    if (keepId === fromId)
      throw new Error('name two different accounts: the one to keep, then the one to fold into it');
    const kept = await this.#account(keepId);
    const folded = await this.#account(fromId);
    const question = `Merge ${fromId} (${folded.label}) into ${keepId} (${kept.label})? ${fromId} will be removed and its sign-ins and 2FA keys move to ${keepId}. Type yes: `;
    if (!(await this.#confirmed(options, question))) return void this.ports.out.success(`Kept both.`);
    const saved = await this.ports.gateway.merge(keepId, fromId);
    this.ports.out.success(`Merged ${fromId} into ${renderAccountLine(saved)}`);
  }

  /** Records that two accounts are NOT one, so they are never offered as look-alikes of each other. */
  async apart(id: string, other: string): Promise<void> {
    const left = accountHandle(id);
    const right = accountHandle(other);
    if (left === right) throw new Error('name two different accounts');
    await this.ports.gateway.apart(left, right);
    this.ports.out.success(`${left} and ${right} are kept apart: they are not offered as look-alikes of each other.`);
  }

  /** Groups of accounts with the same username and password, by handle only, so a merge can be considered. */
  async lookAlike(options: AccountListOptions): Promise<void> {
    const found = await this.ports.gateway.lookAlike();
    if (options.json === true) return void this.ports.out.success(JSON.stringify(found, null, 2));
    this.ports.out.success(
      found.groups.length === 0
        ? 'No accounts look like one another.'
        : [
            'These look like one account each (same username and password):',
            ...found.groups.map(group => `  ${group.join(', ')}`),
            'Merge them with `account merge <keep> <from>`, or say they differ with `account apart <a> <b>`.',
          ].join('\n'),
    );
  }

  /** What a ferret's `account_hint` is told about a site, one entry per sign-in: never a value, nor which secret fields exist. */
  async hint(site: string, options: AccountHintOptions): Promise<void> {
    const key = loginHintSite(site);
    if (key === undefined) throw new Error(`"${site}" is not a site: use a host like github.com, or a URL`);
    const hint = await this.ports.gateway.hint(key);
    this.ports.out.success(options.json === true ? JSON.stringify(hint, null, 2) : renderAccountHint(hint));
  }

  /** Makes `account` the one offered first for `key`, in the scope named. The owner's route: a ferret is refused. */
  async defaultSet(key: string, account: string, options: AccountDefaultOptions): Promise<void> {
    const request = { ...defaultAddress(key, options), account: accountHandle(account) };
    const written = await this.#writeDefault(request);
    this.ports.out.success(
      [
        `${request.account} is offered first for ${request.key} (${accountDefaultScopeWords(request)}).`,
        '',
        renderDefaults(written),
      ].join('\n'),
    );
  }

  async defaultRemove(key: string, options: AccountDefaultOptions): Promise<void> {
    const request = { ...defaultAddress(key, options), account: null };
    const written = await this.#writeDefault(request);
    this.ports.out.success(
      [
        `No account is starred for ${request.key} (${accountDefaultScopeWords(request)}) now.`,
        '',
        renderDefaults(written),
      ].join('\n'),
    );
  }

  async #writeDefault(request: PutAccountDefaultRequest) {
    try {
      return (await this.ports.gateway.putDefault(request)).defaults;
    } catch (error) {
      if (error instanceof FyHttpError && error.code === 'no_sign_in_here')
        throw new Error(
          `${request.account ?? 'that account'} has no sign-in for ${request.key}, so it cannot be offered first there: add one with \`account site add\`. Nothing was changed`,
        );
      if (error instanceof FyHttpError && error.code === 'defaults_file_invalid')
        throw new Error(`${error.message}. Fix config/account-defaults.yaml, then run this again. Nothing was changed`);
      throw error;
    }
  }

  async #account(handle: string): Promise<AccountSummary> {
    const account = await this.#find(handle);
    if (account === undefined) throw new Error(`no account ${handle} (see \`account ls\`)`);
    return account;
  }

  async #find(handle: string): Promise<AccountSummary | undefined> {
    const list = await this.ports.gateway.list();
    if (list.health === 'damaged')
      throw new Error(
        `this daemon cannot read its secret store (${list.diagnosis ?? 'no diagnosis was given'}): its accounts are NOT gone, so nothing was changed`,
      );
    return list.accounts.find(account => account.id === handle);
  }

  async #confirmed(options: AccountYesOptions, question: string): Promise<boolean> {
    if (options.yes === true) return true;
    this.#needTerminal('this asks first; pass --yes to skip the question');
    return (await this.ports.prompt.ask(question)).trim().toLowerCase() === 'yes';
  }

  async #askPassword(message: string): Promise<string> {
    this.#needTerminal('the password is typed at a prompt, never given as a flag');
    const value = await this.ports.prompt.askHidden(message);
    const problem = passwordProblem(value);
    if (problem !== undefined) throw new Error(problem);
    return value;
  }

  #needTerminal(why: string): void {
    if (!this.ports.interactive) throw new Error(`this needs a terminal you are sitting at: ${why}`);
  }
}
