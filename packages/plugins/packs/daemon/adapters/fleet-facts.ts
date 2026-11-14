import type { LoginsApi } from '@ferretry/plugin-logins/contract';
import { RuntimeIdSchema, type RuntimesApi } from '@ferretry/plugin-runtimes/contract';
import type { UsageApi, UsageFeedView } from '@ferretry/plugin-usage/contract';
import type { PackCredentialFacts, PaneLimit } from '../../contract/index.ts';
import type { PackFleetFacts } from '../lib/recommend.ts';

/**
 * The limits a ferret's pane proved, as Usage's feed carries them (`credentialUsageRows`): a row marked `spend_limit` is a
 * spend limit the provider only announces on a pane, and a row with a `retryAt` is a login a pane proved out of its usage
 * window until then. Only those two reach a feed row from a pane, so only those are read here; a window measured full is
 * judged from the login's own windows (`quotaOf`).
 */
function paneLimitsOf(feed: UsageFeedView): ReadonlyMap<string, PaneLimit> {
  const limits = new Map<string, PaneLimit>();
  for (const account of feed.accounts) {
    const spend = account.unavailableReason === 'spend_limit';
    if (!spend && account.retryAt === undefined) continue;
    limits.set(account.agent, {
      notice: spend ? 'spend limit reached' : 'usage limit reached',
      spend,
      ...(account.retryAt === undefined ? {} : { retryAt: account.retryAt }),
    });
  }
  return limits;
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
    private readonly usage: () => Pick<UsageApi, 'feed'> | undefined,
    private readonly now: () => string,
  ) {}

  async facts(): Promise<PackFleetFacts> {
    const runtimes = this.runtimes();
    const logins = this.logins();
    const usage = this.usage();
    const [catalog, tools, credentials, paneLimits] = await Promise.all([
      runtimes === undefined ? [] : runtimes.catalog(),
      runtimes === undefined ? [] : runtimes.tools(),
      logins === undefined
        ? ([] as readonly PackCredentialFacts[])
        : settle(async () => (await logins.list()).logins as readonly PackCredentialFacts[], []),
      usage === undefined
        ? new Map<string, PaneLimit>()
        : settle(async () => paneLimitsOf(await usage.feed({ watched: false })), new Map<string, PaneLimit>()),
    ]);
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
