import {
  type AccountList,
  type AddTwoFactorKeyRequest,
  PUSH_APPS,
  PushAppSchema,
  TWO_FACTOR_LABEL_MAX_LENGTH,
} from '@ferretry/protocol';
import { accountHandle, factorHandle, oneLine } from './account-input.ts';
import type { AccountPorts } from './account-ports.ts';
import { renderFactorLine } from './account-render.ts';

export interface FactorListOptions {
  readonly json?: boolean | undefined;
}

/** The kind of a value-less 2FA key: exactly one of these flags names it. */
export interface FactorAddOptions {
  readonly label?: string | undefined;
  readonly authenticator?: boolean | undefined;
  readonly sms?: boolean | undefined;
  readonly email?: boolean | undefined;
  readonly push?: boolean | undefined;
  readonly securityKey?: boolean | undefined;
  readonly endsWith?: string | undefined;
  readonly to?: string | undefined;
  readonly app?: string | undefined;
}

export interface FactorRemoveOptions {
  readonly yes?: boolean | undefined;
}

/**
 * Drives `fy account factor ls|add|rm` for the keys that hold NO value: an authenticator only the owner holds, a text
 * or email code, a push approval, a security key. A TOTP seed (`add --totp`) is another controller's: it is staged
 * and saved only with a passkey in the app. A key's id (`tf_…`) is printed by `factor ls` and `account ls`.
 */
export class FactorKeyController {
  constructor(private readonly ports: AccountPorts) {}

  async list(account: string | undefined, options: FactorListOptions): Promise<void> {
    const list = await this.#list();
    const handle = account === undefined ? undefined : accountHandle(account);
    if (handle !== undefined && !list.accounts.some(candidate => candidate.id === handle))
      throw new Error(`no account ${handle} (see \`account ls\`)`);
    const shown = list.accounts.filter(candidate => handle === undefined || candidate.id === handle);
    if (options.json === true)
      return void this.ports.out.success(
        JSON.stringify(
          shown.map(candidate => ({ account: candidate.id, factors: candidate.factors })),
          null,
          2,
        ),
      );
    const lines = shown.flatMap(candidate => candidate.factors.map(key => `${candidate.id}  ${renderFactorLine(key)}`));
    this.ports.out.success(
      lines.length === 0
        ? handle === undefined
          ? 'No 2FA keys on this daemon.'
          : `${handle} has no 2FA keys (add one with \`account factor add\`).`
        : lines.join('\n'),
    );
  }

  async add(account: string, options: FactorAddOptions): Promise<void> {
    const handle = accountHandle(account);
    const body = this.#body(options);
    const list = await this.#list();
    if (!list.accounts.some(candidate => candidate.id === handle))
      throw new Error(`no account ${handle} (see \`account ls\`)`);
    const saved = await this.ports.gateway.addFactor(handle, body);
    this.ports.out.success(`Added to ${handle}: ${renderFactorLine(saved)}`);
  }

  async remove(account: string, factor: string, options: FactorRemoveOptions): Promise<void> {
    const handle = accountHandle(account);
    const id = factorHandle(factor);
    const list = await this.#list();
    const owner = list.accounts.find(candidate => candidate.id === handle);
    if (owner === undefined) throw new Error(`no account ${handle} (see \`account ls\`)`);
    const key = owner.factors.find(candidate => candidate.id === id);
    if (key === undefined) throw new Error(`${handle} has no 2FA key ${id} (see \`account factor ls ${handle}\`)`);
    if (options.yes !== true) {
      if (!this.ports.interactive)
        throw new Error('this needs a terminal you are sitting at: removing a 2FA key asks first; pass --yes to skip');
      const warning = key.automatic
        ? ' Ferretry makes its codes: the saved seed is deleted with it, and you can only get it back by setting the site up again.'
        : '';
      const answer = await this.ports.prompt.ask(
        `Remove ${renderFactorLine(key)} from ${handle}?${warning} Type yes: `,
      );
      if (answer.trim().toLowerCase() !== 'yes') return void this.ports.out.success(`Kept ${id}.`);
    }
    await this.ports.gateway.removeFactor(handle, id);
    this.ports.out.success(`Removed ${id} from ${handle}.`);
  }

  #body(options: FactorAddOptions): AddTwoFactorKeyRequest {
    const kinds = [
      options.authenticator === true ? 'authenticator' : undefined,
      options.sms === true ? 'sms' : undefined,
      options.email === true ? 'email' : undefined,
      options.push === true ? 'push' : undefined,
      options.securityKey === true ? 'security-key' : undefined,
    ].filter((kind): kind is string => kind !== undefined);
    if (kinds.length !== 1)
      throw new Error(
        'name exactly one kind of 2FA key: --totp (Ferretry makes the codes), --authenticator (you hold the app), --sms, --email, --push or --security-key',
      );
    if (options.label === undefined) throw new Error('give the key a --label, like "Authy on my phone"');
    const label = oneLine(options.label, '--label', TWO_FACTOR_LABEL_MAX_LENGTH);
    const kind = kinds[0];
    const only = (flag: 'endsWith' | 'to' | 'app', name: string, owner: string): void => {
      if (options[flag] !== undefined && kind !== owner) throw new Error(`${name} is for ${owner}, not ${kind}`);
    };
    only('endsWith', '--ends-with', 'sms');
    only('to', '--to', 'email');
    only('app', '--app', 'push');
    switch (kind) {
      case 'authenticator':
        return { label, kind: 'totp' };
      case 'sms': {
        const endsWith = options.endsWith?.trim();
        if (endsWith !== undefined && !/^[0-9]{2,4}$/u.test(endsWith))
          throw new Error('--ends-with is the last 2 to 4 digits of the number, never the whole number');
        return { label, kind: 'sms', ...(endsWith === undefined ? {} : { endsWith }) };
      }
      case 'email':
        return {
          label,
          kind: 'email',
          ...(options.to === undefined ? {} : { to: oneLine(options.to, '--to', 120) }),
        };
      case 'push': {
        if (options.app === undefined) return { label, kind: 'push' };
        const app = PushAppSchema.safeParse(options.app.trim().toLowerCase());
        if (!app.success) throw new Error(`--app is one of ${PUSH_APPS.join(', ')}`);
        return { label, kind: 'push', app: app.data };
      }
      default:
        return { label, kind: 'security-key' };
    }
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
