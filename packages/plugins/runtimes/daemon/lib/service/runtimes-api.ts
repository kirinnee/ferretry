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
import type { KnownHarnessKey } from '@ferretry/core-ferrets/contract';
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
import { deriveRuntimes, withDerived } from '../account/derived-runtimes.ts';
import type { HarnessKind } from '../manifest.ts';
import { disabledUntilMs } from '../account/disabled.ts';
import type { EnvironmentLoginTemplate, LoginView, LoginsApi } from '@ferretry/plugin-logins/contract';

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
  harnesses(): readonly KnownHarnessKey[];
  readonly logins: Pick<LoginsApi, 'list'> & Partial<Pick<LoginsApi, 'environmentTemplates'>>;
  now(): number;
  /**
   * The runtime a name it no longer carries now answers to (`ids.json` `formerNames`), or `undefined` when none claims it
   * or it cannot be read. Absent: only a runtime's own name resolves. A rename is committed in the catalogue before the
   * ferrets' records are rewritten, so a record left on the old name (a failed write, a crash between the two) still starts.
   */
  currentName?(former: string): Promise<string | undefined>;
  /** The harnesses installed here (`derived-runtimes.ts`): a login that drives both CLIs runs the first installed. Absent: not known. */
  installed?(): readonly HarnessKind[] | undefined;
}

/** The environment logins' variable templates by id, or `undefined` when Logins cannot say (an environment login is then not derived). */
async function templatesById(
  logins: RuntimesApiDeps['logins'],
): Promise<ReadonlyMap<string, EnvironmentLoginTemplate> | undefined> {
  try {
    const templates = await logins.environmentTemplates?.();
    return templates === undefined ? undefined : new Map(templates.map(template => [template.id, template]));
  } catch {
    return undefined;
  }
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

  /** The files' runtimes and profile names with the ones derived from ready logins beside them (`derived-runtimes.ts`). */
  const effective = async (logins: ReadonlyMap<string, LoginView>) => {
    const derived = deriveRuntimes({
      templates: await templatesById(deps.logins),
      runtimes: deps.runtimes(),
      profiles: deps.profiles(),
      modelSets: new Map(),
      logins: [...logins.values()],
      installed: deps.installed?.(),
    });
    return {
      runtimes: withDerived(deps.runtimes(), derived.runtimes),
      hasProfile: (name: string): boolean => deps.profiles().has(name) || derived.profiles.has(name),
    };
  };

  const read = (
    name: string,
    file: RuntimeFile,
    logins: ReadonlyMap<string, LoginView>,
    now: number,
    hasProfile: (name: string) => boolean,
  ): Read => {
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
    const profile = hasProfile(file.profile);
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
        launch,
        ...(off === undefined ? {} : { disabled: off }),
      },
    };
  };

  const all = async (): Promise<readonly Read[]> => {
    const logins = await loginsById(deps.logins);
    const now = deps.now();
    const { runtimes, hasProfile } = await effective(logins);
    return [...runtimes]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([name, file]) => read(name, file, logins, now, hasProfile));
  };

  const summaries = async (): Promise<readonly RuntimeSummary[]> =>
    (await all()).flatMap(entry => ('summary' in entry ? [entry.summary] : []));

  const defaultRuntime = async (): Promise<RuntimeId | undefined> => {
    const named = deps.defaultSetting();
    // A saved default that points at a runtime that is no longer here (a derived one whose login needs sign-in) is unset.
    if (named !== undefined && (await effective(await loginsById(deps.logins))).runtimes.has(named))
      return RuntimeIdSchema.parse(named);
    const ready = await summaries();
    const fallback = ready.find(summary => summary.id === FALLBACK_DEFAULT_RUNTIME);
    // No default named: the first runtime that can launch, Claude Code's before Codex's.
    return (
      fallback ??
      ready.find(summary => summary.harness === 'claude-code' && summary.launch.available) ??
      ready.find(summary => summary.launch.available)
    )?.id;
  };

  return {
    list: summaries,
    get: async id => (await summaries()).find(summary => summary.id === id),
    default: defaultRuntime,
    resolve: async (id): Promise<ResolveResult> => {
      const named = id ?? (await defaultRuntime());
      if (named === undefined) {
        return {
          ok: false,
          refusal: 'unknown',
          sentence: 'no runtime was named, and this machine has no default runtime for new agents',
        };
      }
      let wanted = named;
      const logins = await loginsById(deps.logins);
      const { runtimes, hasProfile } = await effective(logins);
      let file = runtimes.get(wanted);
      if (file === undefined) {
        const current = await deps.currentName?.(named).catch(() => undefined);
        const renamed = current === undefined ? undefined : runtimes.get(current);
        if (current === undefined || renamed === undefined) {
          return { ok: false, refusal: 'unknown', sentence: `no runtime ${named} exists on this machine` };
        }
        wanted = RuntimeIdSchema.parse(current);
        file = renamed;
      }
      const entry = read(wanted, file, logins, deps.now(), hasProfile);
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
      if (!hasProfile(file.profile)) {
        return { ok: false, refusal: 'no_profile', sentence: `Profile ${file.profile} does not exist` };
      }
      if (!summary.launch.available) {
        return { ok: false, refusal: 'not_signed_in', sentence: summary.launch.reason };
      }
      return { ok: true, runtime: summary };
    },
  };
}
