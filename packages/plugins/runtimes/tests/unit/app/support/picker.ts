/**
 * Fixtures for the picker suites, written against the real wire schemas so a contract change fails them: a picker row
 * (`PickerAccount`), a login's health row, and the two daemon answers the picker reads (`GET /v1/runtimes`,
 * `GET /v1/logins`).
 */

import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import {
  type LoginList,
  LoginIdSchema,
  LoginListSchema,
  type LoginStatus,
  type LoginView,
} from '@ferretry/plugin-logins/contract';
import type { PickerAccount, PickerAccountHealth } from '../../../../app/lib/account-picker-catalog.ts';
import { type RuntimeCatalog, RuntimeCatalogSchema, type RuntimeView } from '../../../../contract/index.ts';

const harnessOf = (wrapper: string): HarnessKey => (wrapper.startsWith('codex') ? 'codex' : 'claude-code');

/** One picker row. `credentialId` defaults to one login per wrapper. */
export const pickerAccount = (overrides: Partial<PickerAccount> & { wrapper: string }): PickerAccount => ({
  id: `rt-${overrides.wrapper}`,
  displayName: overrides.wrapper,
  kind: harnessOf(overrides.wrapper),
  agent: true,
  credentialId: `login-${overrides.wrapper}`,
  defaultModel: null,
  models: [],
  available: true,
  unavailableReason: null,
  ...overrides,
});

const STATUS_WORDS: Readonly<Record<LoginStatus['word'], readonly [string, LoginStatus['reason'], string]>> = {
  ready: ['Ready', 'provider_accepted', 'Ready. The provider accepted this login.'],
  refresh_due: ['Refresh due', 'access_expired_refreshable', 'Refresh due. It renews the next time it is used.'],
  needs_sign_in: ['Needs sign-in', 'not_signed_in', 'Needs sign-in. Runtimes that use this login can’t launch.'],
  checking: ['Checking', 'check_in_flight', 'Checking with the provider…'],
};

/** A login status with the daemon's own words for `word`. */
export const loginStatus = (word: LoginStatus['word'] = 'ready', overrides: Partial<LoginStatus> = {}): LoginStatus => {
  const [label, reason, explanation] = STATUS_WORDS[word];
  return { word, label, reason, explanation, lastCheckInconclusive: false, ...overrides };
};

/** One login's health row, keyed by its login id. */
export const pickerHealth = (
  credentialId: string,
  word: LoginStatus['word'] = 'ready',
  overrides: Partial<LoginStatus> = {},
): PickerAccountHealth => ({ ...loginStatus(word, overrides), credentialId });

/** A health map from rows. */
export const healthMap = (...rows: readonly PickerAccountHealth[]): ReadonlyMap<string, PickerAccountHealth> =>
  new Map(rows.map(row => [row.credentialId, row] as const));

/** One runtime as `GET /v1/runtimes` publishes it. */
export const runtimeView = (overrides: Partial<RuntimeView> & { wrapper: string }): RuntimeView => ({
  id: `rt-${overrides.wrapper}`,
  name: overrides.wrapper,
  harness: harnessOf(overrides.wrapper),
  credential: { id: `login-${overrides.wrapper}`, store: 'host', status: 'ready' },
  profile: 'Default',
  agent: true,
  stack: {
    harness: harnessOf(overrides.wrapper),
    available: { available: true },
    applied: [],
    skipped: [],
    conflicts: [],
    partial: [],
  },
  modelSet: { source: 'harness-default' },
  launch: { available: true },
  sameAs: [],
  ...overrides,
});

export const runtimeCatalog = (...runtimes: readonly RuntimeView[]): RuntimeCatalog =>
  RuntimeCatalogSchema.parse({ format: 'present', runtimes });

/** One login as `GET /v1/logins` publishes it. */
export const loginView = (
  id: string,
  word: LoginStatus['word'] = 'ready',
  overrides: Partial<LoginView> = {},
): LoginView => ({
  id: LoginIdSchema.parse(id),
  harness: id.includes('codex') ? 'codex' : 'claude-code',
  harnesses: [id.includes('codex') ? 'codex' : 'claude-code'],
  store: 'host',
  needsLabel: false,
  sharedWithTerminal: true,
  status: loginStatus(word),
  usage: { fiveHour: {}, weekly: {} },
  usedBy: [],
  signIn: { available: true },
  checkNow: { available: true },
  signOut: { available: true, sentence: 'Sign out?', runtimesAffected: 0, signsOutTerminal: true },
  ...overrides,
});

export const loginList = (...logins: readonly LoginView[]): LoginList =>
  LoginListSchema.parse({ format: 1, machine: 'studio-mac', logins });
