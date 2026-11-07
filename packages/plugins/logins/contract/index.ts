/**
 * @ferretry/plugin-logins/contract — wire schemas, port + token, events, state and config declarations, words.
 * Logins are the AI provider sign-ins, keys, proxies and endpoints ferrets spend (§2.3). It takes the five `logins:*`
 * keys from Ferrets; secrets live in the Vault; a harness's own sign-in files are never read.
 */
import {
  defineConfig,
  defineEvent,
  definePort,
  defineState,
  type Loosens,
  neverLoosens,
  type Word,
} from '@ferretry/kernel/contract';
import type { AuthorizedOutcome, CredentialPlacement, OutboundHttpRequest } from '@ferretry/core-vault/contract';
import { z } from 'zod';
import { configDef } from './config-def.ts';
import {
  BUDGET_PERIODS,
  type EndpointFile,
  EndpointFileSchema,
  type LocalModels,
  type LoginFile,
  LoginFileSchema,
  LoginIdSchema,
  type LoginList,
  type LoginUsage,
  type LoginView,
  type ModelCatalogFile,
  ModelCatalogFileSchema,
  type ModelCatalogRefreshResult,
  type ModelCatalogsView,
  ModelsStateSchema,
  type ProviderPresetCatalog,
  LOGIN_NAME,
} from './wire.ts';

export * from './wire.ts';

/** The five login kinds this plugin takes under Ferrets' `logins` hook (§4.4). */
export const LOGIN_KINDS = ['anthropic', 'openai', 'api-key', 'proxy', 'endpoint'] as const;
export type LoginKind = (typeof LOGIN_KINDS)[number];

/** Words (§1): the glossary entries this plugin owns. */
export const LOGINS_WORDS: readonly Word[] = [
  { word: 'login', means: 'an AI provider sign-in or key a ferret spends', insteadOf: ['AI login', 'credential'] },
  { word: 'provider', means: 'the company or server behind a login', insteadOf: ['vendor'] },
  { word: 'model', means: 'which AI model a ferret uses' },
];

// ─── port ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What others read about logins: Runtimes (which login a runtime spends), Usage (budgets and quota per login),
 * Onboarding (is anything signed in), the app. Reads only; writing a login is a config file (the kernel's config
 * layer) or a route here. No method returns an access token, a refresh token or a digest of one.
 */
export interface LoginsApi {
  /** Every login on this machine, with status, usage, budget and what signing out would do. */
  list(): Promise<LoginList>;
  get(id: z.output<typeof LoginIdSchema>): Promise<LoginView | undefined>;
  /** The login's rate-limit windows and provider quota, as last read. Never reads on an idle timer. */
  quota(id: z.output<typeof LoginIdSchema>): Promise<LoginUsage | undefined>;
  /** The provider presets this machine offers (`endpoints/*.yaml` and the built-in catalogue). */
  presets(): Promise<ProviderPresetCatalog>;
  /** The model catalogs in effect and the state of the published catalog. */
  models(): Promise<ModelCatalogsView>;
  /**
   * Puts ONE login's own key on ONE request to a host it names, and returns only what came back (Usage's quota read).
   * The caller names the LOGIN and the variable that carries its key, never a secret: Logins resolves the secret from
   * that login's own record, so the only secrets reachable are the ones an owner-written login names, and the Vault
   * holds Logins to its own manifest's hosts. A login that is not an environment login, a variable that is not a single
   * `${secret:NAME}`, or a host outside the Vault's allowance is `refused`.
   */
  authorizeFetch(
    loginId: z.output<typeof LoginIdSchema>,
    variable: string,
    hostAllowlist: readonly string[],
    request: OutboundHttpRequest,
    placement?: CredentialPlacement,
  ): Promise<AuthorizedOutcome>;
}
export const LoginsPort = definePort<LoginsApi>('logins');

/** Read models others and the app may call (`manifest.data.readModels`). */
export const LOGINS_READ_MODELS = ['list', 'get', 'quota', 'presets', 'models'] as const;

// ─── events ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A sign-in finished (after the harness wrote its own store). Names the login, never a token or code. */
export const LoginSignedIn = defineEvent('logins.signed-in', z.strictObject({ loginId: LoginIdSchema }));

