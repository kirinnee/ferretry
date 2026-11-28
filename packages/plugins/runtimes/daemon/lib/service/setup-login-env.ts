/**
 * The two Logins-facing steps of a setup apply (r9 A8), kept beside `setup-service.ts` so that file stays in its size limit:
 * creating the logins an import plans (through Logins' own change port), and adding each imported harness's own `env` to the
 * login the apply selected or created (through Logins' env-import port). Names and words only: never a value.
 */
import type { LoginEnvImportApi, LoginEnvImportOutcome } from '@ferretry/plugin-logins/contract';
import { displayNameOf } from '../harness-kind.ts';
import type { ImportedLoginEnv } from '../account/import.ts';
import type { HarnessKind } from '../manifest.ts';
import { FleetCatalogRefusal, type ExecutorCaller, type FleetCatalogServiceDeps } from './catalog-service.ts';
import type { WriteNotes } from './apply-ledger.ts';
import { harnessKey } from './foreign.ts';

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : String(error);

/** The logins this import plans to create (the model's credentials are only a name until Logins has a file for each). */
interface PlannedLogin {
  readonly id: string;
  readonly harness: HarnessKind;
  readonly store: string;
}

/** What the apply holds that these steps read: the plan's logins, its envs, the secrets it filed, the ones it reused and the ticked names. */
export interface LoginEnvPlan {
  readonly newLogins?: readonly PlannedLogin[];
  readonly loginEnvs?: readonly ImportedLoginEnv[];
  readonly tickedEnv?: readonly string[];
  readonly secrets: readonly { readonly name: string; readonly value: string }[];
  /** Names of keys an earlier import filed with this value: not filed again, but bound like a filed one (names only). */
  readonly reused?: readonly string[];
}

/** What an import of a harness's variables into its login did, in names and words (never a value). */
function loginEnvSentences(label: string, login: string, outcome: LoginEnvImportOutcome): string[] {
  if (outcome.outcome === 'refused') {
    return [`The variables of your ${label} settings were not added to login ${login}: ${outcome.reason}.`];
  }
  const skipped = outcome.skipped.map(entry => `${entry.name} (${entry.because})`);
  const left = skipped.length === 0 ? [] : [`Left out of login ${login}: ${skipped.join('; ')}.`];
  if (outcome.outcome === 'unchanged') return left;
  return [
    `Added to login ${login}: ${outcome.added.join(', ')}.`,
    ...(outcome.outcome === 'held' ? [`That change waits for you to confirm it: ${outcome.sentences.join(' ')}`] : []),
    ...left,
  ];
}

/**
 * Creates each login this import plans that Logins does not have yet (`login.add`, staged and applied through Logins' own
 * change port: its schema, its refusals, its events). One that already exists is left as it is. A refusal stops the apply
 * before any runtime is written (the fleet writer persists Runtimes' own documents only, so it never makes the login's file) and
 * says which login, and what was already kept.
 */
export async function createLogins(
  catalog: Pick<FleetCatalogServiceDeps, 'credentials' | 'loginChanges'>,
  plan: LoginEnvPlan,
  /** Called before each login is created: throws once the request has ended, so the next login is never written. */
  live?: () => void,
  /** The apply's ledger: told each login as it is created, and each one that was already there. */
  notes?: Pick<WriteNotes, 'login' | 'existingLogin'>,
): Promise<void> {
  const wanted = plan.newLogins ?? [];
  if (wanted.length === 0) return;
  const { credentials, loginChanges } = catalog;
  const have = new Set((await credentials.list()).logins.map(login => String(login.id)));
  for (const login of wanted) {
    if (have.has(login.id)) {
      notes?.existingLogin(login.id);
      continue;
    }
    live?.();
    const refused = (error: unknown): FleetCatalogRefusal =>
      new FleetCatalogRefusal(
        'fleet_change_failed',
        `Logins could not create the login ${login.id}: ${errorMessage(error)}. Nothing else was changed${plan.secrets.length === 0 ? '' : '; the keys already added to the secret store stay there'}.`,
      );
    let staged: Awaited<ReturnType<typeof loginChanges.stage>>;
    try {
      staged = await loginChanges.stage({
        kind: 'login.add',
        id: login.id,
        harness: harnessKey(login.harness),
        store: login.store as 'host' | 'ferretry' | 'environment',
      });
    } catch (error) {
      throw refused(error);
    }
    // Staging awaited Logins' door: a request that ended meanwhile never applies the login (the stage stays pending).
    live?.();
    try {
      await loginChanges.apply(staged.id);
    } catch (error) {
      throw refused(error);
    }
    notes?.login(login.id);
  }
}

