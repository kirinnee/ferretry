import type { LoginsApi } from '@ferretry/plugin-logins/contract';
import { RuntimeIdSchema, type RuntimesApi, type RuntimeView } from '@ferretry/plugin-runtimes/contract';
import type { PaneLimitView, UsageApi } from '@ferretry/plugin-usage/contract';
import type { PackCredentialFacts, PaneLimit } from '../../contract/index.ts';
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
 * runtime this list called ready. Every provider is optional (§2.3): with Runtimes off there is no runtime to offer, with
 * Logins off no login reads as measured, with Usage off no pane limit is known. Logins and Usage only add what a
 * login has left, so one that fails to answer is read as having nothing to say (a login's quota then reads `unknown`:
 * never full, never empty); Runtimes failing is not hidden, because "no model is usable" would then be a lie.
 */
export class FleetFacts {
  constructor(
    private readonly runtimes: () => RuntimesApi | undefined,
    private readonly logins: () => Pick<LoginsApi, 'list'> | undefined,
    private readonly usage: () => Pick<UsageApi, 'paneLimits'> | undefined,
    private readonly now: () => string,
  ) {}

  async facts(): Promise<PackFleetFacts> {
    const runtimes = this.runtimes();
    const logins = this.logins();
    const usage = this.usage();
    const [catalog, tools, credentials, panes] = await Promise.all([
      runtimes === undefined ? [] : runtimes.catalog(),
      runtimes === undefined ? [] : runtimes.tools(),
      logins === undefined
        ? ([] as readonly PackCredentialFacts[])
        : settle(async () => (await logins.list()).logins as readonly PackCredentialFacts[], []),
      usage === undefined ? ([] as readonly PaneLimitView[]) : settle(async () => await usage.paneLimits(), []),
    ]);
    const paneLimits = paneLimitsOf(panes, catalog);
    // The start's own resolution, per agent runtime: a runtime a start would refuse is not ready.
    const refusals =
      runtimes === undefined
        ? []
        : await Promise.all(
            catalog
              .filter(runtime => runtime.agent)
              .map(async runtime => {
                // A runtime is resolved by its NAME: `id` is the minted id the sessions name, which Runtimes does not resolve.
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
