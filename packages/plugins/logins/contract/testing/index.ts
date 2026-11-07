/**
 * @ferretry/plugin-logins/contract/testing — the fake and the conformance suite (§7.8). The real implementation and
 * the fake pass the same suite.
 */
import { err, ok, type Result } from '@ferretry/std';
import {
  type LoginId,
  type LoginList,
  LoginListSchema,
  type LoginsApi,
  LoginUsageSchema,
  type LoginView,
  LoginViewSchema,
  ModelCatalogsViewSchema,
  ProviderPresetCatalogSchema,
} from '../index.ts';

/** A signed-in `host` login with no usage measured: the smallest honest row. */
export function sampleLogin(id: string, overrides: Partial<LoginView> = {}): LoginView {
  return LoginViewSchema.parse({
    id,
    harness: 'claude-code',
    harnesses: ['claude-code'],
    store: 'host',
    needsLabel: false,
    sharedWithTerminal: true,
    status: {
      word: 'ready',
      label: 'Ready',
      reason: 'access_current',
      explanation: 'The access token is current.',
      lastCheckInconclusive: false,
    },
    usage: { fiveHour: {}, weekly: {} },
    usedBy: [],
    signIn: { available: false, reason: 'already signed in' },
    checkNow: { available: true },
    signOut: { available: true, sentence: 'Sign out of this login?', runtimesAffected: 0, signsOutTerminal: true },
    ...overrides,
  });
}

export interface FakeLogins extends LoginsApi {
  setLogins(logins: readonly LoginView[]): void;
}

export function fakeLogins(initial: readonly LoginView[] = []): FakeLogins {
  let logins = [...initial];
  const list = (): LoginList => LoginListSchema.parse({ format: 1, machine: 'fake', logins });
  return {
    list: async () => list(),
    get: async id => logins.find(login => login.id === id),
    quota: async id => logins.find(login => login.id === id)?.usage,
    presets: async () => ProviderPresetCatalogSchema.parse({ presets: [] }),
    models: async () =>
      ModelCatalogsViewSchema.parse({ published: { origin: 'https://example.invalid', enabled: false }, catalogs: [] }),
    setLogins: next => {
      logins = [...next];
    },
  };
}

/** What every implementation of `LoginsApi` must satisfy. Failures come back as sentences so any runner can report them. */
export async function loginsConformance(make: () => LoginsApi): Promise<Result<true, readonly string[]>> {
  const failures: string[] = [];
  const api = make();
  const list = await api.list();
  if (!LoginListSchema.safeParse(list).success) failures.push('list() returns a LoginList');
  for (const login of list.logins) {
    const got = await api.get(login.id);
    if (got?.id !== login.id) failures.push(`get(${login.id}) finds a listed login`);
    const usage = await api.quota(login.id);
    if (usage !== undefined && !LoginUsageSchema.safeParse(usage).success)
      failures.push('quota() returns a LoginUsage');
    // The wire has no field for a token or a digest: a row that carries one is not a LoginView.
    if (LoginViewSchema.safeParse({ ...login, accessToken: 'x' }).success) failures.push('a row refuses a token field');
  }
  if ((await api.get('no-such-login' as LoginId)) !== undefined)
    failures.push('get() of an unknown login is undefined');
  if (!ProviderPresetCatalogSchema.safeParse(await api.presets()).success) failures.push('presets() returns a catalog');
  if (!ModelCatalogsViewSchema.safeParse(await api.models()).success)
    failures.push('models() returns the catalogs view');
  return failures.length === 0 ? ok(true) : err(failures);
}
