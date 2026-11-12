/**
 * The five login kinds Logins adds to Ferrets' `logins:*` hook (§4.4): `anthropic` and `openai` are the harnesses' own
 * sign-ins; `api-key`, `proxy` and `endpoint` are environment logins made from a provider preset.
 *
 * **A kind never returns a value.** `env` hands back what the login file holds, which is `${secret:NAME}` references
 * (or plain, non-secret settings): a file that held a raw secret was refused when it was read, and this refuses it a
 * second time rather than trust that. `status` and `quota` are words and percentages. The daemon holds no token at all.
 */
import type {
  HarnessKey,
  LoginCredentialAnswer,
  LoginField,
  LoginKind,
  LoginQuota,
  LoginStatus,
  SignInFlow,
} from '@ferretry/core-ferrets/contract';
import type { Clock, SharedCredential } from '@ferretry/kernel/contract';
import { err, milliseconds, ok, type Result } from '@ferretry/std';
import type { LOGIN_KINDS, LoginFile, LoginView } from '../../contract/index.ts';
import type { HarnessLoginFlow } from '../../contract/index.ts';
import type { LaunchStore } from './credentials/credentials-service.ts';
import { harnessKey } from './shared/harness.ts';
import { looksLikeRawSecret } from '../../contract/secret-shape.ts';

type KindKey = (typeof LOGIN_KINDS)[number];

/**
 * The one sentence for a sign-in file the kernel will not share because it is not a plain file with one name: it says what
 * to remove or redo, and names no path (the owner already sees the login).
 */
export function notPlainFileSentence(login: string): string {
  return `the sign-in file of the login ${login} is not a plain file with a single name (another link to it exists, or it is itself a link); remove the extra link, or sign the login out and in again from Logins, then start the ferret again`;
}

/** What the kinds need of the rest of this half. */
export interface LoginKindDeps {
  readonly clock: Pick<Clock, 'sleep'>;
  readonly files: () => ReadonlyMap<string, LoginFile>;
  view(id: string): Promise<LoginView | undefined>;
  check(id: string): Promise<LoginView>;
  startSignIn(id: string): Promise<HarnessLoginFlow>;
  signInStatus(flowId: string): Promise<HarnessLoginFlow>;
  /** Why this login's sign-in FILE cannot be handed to a harness (not owned, no tokens), in one sentence; `undefined` when it can. */
  credentialProblem(id: string): Promise<string | undefined>;
  /**
   * The kernel's shared credential for this login's sign-in file; `'not_own'` when the file is not a plain file with one
   * name (something is linked to it, or it is a link); `undefined` when it could not be shared. Never renews.
   */
  shareCredential(id: string): Promise<SharedCredential | 'not_own' | undefined>;
  /**
   * How this login's store takes part in a launch: for a Ferretry-kept Claude login the one secure-storage variable
   * (naming its store directory) and whether the store NOW holds material that can be launched with; for a host-kept
   * one the empty selector (v4), read nowhere; nothing for any other.
   */
  launchStore(id: string): Promise<LaunchStore>;
}

/** Presets whose login is an endpoint behind another company's gateway (a proxy), not the provider's own key. */
const PROXY_PRESETS: ReadonlySet<string> = new Set(['litellm', 'custom-gateway', 'vercel-ai-gateway', 'openrouter']);

/** Which kind a login file is. A sign-in is its harness's; an environment login is a key, a proxy or an endpoint. */
export function kindOf(file: LoginFile): KindKey {
  if (file.store !== 'environment') return file.harness === 'codex' ? 'openai' : 'anthropic';
  if (file.preset !== undefined && PROXY_PRESETS.has(file.preset)) return 'proxy';
  if (file.preset !== undefined && file.preset.endsWith('api-key')) return 'api-key';
  return 'endpoint';
}

const KEY_FIELD: LoginField = { id: 'api-key', label: 'API key', secret: true };
const URL_FIELD: LoginField = { id: 'base-url', label: 'Base URL', secret: false };

const FIELDS: Readonly<Record<KindKey, readonly LoginField[]>> = {
  anthropic: [],
  openai: [],
  'api-key': [KEY_FIELD],
  proxy: [URL_FIELD, KEY_FIELD],
  endpoint: [URL_FIELD, KEY_FIELD],
};

const HARNESSES: Readonly<Record<KindKey, readonly HarnessKey[]>> = {
  anthropic: [harnessKey('claude')],
  openai: [harnessKey('codex')],
  'api-key': [harnessKey('claude'), harnessKey('codex')],
  proxy: [harnessKey('claude'), harnessKey('codex')],
  endpoint: [harnessKey('claude'), harnessKey('codex')],
};

const POLL_MS = 250;
const POLLS = 20;

function statusOf(view: LoginView): LoginStatus {
  const { word, explanation } = view.status;
  if (word === 'needs_sign_in') return { state: 'signed-out', sentence: explanation };
  return { state: 'signed-in' };
}

