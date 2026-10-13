/**
 * Fixtures for the launch-picker suites, written against the real wire schemas so a contract change
 * fails them: a picker row (`PickerAccount`), a login's health row, and the two daemon answers the
 * picker reads (`GET /v1/fleet/runtimes`, `GET /v1/fleet/credentials`).
 */

import {
  type FleetCredentialList,
  FleetCredentialListSchema,
  type FleetCredentialStatus,
  type FleetCredentialView,
  type FleetRuntimeCatalog,
  FleetRuntimeCatalogSchema,
  type FleetRuntimeView,
} from '@ferretry/protocol';
import type { PickerAccount, PickerAccountHealth } from '../../src/lib/account-picker-catalog.ts';

/** One picker row. `credentialId` defaults to one login per wrapper. */
export const pickerAccount = (overrides: Partial<PickerAccount> & { wrapper: string }): PickerAccount => ({
  id: `rt-${overrides.wrapper}`,
  displayName: overrides.wrapper,
  kind: overrides.wrapper.startsWith('codex') ? 'codex' : 'claude',
  agent: true,
  credentialId: `login-${overrides.wrapper}`,
  defaultModel: null,
  models: [],
  available: true,
  unavailableReason: null,
  ...overrides,
});

const STATUS_WORDS: Readonly<
  Record<FleetCredentialStatus['word'], readonly [string, FleetCredentialStatus['reason'], string]>
> = {
  ready: ['Ready', 'provider_accepted', 'Ready. The provider accepted this login.'],
  refresh_due: ['Refresh due', 'access_expired_refreshable', 'Refresh due. It renews the next time it is used.'],
  needs_sign_in: ['Needs sign-in', 'not_signed_in', 'Needs sign-in. Runtimes that use this login can’t launch.'],
  checking: ['Checking', 'check_in_flight', 'Checking with the provider…'],
};

/** A login status with the daemon's own words for `word`. */
export const credentialStatus = (
  word: FleetCredentialStatus['word'] = 'ready',
  overrides: Partial<FleetCredentialStatus> = {},
): FleetCredentialStatus => {
  const [label, reason, explanation] = STATUS_WORDS[word];
  return { word, label, reason, explanation, lastCheckInconclusive: false, ...overrides };
};

/** One login's health row, keyed by its credential id. */
export const pickerHealth = (
  credentialId: string,
  word: FleetCredentialStatus['word'] = 'ready',
  overrides: Partial<FleetCredentialStatus> = {},
): PickerAccountHealth => ({ ...credentialStatus(word, overrides), credentialId });

/** A health map from rows. */
export const healthMap = (...rows: readonly PickerAccountHealth[]): ReadonlyMap<string, PickerAccountHealth> =>
  new Map(rows.map(row => [row.credentialId, row] as const));

/** One runtime as `GET /v1/fleet/runtimes` publishes it. */
export const runtimeView = (overrides: Partial<FleetRuntimeView> & { wrapper: string }): FleetRuntimeView => ({
  id: `rt-${overrides.wrapper}`,
  name: overrides.wrapper,
  harness: overrides.wrapper.startsWith('codex') ? 'codex' : 'claude',
  credential: { id: `login-${overrides.wrapper}`, store: 'host', status: 'ready' },
  profile: 'Default',
  agent: true,
  stack: {
    harness: overrides.wrapper.startsWith('codex') ? 'codex' : 'claude',
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

export const runtimeCatalog = (...runtimes: readonly FleetRuntimeView[]): FleetRuntimeCatalog =>
  FleetRuntimeCatalogSchema.parse({ format: 'version-2', runtimes });

/** One login as `GET /v1/fleet/credentials` publishes it. */
export const credentialView = (
  id: string,
  word: FleetCredentialStatus['word'] = 'ready',
  overrides: Partial<FleetCredentialView> = {},
): FleetCredentialView => ({
  id,
  harness: id.includes('codex') ? 'codex' : 'claude',
  store: 'host',
  needsLabel: false,
  sharedWithTerminal: true,
  status: credentialStatus(word),
  usage: { fiveHour: {}, weekly: {} },
  usedBy: [],
  signIn: { available: true },
  checkNow: { available: true },
  signOut: { available: true, sentence: 'Sign out?', runtimesAffected: 0, signsOutTerminal: true },
  ...overrides,
});

export const credentialList = (...credentials: readonly FleetCredentialView[]): FleetCredentialList =>
  FleetCredentialListSchema.parse({ format: 2, machine: 'studio-mac', credentials });
