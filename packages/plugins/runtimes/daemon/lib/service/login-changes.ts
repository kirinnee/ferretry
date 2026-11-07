/**
 * Every `credential.*` change is Logins' to stage and apply (`ctx.needs.logins.changes`): Runtimes names the intent
 * in Logins' words and carries only what Logins cannot see — the runtimes on a login. Nothing here derives a login
 * file, and a secret never passes through: a `login.add` carries the variables the caller sent (plain values or
 * `${secret:NAME}` references, as today) and a `login.env` the same, with `{ keep: true }` for a value held back.
 *
 * Pure.
 */
import type { LoginChange, LoginChangeError } from '@ferretry/plugin-logins/contract';
import type { CatalogRefusalCode } from '../../../contract/index.ts';
import type { LoginAccountChange } from './mutations.ts';

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

/** Logins' refusal codes in this surface's own taxonomy; the sentence is carried over word for word. */
export const REFUSAL_CODES = {
  login_change_refused: 'fleet_change_refused',
  login_change_unknown: 'fleet_change_unknown',
  login_change_expired: 'fleet_change_expired',
  login_change_consumed: 'fleet_change_consumed',
  login_change_stale: 'fleet_change_stale',
  login_change_failed: 'fleet_change_failed',
} as const satisfies Record<LoginChangeError['code'], CatalogRefusalCode>;