/** A login was added, removed, edited, signed out, switched on or off, or its status changed. */
export const LoginChanged = defineEvent(
  'logins.changed',
  z.strictObject({
    loginId: LoginIdSchema,
    change: z.enum(['added', 'removed', 'edited', 'signed-out', 'enabled', 'disabled', 'status']),
  }),
);

/** The model catalogs in effect changed (a published catalog was taken, or the local models were read). */
export const ModelsChanged = defineEvent('logins.models-changed', z.strictObject({}));

// ─── state (§9.2) ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A harness's own sign-in files, one folder per login. Ferretry links and points at them; it never opens one (the
 * property that keeps a login out of reach of a plugin).
 */
export const LOGINS_CREDENTIALS = defineState({
  name: 'credentials',
  path: 'credentials/*',
  store: 'opaque',
  format: 1,
});

export const LOGINS_MODELS = defineState({
  name: 'models',
  path: 'models.json',
  store: 'json',
  format: 1,
  schema: ModelsStateSchema,
});

// ─── config (§9.2, §7.2) ─────────────────────────────────────────────────────────────────────────────────────────

const raised = (before: number, after: number, what: string): readonly string[] =>
  after > before ? [`${what} goes up from ${String(before)} to ${String(after)}`] : [];

/**
 * Today's `loginLoosening`, word for word. A login's budget loosens when a limit goes up or goes away: a period
 * dropped, or the whole `budget`. Adding or lowering a limit tightens, and a new login loosens nothing. The login's id
 * is the file name, which the config layer knows; the sentence names it through `id`.
 */
export function loginLoosening(
  id: string,
  before: Pick<LoginFile, 'budget'> | undefined,
  after: Pick<LoginFile, 'budget'> | undefined,
): readonly string[] {
  if (before === undefined) return [];
  if (after === undefined) return before.budget === undefined ? [] : loginLoosening(id, before, {});
  return BUDGET_PERIODS.flatMap(period =>
    (['trigger', 'hard'] as const).flatMap(level => {
      const was = before.budget?.[period]?.[level];
      const now = after.budget?.[period]?.[level];
      if (was === undefined) return [];
      const what = `login "${id}"'s ${period} ${level === 'hard' ? 'hard limit' : 'trigger'} in dollars`;
      return now === undefined ? [`${what} is removed (was ${String(was)})`] : raised(was, now, what);
    }),
  );
}

/** The `loosens` of the collection: the leaf's rule gets no file name, so the sentence says "this login". */
export const loginFileLoosens: Loosens<LoginFile> = (before, after) => loginLoosening('this login', before, after);

/** `config/logins/<id>.yaml`. `configure`-axis: a remote editor needs `fleet.configure`. */
export const LOGINS_CONFIG = configDef(
  defineConfig({
    collection: 'logins',
    name: LOGIN_NAME,
    schema: LoginFileSchema,
    axis: 'configure',
    loosens: loginFileLoosens,
  }),
);

/** `config/endpoints/<id>.yaml`: provider presets as data. A preset is a template; editing one changes no login. */
export const ENDPOINTS_CONFIG = configDef(
  defineConfig({
    collection: 'endpoints',
    name: LOGIN_NAME,
    schema: EndpointFileSchema,
    axis: 'configure',
    loosens: neverLoosens,
  }),
);

/** `config/models/<name>.yaml`: model catalogs. A catalog says which model suits which work; it widens nothing. */
export const MODELS_CONFIG = configDef(
  defineConfig({
    collection: 'models',
    name: LOGIN_NAME,
    schema: ModelCatalogFileSchema,
    axis: 'configure',
    loosens: neverLoosens,
  }),
);

// ─── audit kinds this plugin records (Gate's log; names are today's events) ─────────────────────────────────────────

/** Today's `fleet.configured` (`detail.action`) and `secrets.used` (`login-test`) events. Names and ids only. */
export const LOGINS_AUDIT = {
  signIn: 'fleet.configured:sign-in',
  signInAnswer: 'fleet.configured:sign-in-answer',
  signInCancel: 'fleet.configured:sign-in-cancel',
  loginTest: 'secrets.used:login-test',
} as const;

export type { EndpointFile, LocalModels, ModelCatalogFile, ModelCatalogRefreshResult };
