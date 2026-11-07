/**
 * @ferretry/plugin-logins/contract/testing — the fake and the conformance suite (§7.8). The real implementation and
 * the fake pass the same suite.
 */
import { err, instantFromEpochMs, ok, type Result } from '@ferretry/std';
import {
  type LoginChange,
  LoginChangeError,
  type LoginChangeOutcome,
  type LoginChangeView,
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
  /** Every change staged through `changes.stage`, in order. */
  readonly staged: readonly LoginChange[];
  /** Every id applied through `changes.apply`, in order. */
  readonly applied: readonly string[];
  /** What the next `apply` answers (default: applied). */
  setOutcome(outcome: LoginChangeOutcome): void;
  /** Refuse the next `stage` (or every one, until cleared with `undefined`) the way the real service does. */
  refuseStage(error: LoginChangeError | undefined): void;
  refuseApply(error: LoginChangeError | undefined): void;
}

const FAKE_EXPIRY = instantFromEpochMs(4_070_908_800_000);

export function fakeLogins(initial: readonly LoginView[] = []): FakeLogins {
  let logins = [...initial];
  const list = (): LoginList => LoginListSchema.parse({ format: 1, machine: 'fake', logins });
  const staged: LoginChange[] = [];
  const applied: string[] = [];
  let outcome: LoginChangeOutcome = { outcome: 'applied' };
  let stageRefusal: LoginChangeError | undefined;
  let applyRefusal: LoginChangeError | undefined;
  return {
    staged,
    applied,
    setOutcome: next => {
      outcome = next;
    },
    refuseStage: error => {
      stageRefusal = error;
    },
    refuseApply: error => {
      applyRefusal = error;
    },
    changes: {
      stage: async change => {
        if (stageRefusal !== undefined) throw stageRefusal;
        staged.push(change);
        return {
          id: `change-${String(staged.length)}`,
          change,
          summary: `fake ${change.kind} ${change.id}`,
          consequences: [],
          expiresAt: FAKE_EXPIRY,
          state: 'pending',
        } satisfies LoginChangeView;
      },
      apply: async id => {
        if (applyRefusal !== undefined) throw applyRefusal;
        applied.push(id);
        return outcome;
      },
    },
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