/**
 * Adds each imported harness's own `env` to the login this apply selected or created, once the login is in effect (r9 A8).
 * The secrets are already filed (every create-only put above succeeded) or were reused from an earlier import, so `minted` is
 * exactly the keys this apply holds: a variable whose secret was neither is left out. Never throws: what could not be added is said in a sentence, and the
 * import that landed stays landed. The one exception is the request ending (`caller.live` throws `499`): the next login's
 * variables are then not written.
 */
export async function importLoginEnvs(
  port: LoginEnvImportApi | undefined,
  plan: LoginEnvPlan,
  caller?: ExecutorCaller,
  /** The apply's ledger: told each login whose variables were really added. */
  notes?: Pick<WriteNotes, 'loginVariables'>,
): Promise<string[]> {
  const envs = plan.loginEnvs ?? [];
  if (envs.length === 0) return [];
  // A machine wired without the door adds nothing to a login, as before r9 A8: there is no one to ask.
  if (port === undefined) return [];
  const filed = new Set([...plan.secrets.map(secret => secret.name), ...(plan.reused ?? [])]);
  const sentences: string[] = [];
  for (const env of envs) {
    // The one throw: a request that has ended stops before the next login's variables are written (what landed stays).
    caller?.live?.();
    const label = displayNameOf(env.harness);
    let outcome: LoginEnvImportOutcome;
    try {
      outcome = await port.import({
        caller: { governance: caller?.governance },
        login: env.login,
        harness: harnessKey(env.harness),
        plain: env.plain,
        minted: env.minted.filter(entry => filed.has(entry.secretName)),
        ticked: plan.tickedEnv ?? [],
      });
    } catch (error) {
      caller?.left?.('refused');
      sentences.push(
        `The variables of your ${label} settings were not added to login ${env.login}: ${errorMessage(error)}.`,
      );
      continue;
    }
    if (outcome.outcome === 'refused') caller?.left?.('refused');
    else if (outcome.outcome === 'held') caller?.left?.('held');
    else if (outcome.outcome !== 'unchanged') notes?.loginVariables(env.login);
    sentences.push(...loginEnvSentences(label, env.login, outcome));
  }
  return sentences;
}

/**
 * The GitHub token variables a change ticked, names only. Read structurally until the wire arm carries the field
 * (the import wizard adds `tickedEnv` to `setup.import`); anything that is not a list of strings is nothing ticked.
 */
export function tickedEnvOf(change: object): readonly string[] {
  const named = (change as { tickedEnv?: unknown }).tickedEnv;
  return Array.isArray(named) ? named.filter((name): name is string => typeof name === 'string') : [];
}

/**
 * What an import plan hands the apply for Logins: the plan's `env`s, the ticked names and the logins to create (the model's
 * credentials are only a name until Logins has a file), and a digest of each `env` so what the login environments will
 * hold is part of what was reviewed (host text and secret NAMES; never a value filed).
 */
export function loginEnvPlanOf(
  change: object,
  plan: {
    readonly loginEnvs: readonly ImportedLoginEnv[];
    readonly credentials: Readonly<Record<string, { readonly harness: HarnessKind; readonly store: string }>>;
  },
  digest: (text: string) => string,
): { readonly fields: Omit<LoginEnvPlan, 'secrets'>; readonly digests: readonly string[] } {
  const newLogins = Object.entries(plan.credentials).map(([id, credential]) => ({
    id,
    harness: credential.harness,
    store: credential.store,
  }));
  return {
    fields: { loginEnvs: plan.loginEnvs, tickedEnv: tickedEnvOf(change), newLogins },
    digests: plan.loginEnvs.map(env =>
      digest(`${env.harness}\n${env.login}\n${JSON.stringify([env.plain, env.minted])}`),
    ),
  };
}