function quotaOf(view: LoginView): LoginQuota | undefined {
  const five = view.usage.fiveHour;
  const week = view.usage.weekly;
  if (five.usedPercent === undefined && week.usedPercent === undefined) return undefined;
  const resetsAt = five.resetsAt ?? week.resetsAt;
  return {
    ...(five.usedPercent === undefined ? {} : { fiveHourPercent: five.usedPercent }),
    ...(week.usedPercent === undefined ? {} : { weeklyPercent: week.usedPercent }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function flowOf(flow: HarnessLoginFlow): SignInFlow | undefined {
  if (flow.state === 'complete') return { kind: 'done' };
  if (flow.state === 'awaiting-code' || flow.state === 'awaiting-callback') {
    return { kind: 'browser', url: flow.verificationUrl };
  }
  if (flow.state === 'awaiting-approval') {
    return { kind: 'device-code', url: flow.verificationUrl, code: flow.userCode };
  }
  if (flow.state === 'failed') throw new Error(flow.reason);
  return undefined;
}

export function loginKinds(deps: LoginKindDeps): Readonly<Record<KindKey, LoginKind>> {
  const known = (login: string, kind: KindKey): LoginFile => {
    const file = deps.files().get(login);
    if (file === undefined || kindOf(file) !== kind) throw new Error(`there is no ${kind} login named ${login}`);
    return file;
  };
  const viewOf = async (login: string, kind: KindKey): Promise<LoginView> => {
    known(login, kind);
    const view = await deps.view(login);
    if (view === undefined) throw new Error(`there is no ${kind} login named ${login}`);
    return view;
  };

  /**
   * Claude's launch variable for a sign-in, or why none can be given. Claude's store is a file under the store directory
   * on Linux and a keychain item hashed from that same directory on macOS, so the one variable selects it on both, and
   * the launch keeps the real HOME (the macOS keychain search list is found through it).
   *
   * A Ferretry-kept sign-in that is not there refuses the start instead of launching a pane that would sit signed out,
   * and so does one whose material is not usable NOW. The latter is judged from the local store, never from the
   * displayed status (which keeps its last-known state when the material cannot be read), with a fixed sentence that
   * quotes nothing. A host-kept sign-in is admitted with the EMPTY selector and is not read, as in v4: the real HOME
   * is kept, so Claude selects the person's own default store, which this build has no authority to look into.
   */
  const claudeLaunch = async (
    login: string,
    harness: HarnessKey,
  ): Promise<Result<Readonly<Record<string, string>>, string>> => {
    if (harness !== harnessKey('claude')) return ok({});
    const view = await viewOf(login, 'anthropic');
    const store = await deps.launchStore(login);
    if (store.kind === 'host') return ok(store.variables);
    const status = statusOf(view);
    if (status.state !== 'signed-in')
      return err(`the login ${login} is not signed in (${status.sentence}), so the ferret was not started`);
    if (store.kind === 'owned' && !store.usable)
      return err(`the login ${login} has sign-in material this build cannot use, so the ferret was not started`);
    return ok(store.kind === 'owned' ? store.variables : {});
  };

  const make = (key: KindKey): LoginKind => ({
    key,
    fields: FIELDS[key],
    harnesses: HARNESSES[key],
    holds(login) {
      const file = deps.files().get(login);
      return file !== undefined && kindOf(file) === key;
    },
    async signIn(login) {
      const file = known(login, key);
      // A key, a proxy or an endpoint is a config file plus a Vault secret: there is nothing to sign in to.
      if (file.store === 'environment') return { kind: 'done' };
      let flow = await deps.startSignIn(login);
      for (let polled = 0; polled < POLLS; polled += 1) {
        const mapped = flowOf(flow);
        if (mapped !== undefined) return mapped;
        await deps.clock.sleep(milliseconds(POLL_MS));
        flow = await deps.signInStatus(flow.flowId);
      }
      throw new Error('the harness has not offered a sign-in yet; try again');
    },
    status: async login => statusOf(await viewOf(login, key)),
    ...(key === 'anthropic' || key === 'openai'
      ? { refresh: async (login: string) => statusOf(await deps.check(login)) }
      : {}),
    quota: async login => quotaOf(await viewOf(login, key)),
    ...(key === 'anthropic'
      ? {
          launchEnvironment: async (login: string, harness: HarnessKey) => {
            try {
              return await claudeLaunch(login, harness);
            } catch {
              return err(`the login ${login} could not be read, so the ferret was not started`);
            }
          },
        }
      : {}),
    // Only a Codex sign-in is a FILE a harness reads. Claude's reaches a ferret as environment (`env`/launch environment).
    ...(key === 'openai'
      ? {
          credential: async (login: string, harness: HarnessKey): Promise<LoginCredentialAnswer> => {
            const unavailable = (sentence: string): LoginCredentialAnswer => ({ kind: 'unavailable', sentence });
            known(login, key);
            if (harness !== harnessKey('codex')) return unavailable(`the login ${login} is spent by Codex only`);
            // The store and the file's state come first; the status word is the cached reading, never a renewal.
            const problem = await deps.credentialProblem(login);
            if (problem !== undefined) return unavailable(problem);
            const view = await viewOf(login, key);
            if (view.status.word === 'needs_sign_in')
              return unavailable(`the login ${login} needs signing in: ${view.status.explanation}`);
            const credential = await deps.shareCredential(login);
            if (credential === 'not_own') return unavailable(notPlainFileSentence(login));
            if (credential === undefined)
              return unavailable(`the sign-in file of the login ${login} could not be shared with Codex`);
            return { kind: 'file', credential };
          },
        }
      : {}),
    async env(login, harness) {
      const file = known(login, key);
      const half = harness === harnessKey('codex') ? file.codex : file.claude;
      const merged = { ...(file.env ?? {}), ...(half?.env ?? {}) };
      const out: Record<string, string> = {};
      for (const [name, value] of Object.entries(merged)) {
        // Only references and plain settings leave; a value that looks like a secret is dropped, not passed on.
        if (!looksLikeRawSecret(name, value)) out[name] = value;
      }
      return out;
    },
  });

  return {
    anthropic: make('anthropic'),
    openai: make('openai'),
    'api-key': make('api-key'),
    proxy: make('proxy'),
    endpoint: make('endpoint'),
  };
}
