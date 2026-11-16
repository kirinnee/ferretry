import type { LoginsApi } from '@ferretry/plugin-logins/contract';
import { RuntimeIdSchema, type RuntimesApi, type RuntimeView } from '@ferretry/plugin-runtimes/contract';
import type { PaneLimitView, UsageApi } from '@ferretry/plugin-usage/contract';
import type { PackCredentialFacts, PackQuotaSource, PaneLimit } from '../../contract/index.ts';
import type { PackFleetFacts } from '../lib/recommend.ts';

/**
 * The limits live panes prove, as Usage owns them (`UsageApi.paneLimits`), by the login each runtime spends: a limit is
 * the login's whichever runtime's ferret hit it (v4's `limitedCredentials`). A ferret whose record names no login is
 * known by its runtime, which the catalog maps to a login here.
 */
function paneLimitsOf(
  limits: readonly PaneLimitView[],
  runtimes: readonly Pick<RuntimeView, 'name' | 'credential'>[],
): ReadonlyMap<string, PaneLimit> {
  const byCredential = new Map<string, PaneLimit>();
  const add = (credential: string, limit: PaneLimitView): void => {
    if (byCredential.has(credential)) return;
    byCredential.set(credential, {
      notice: limit.notice,
      spend: limit.spend,
      ...(limit.retryAt === undefined ? {} : { retryAt: limit.retryAt }),
    });
  };
  for (const limit of limits) if (limit.login !== undefined) add(limit.login, limit);
  for (const runtime of runtimes) {
    const limit = limits.find(candidate => candidate.login === undefined && candidate.runtime === runtime.name);
    if (limit !== undefined) add(runtime.credential.id, limit);
  }
  return byCredential;
}

/**
 * The runtimes, logins, tools and pane limits `recommend` judges readiness from — one reader, so a start never refuses a
 * runtime this list called ready. Every provider is optional (§2.3): with Runtimes off (or one that offers no
 * `catalog()`/`tools()`) there is no runtime to offer, with Logins off no login reads as measured, with Usage off no
 * pane limit is known from its feed. Logins and Usage only add what a login has left, so one that fails to answer is
 * read as having nothing to say (a login's quota then reads `unknown`: never full, never empty); Runtimes failing is not
 * hidden, because "no model is usable" would then be a lie.
 *
 * Pane limits come from two readers of the same evidence and only ever ADD a limit the provider did not say: the live
 * ferrets themselves (`ferretLimits`, the Ferrets port's `list()` + `prompt().limit`, `adapters/login-quota.ts`), whose
 * answer wins for a login it names, and Usage's feed (`UsageApi.paneLimits`), which also knows a ferret that recorded
 * no login by its runtime.
 */
export class FleetFacts {
  constructor(
    private readonly runtimes: () => RuntimesApi | undefined,
    private readonly logins: () => Pick<LoginsApi, 'list'> | undefined,
    private readonly usage: () => Pick<UsageApi, 'paneLimits'> | undefined,
    private readonly now: () => string,
    private readonly ferretLimits: () => Pick<PackQuotaSource, 'paneLimits'> | undefined = () => undefined,
  ) {}

  async facts(): Promise<PackFleetFacts> {
    const runtimes = this.runtimes();
    const logins = this.logins();
    const usage = this.usage();
    const ferretLimits = this.ferretLimits();
    const [catalog, tools, credentials, panes, proven] = await Promise.all([
      runtimes?.catalog?.() ?? [],
      runtimes?.tools?.() ?? [],
      logins === undefined
        ? ([] as readonly PackCredentialFacts[])
        : settle(async () => (await logins.list()).logins as readonly PackCredentialFacts[], []),
      usage === undefined ? ([] as readonly PaneLimitView[]) : settle(async () => await usage.paneLimits(), []),
      ferretLimits === undefined
        ? (new Map() as ReadonlyMap<string, PaneLimit>)
        : settle(async () => await ferretLimits.paneLimits(), new Map() as ReadonlyMap<string, PaneLimit>),
    ]);
    const paneLimits = new Map(paneLimitsOf(panes, catalog));
    for (const [login, limit] of proven) paneLimits.set(login, limit);
    // The start's own resolution, per agent runtime: a runtime a start would refuse is not ready.
    const refusals =
      runtimes === undefined
        ? []
        : await Promise.all(
            catalog
              .filter(runtime => runtime.agent)
              .map(async runtime => {
                // A runtime is resolved by its NAME, the word a person types: `id` is the catalogue's own opaque id (the
                // minted id the sessions name), which Runtimes does not resolve.
                const id = RuntimeIdSchema.safeParse(runtime.name);
                if (!id.success) return [[runtime.wrapper, `${runtime.name} is not a runtime name`] as const];
                const resolved = await runtimes.resolve(id.data);
                // Sign-in, switches and a missing login are judged from the facts above; only a runtime that cannot be built is unlaunchable.
                return resolved.ok || (resolved.refusal !== 'unknown' && resolved.refusal !== 'no_profile')
                  ? []
                  : [[runtime.wrapper, resolved.sentence] as const];
              }),
          );
    return {
      runtimes: catalog,
      credentials,
      tools,
      unlaunchable: Object.fromEntries(refusals.flat()),
      paneLimits,
      now: this.now(),
    };
  }
}

/** What a provider answers, or `fallback` when it cannot answer. */
async function settle<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}
