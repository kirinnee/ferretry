/**
 * Every `credential.*` change is Logins' to stage and apply (`ctx.needs.loginChanges`): Runtimes names the intent
 * in Logins' words and carries only what Logins cannot see — the runtimes on a login. Nothing here derives a login
 * file, and a secret never passes through: a `login.add` carries the variables the caller sent (plain values or
 * `${secret:NAME}` references, as today) and a `login.env` the same, with `{ keep: true }` for a value held back.
 *
 * Pure.
 */
import type { LoginChange, LoginChangeError } from '@ferretry/plugin-logins/contract';
import type { AccountModel } from '../account/schema.ts';
import type { CatalogRefusalCode } from '../../../contract/index.ts';
import { listed } from './catalog.ts';
import type { LoginAccountChange, LoginRemoval } from './mutations.ts';

/**
 * What a removal's move did to the runtimes, in a sentence: "alpha moved to login b and gamma was removed". Said when
 * the move landed but the login then was not removed, so a person is never told "nothing happened".
 */
export function movedSentence(change: LoginRemoval): string {
  const byTarget = new Map<string, string[]>();
  for (const [name, to] of Object.entries(change.switchRuntimes ?? {}))
    byTarget.set(to, [...(byTarget.get(to) ?? []), name]);
  const parts = [...byTarget].map(([to, names]) => `${listed(names)} moved to login ${to}`);
  const removed = [...new Set(change.removeRuntimes ?? [])];
  if (removed.length > 0) parts.push(`${listed(removed)} ${removed.length === 1 ? 'was' : 'were'} removed`);
  if (change.defaultRuntime !== undefined) parts.push(`the default runtime is now ${change.defaultRuntime}`);
  return parts.join('; ');
}

/** The Logins change a `credential.*` change stands for. */
export function loginChangeOf(change: LoginAccountChange): LoginChange {
  switch (change.kind) {
    case 'credential.add':
      return {
        kind: 'login.add',
        id: change.id,
        harness: change.harness,
        ...(change.label === undefined ? {} : { label: change.label }),
        ...(change.store === undefined ? {} : { store: change.store }),
        ...(change.preset === undefined ? {} : { preset: change.preset }),
        ...(change.env === undefined ? {} : { env: change.env }),
        ...(change.cloudCredential === undefined ? {} : { cloudCredential: change.cloudCredential }),
      };
    case 'credential.env':
      return {
        kind: 'login.env',
        id: change.id,
        env: change.env,
        ...(change.cloudCredential === undefined ? {} : { cloudCredential: change.cloudCredential }),
      };
    case 'credential.label':
      return { kind: 'login.label', id: change.id, label: change.label };
    case 'credential.remove':
      return { kind: 'login.remove', id: change.id };
    case 'credential.signout':
      return { kind: 'login.signout', id: change.id };
    case 'credential.disable':
      return {
        kind: 'login.disable',
        id: change.id,
        ...(change.reason === undefined ? {} : { reason: change.reason }),
        ...(change.until === undefined ? {} : { until: change.until }),
      };
    case 'credential.enable':
      return { kind: 'login.enable', id: change.id };
  }
}

/**
 * The model as a login change would leave it, for a preview only: a switch-off, a switch-on or a label on one login. Any
 * other change leaves the model as it is. Nothing is written.
 */
export function modelAfterLoginChange(model: AccountModel, change: LoginChange): AccountModel {
  if (change.kind !== 'login.disable' && change.kind !== 'login.enable' && change.kind !== 'login.label') return model;
  const credential = model.credentials[change.id];
  if (credential === undefined) return model;
  const { disabled: _off, ...rest } = credential;
  const next =
    change.kind === 'login.disable'
      ? {
          ...rest,
          disabled: {
            ...(change.reason === undefined ? {} : { reason: change.reason }),
            ...(change.until === undefined ? {} : { until: change.until }),
          },
        }
      : change.kind === 'login.enable'
        ? rest
        : { ...credential, ...(change.label === null ? {} : { label: change.label }) };
  return { ...model, credentials: { ...model.credentials, [change.id]: next as typeof credential } };
}

/** Logins' refusal codes in this surface's own taxonomy; the sentence is carried over word for word. */
export const REFUSAL_CODES = {
  login_change_refused: 'fleet_change_refused',
  login_change_unknown: 'fleet_change_unknown',
  login_change_expired: 'fleet_change_expired',
  login_change_consumed: 'fleet_change_consumed',
  login_change_stale: 'fleet_change_stale',
  login_change_failed: 'fleet_change_failed',
} as const satisfies Record<LoginChangeError['code'], CatalogRefusalCode>;
