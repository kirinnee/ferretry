import {
  type AccountList,
  type AddSignInRequest,
  type PutSignInRequest,
  type SignInSummary,
} from '../../contract/routes/index.ts';
import {
  accountHandle,
  methodOf,
  type MethodFlags,
  namesPlace,
  onOrOff,
  placeOf,
  type PlaceFlags,
  signInHandle,
} from './account-input.ts';
import type { AccountPorts } from './account-ports.ts';
import { renderSignInLine, renderSignInList } from './account-render.ts';

export interface SignInListOptions {
  readonly json?: boolean | undefined;
}

/** `fy account site add`: where it signs in, and how. */
export interface SignInAddOptions extends PlaceFlags, MethodFlags {
  readonly autoApplyRecipe?: string | undefined;
}

/** `fy account site edit`: each flag names a part to change; a part not named is kept. */
export interface SignInEditOptions extends PlaceFlags, MethodFlags {
  readonly autoApplyRecipe?: string | undefined;
}

export interface SignInRemoveOptions {
  readonly yes?: boolean | undefined;
}

/**
 * Drives `fy account site ls|add|edit|rm|recipe …`: an account's sign-ins, the places it signs in and how. A sign-in
 * is named by its `si_…` id (`account ls` and `account site ls` print them); an account by its handle.
 *
 * Nothing here holds a value: a recipe never may, and the daemon refuses one that does. Every write is the OWNER's;
 * a ferret's call is refused by the daemon and no other credential is tried.
 */
export class SignInController {
  constructor(private readonly ports: AccountPorts) {}

  /** Every sign-in, or one account's, each with the `si_` id the other verbs take. */
  async list(account: string | undefined, options: SignInListOptions): Promise<void> {
    const list = await this.#list();
    const handle = account === undefined ? undefined : accountHandle(account);
    const owner = handle === undefined ? undefined : list.accounts.find(candidate => candidate.id === handle);
    if (handle !== undefined && owner === undefined) throw new Error(`no account ${handle} (see \`account ls\`)`);
    const signIns = list.signIns.filter(signIn => handle === undefined || signIn.account === handle);
    this.ports.out.success(options.json === true ? JSON.stringify(signIns, null, 2) : renderSignInList(owner, signIns));
  }

  async add(account: string, options: SignInAddOptions): Promise<void> {
    const handle = accountHandle(account);
    const list = await this.#list();
    if (!list.accounts.some(candidate => candidate.id === handle))
      throw new Error(`no account ${handle} (see \`account ls\`)`);
    const body: AddSignInRequest = { place: placeOf(options) };
    const method = methodOf(undefined, options);
    if (method !== undefined) body.method = method;
    if (options.autoApplyRecipe !== undefined) body.autoApplyRecipe = onOrOff(options.autoApplyRecipe);
    const saved = await this.ports.gateway.addSignIn(handle, body);
    this.ports.out.success(`Added to ${handle}: ${renderSignInLine(saved)}`);
  }

  async edit(signIn: string, options: SignInEditOptions): Promise<void> {
    const id = signInHandle(signIn);
    if (!namesPlace(options) && methodOf(undefined, options) === undefined && options.autoApplyRecipe === undefined)
      throw new Error(
        'nothing to change: name a part (--domain, --for, --tool, --host, --dest, --method, --sso-name, --via, --no-via, --auto-apply-recipe)',
      );
    const current = await this.#signIn(id);
    const body: PutSignInRequest = {};
    if (namesPlace(options)) body.place = placeOf(options, current.place);
    const method = methodOf(current.method, options);
    if (method !== undefined) body.method = method;
    if (options.autoApplyRecipe !== undefined) body.autoApplyRecipe = onOrOff(options.autoApplyRecipe);
    const saved = await this.ports.gateway.putSignIn(id, body);
    this.ports.out.success(`Updated ${renderSignInLine(saved)}`);
  }

  async remove(signIn: string, options: SignInRemoveOptions): Promise<void> {
    const id = signInHandle(signIn);
    const current = await this.#signIn(id);
    if (options.yes !== true) {
      if (!this.ports.interactive)
        throw new Error('this needs a terminal you are sitting at: removing a sign-in asks first; pass --yes to skip');
      const answer = await this.ports.prompt.ask(
        `Remove ${renderSignInLine(current)} from ${current.account}? Type yes: `,
      );
      if (answer.trim().toLowerCase() !== 'yes') return void this.ports.out.success(`Kept ${id}.`);
    }
    await this.ports.gateway.removeSignIn(id);
    this.ports.out.success(`Removed ${id} from ${current.account}.`);
  }

  async #signIn(id: string): Promise<SignInSummary> {
    return this.#in(await this.#list(), id);
  }

  #in(list: AccountList, id: string): SignInSummary {
    const found = list.signIns.find(signIn => signIn.id === id);
    if (found === undefined) throw new Error(`no sign-in ${id} (see \`account site ls\`)`);
    return found;
  }

  async #list(): Promise<AccountList> {
    const list = await this.ports.gateway.list();
    if (list.health === 'damaged')
      throw new Error(
        `this daemon cannot read its secret store (${list.diagnosis ?? 'no diagnosis was given'}): its accounts are NOT gone, so nothing was changed`,
      );
    return list;
  }
}
