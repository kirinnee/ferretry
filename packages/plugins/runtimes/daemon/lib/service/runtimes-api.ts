/**
 * `RuntimesApi` (the port others read through): the runtimes on this machine, the default one, and what a start on one
 * would use or why it cannot start. Everything is read from the declared configuration (`config/runtimes/*.yaml`,
 * `config/profiles/*.yaml`, `config/runtimes.yaml`) and from the two things Runtimes needs of other subsystems: which
 * harnesses are on (Ferrets) and what state each login is in (Logins, behind {@link LoginsApi}).
 *
 * Pure apart from the seams in {@link RuntimesApiDeps}: no disk, no clock global.
 *
 * A runtime whose harness cannot be named (the file does not say, and Logins does not know its login) is not listed:
 * `resolve` answers `no_login` for it, so a start never guesses a harness. The harness of a login comes from the required Logins contract.
 */
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import { type Instant, instantFromEpochMs } from '@ferretry/std';
import {
  type ProfileFile,
  type ResolveResult,
  type RuntimeFile,
  type RuntimeFactsApi,
  type RuntimeHomesApi,
  type RuntimeLayersApi,
  type RuntimeId,
  RuntimeIdSchema,
  type RuntimesApi,
  type RuntimeSummary,
} from '../../../contract/index.ts';
import { disabledUntilMs } from '../account/disabled.ts';
import type { LoginView, LoginsApi } from '@ferretry/plugin-logins/contract';

/** The runtime a start uses when nobody names one and the setting is empty, when it is an agent runtime here. */
const FALLBACK_DEFAULT_RUNTIME = 'claude-default';

export interface RuntimesApiDeps {
  /** `config/runtimes/*.yaml`, parsed, live. */
  runtimes(): ReadonlyMap<string, RuntimeFile>;
  /** `config/profiles/*.yaml`, parsed, live. */
  profiles(): ReadonlyMap<string, ProfileFile>;
  /** `config/runtimes.yaml`'s `defaultRuntime`. */
  defaultSetting(): string | undefined;
  /** The harness keys currently on (`FerretsApi.harnesses`). */
  harnesses(): readonly HarnessKey[];
  readonly logins: Pick<LoginsApi, 'list'>;
  now(): number;
}

async function loginsById(logins: Pick<LoginsApi, 'list'>): Promise<ReadonlyMap<string, LoginView>> {
  try {
    return new Map((await logins.list()).logins.map(login => [login.id, login]));
  } catch {
    // Logins cannot say: no runtime is known to have a harness, so none launches.
    return new Map();
  }
}

/** A block in effect at `now`: one whose `until` has passed is gone with no edit. */
function activeBlock(
  block: { readonly reason?: string | undefined; readonly until?: string | undefined } | undefined,
  now: number,
): { readonly reason?: string; readonly until?: Instant } | undefined {
  if (block === undefined) return undefined;
  const until = disabledUntilMs(block.until);
  if (until !== undefined && until <= now) return undefined;
  return {
    ...(block.reason === undefined ? {} : { reason: block.reason }),
    ...(until === undefined ? {} : { until: instantFromEpochMs(until) }),
  };
}

const phrase = (block: { readonly reason?: string; readonly until?: string }): string =>
  `switched off${block.reason === undefined ? '' : ` (${block.reason})`}${block.until === undefined ? '' : ` until ${block.until}`}`;

export function createRuntimesApi(
  deps: RuntimesApiDeps,
): Omit<RuntimesApi, keyof RuntimeHomesApi | keyof RuntimeLayersApi | keyof RuntimeFactsApi> {
  type Read = { readonly summary: RuntimeSummary } | { readonly refusal: Extract<ResolveResult, { ok: false }> };

  const read = (name: string, file: RuntimeFile, logins: ReadonlyMap<string, LoginView>, now: number): Read => {
    const id = RuntimeIdSchema.parse(name);
    const login = logins.get(file.login);
    const harness = file.harness ?? login?.harness;
    if (harness === undefined) {
      return {
        refusal: {
          ok: false,
          refusal: 'no_login',
          sentence: `${name} runs on the login ${file.login}, which this machine does not know, so Ferretry cannot tell which harness it drives`,
        },
      };
    }
    const own = activeBlock(file.disabled, now);
    const viaLogin = login === undefined ? undefined : activeBlock(login.disabled, now);
    const off = own ?? viaLogin;
    const profile = deps.profiles().has(file.profile);
    let launch: RuntimeSummary['launch'] = { available: true };
    if (off !== undefined) {
      launch = {
        available: false,
        reason: own !== undefined ? `${name} is ${phrase(off)}` : `Its login ${file.login} is ${phrase(off)}`,
      };
    } else if (!profile) {
      launch = { available: false, reason: `Profile ${file.profile} does not exist` };
    } else if (login === undefined) {
      launch = { available: false, reason: `Login ${file.login} does not exist` };
    } else if (login.status.word === 'needs_sign_in') {
      launch = { available: false, reason: `Login ${file.login} needs sign-in` };
    } else if (!deps.harnesses().includes(harness)) {
      launch = { available: false, reason: `${harness} is not on this machine` };
    }
    return {
      summary: {
        id,
        harness,
        login: file.login,
        profile: file.profile,
        agent: file.agent,
        launch,
        ...(off === undefined ? {} : { disabled: off }),
      },
    };
  };

  const all = async (): Promise<readonly Read[]> => {
    const logins = await loginsById(deps.logins);
    const now = deps.now();
    return [...deps.runtimes()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([name, file]) => read(name, file, logins, now));
  };

  const summaries = async (): Promise<readonly RuntimeSummary[]> =>
    (await all()).flatMap(entry => ('summary' in entry ? [entry.summary] : []));

  const defaultRuntime = async (): Promise<RuntimeId | undefined> => {
    const named = deps.defaultSetting();
    if (named !== undefined) return RuntimeIdSchema.parse(named);
    const fallback = deps.runtimes().get(FALLBACK_DEFAULT_RUNTIME);
    return fallback?.agent === true ? RuntimeIdSchema.parse(FALLBACK_DEFAULT_RUNTIME) : undefined;
  };

  return {
    list: summaries,
    get: async id => (await summaries()).find(summary => summary.id === id),
    default: defaultRuntime,
    resolve: async (id): Promise<ResolveResult> => {
      const wanted = id ?? (await defaultRuntime());
      if (wanted === undefined) {
        return {
          ok: false,
          refusal: 'unknown',
          sentence: 'no runtime was named, and this machine has no default runtime for new agents',
        };
      }
      const file = deps.runtimes().get(wanted);
      if (file === undefined) {
        return { ok: false, refusal: 'unknown', sentence: `no runtime ${wanted} exists on this machine` };
      }
      const logins = await loginsById(deps.logins);
      const entry = read(wanted, file, logins, deps.now());
      if ('refusal' in entry) return entry.refusal;
      if (!logins.has(file.login)) {
        return { ok: false, refusal: 'no_login', sentence: `Login ${file.login} does not exist` };
      }
      const { summary } = entry;
      if (summary.disabled !== undefined) {
        return {
          ok: false,
          refusal: 'disabled',
          sentence: summary.launch.available ? `${wanted} is switched off` : summary.launch.reason,
        };
      }
      if (!deps.profiles().has(file.profile)) {
        return { ok: false, refusal: 'no_profile', sentence: `Profile ${file.profile} does not exist` };
      }
      if (!summary.launch.available) {
        return { ok: false, refusal: 'not_signed_in', sentence: summary.launch.reason };
      }
      return { ok: true, runtime: summary };
    },
  };
}
