/**
 * @ferretry/plugin-logins/contract/testing — the fake and the conformance suite (§7.8). The real implementation and
 * the fake pass the same suite.
 */
import type { AuthorizedOutcome } from '@ferretry/core-vault/contract';
import { err, instantFromEpochMs, ok, type Result } from '@ferretry/std';
import {
  type EnvironmentLoginTemplate,
  type LoginChange,
  type LoginChangesApi,
  LoginChangeError,
  type LoginChangeOutcome,
  type LoginChangeView,
  type LoginId,
  type LoginLaunchStore,
  type LoginList,
  LoginListSchema,
  type LoginsApi,
  LoginUsageSchema,
  type LoginView,
  LoginViewSchema,
  type ModelCatalogSourcesView,
  ModelCatalogSourcesSchema,
  ModelCatalogsViewSchema,
  type ModelPriceCatalog,
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
  /** What `environmentTemplates` answers (default none): variable templates, never a secret's value. */
  setTemplates(templates: readonly EnvironmentLoginTemplate[]): void;
  /** What `launchStores` answers (default none): a login's store variable, never a value. */
  setLaunchStores(stores: readonly LoginLaunchStore[]): void;
  /** What `modelPrices` answers (default none): the catalogs' list prices, public data. */
  setModelPrices(catalogs: readonly ModelPriceCatalog[]): void;
  /** What `modelSources` answers (default none): the catalogs and preset slice Runtimes derives models from. */
  setModelSources(sources: ModelCatalogSourcesView): void;
  /** Every `authorizeFetch` asked, as asked (a login, a variable, hosts; never a secret). */
  readonly spends: { readonly loginId: string; readonly variable: string; readonly hosts: readonly string[] }[];
  /** What `authorizeFetch` answers next (default `refused`). */
  answerSpend(outcome: AuthorizedOutcome): void;
}

/** The change path as a fake: it records what was staged and applied, and refuses on request. */
export interface FakeLoginChanges extends LoginChangesApi {
  /** Every change staged through `changes.stage`, in order. */
  readonly staged: readonly LoginChange[];
  /** Every id applied through `changes.apply`, in order. */
  readonly applied: readonly string[];
  /** What the next `apply` answers (default: applied). */
  setOutcome(outcome: LoginChangeOutcome): void;
  /** Refuse the next `stage` (or every one, until cleared with `undefined`) the way the real service does. */
  refuseStage(error: LoginChangeError | undefined): void;
  refuseApply(error: LoginChangeError | undefined): void;
  /** The `usersMovedFirst` of every `stage`, in order. */
  readonly movedFirst: readonly (readonly string[])[];
  /** Every id discarded, in order. */
  readonly discarded: readonly string[];
}

const FAKE_EXPIRY = instantFromEpochMs(4_070_908_800_000);

export function fakeLoginChanges(): FakeLoginChanges {
  const staged: LoginChange[] = [];
  const movedFirst: (readonly string[])[] = [];
  const applied: string[] = [];
  const discarded: string[] = [];
  let outcome: LoginChangeOutcome = { outcome: 'applied' };
  let stageRefusal: LoginChangeError | undefined;
  let applyRefusal: LoginChangeError | undefined;
  return {
    staged,
    applied,
    movedFirst,
    discarded,
    setOutcome: next => {
      outcome = next;
    },
    refuseStage: error => {
      stageRefusal = error;
    },
    refuseApply: error => {
      applyRefusal = error;
    },
    stage: async (change, options) => {
      if (stageRefusal !== undefined) throw stageRefusal;
      staged.push(change);
      movedFirst.push(options?.usersMovedFirst ?? []);
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
    discard: async id => {
      discarded.push(id);
    },
  };
}

export function fakeLogins(initial: readonly LoginView[] = []): FakeLogins {
  let logins = [...initial];
  let templates: readonly EnvironmentLoginTemplate[] = [];
  let launchStores: readonly LoginLaunchStore[] = [];
  let prices: readonly ModelPriceCatalog[] = [];
  let sources: ModelCatalogSourcesView = ModelCatalogSourcesSchema.parse({ catalogs: {}, presets: [] });
  let spendAnswer: AuthorizedOutcome = { kind: 'refused' };
  const spends: FakeLogins['spends'] = [];
  const list = (): LoginList => LoginListSchema.parse({ format: 1, machine: 'fake', logins });
  return {
    list: async () => list(),
    get: async id => logins.find(login => login.id === id),
    quota: async id => logins.find(login => login.id === id)?.usage,
    environmentTemplates: async () => templates,
    launchStores: async () => launchStores,
    presets: async () => ProviderPresetCatalogSchema.parse({ presets: [] }),
    models: async () =>
      ModelCatalogsViewSchema.parse({ published: { origin: 'https://example.invalid', enabled: false }, catalogs: [] }),
    modelPrices: async () => prices,
    modelSources: async () => sources,
    authorizeFetch: async (loginId, variable, hosts) => {
      spends.push({ loginId, variable, hosts });
      return spendAnswer;
    },
    spends,
    answerSpend: outcome => {
      spendAnswer = outcome;
    },
    setLogins: next => {
      logins = [...next];
    },
    setModelSources: next => {
      sources = next;
    },
    setModelPrices: next => {
      prices = [...next];
    },
    setTemplates: next => {
      templates = [...next];
    },
    setLaunchStores: next => {
      launchStores = [...next];
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
  if (!ModelCatalogSourcesSchema.safeParse(await api.modelSources()).success)
    failures.push('modelSources() returns the catalog sources');
  return failures.length === 0 ? ok(true) : err(failures);
}
