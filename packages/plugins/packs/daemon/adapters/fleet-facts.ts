import { RuntimeIdSchema, type RuntimesApi } from '@ferretry/plugin-runtimes/contract';
import type { PaneLimit, PackCredentialFacts, RuntimeFactsApi, UsageQuotaApi } from '../../contract/index.ts';
import type { PackFleetFacts } from '../lib/recommend.ts';

/**
 * The runtimes, logins, tools and pane limits `recommend` judges readiness from — one reader, so a start never
 * refuses a runtime this list called ready. Both providers are optional (§2.3): with Runtimes off there is no runtime to
 * offer, with Usage off every login's quota reads `unknown` (never full, never empty).
 *
 * `catalog` and `tools` ({@link RuntimeFactsApi}) are what Packs needs of Runtimes beyond `RuntimesApi`. Runtimes does
 * not offer them on this base (they are its app porter's additive members), so `facts` is handed none and answers no
 * runtime: `recommend`, the settings page and Clean up then say plainly that no model is usable now. Nothing here
 * guesses at members a provider does not declare.
 */
export class FleetFacts {
  constructor(
    private readonly runtimes: () => RuntimesApi | undefined,
    private readonly runtimeFacts: () => RuntimeFactsApi | undefined,
    private readonly usage: () => UsageQuotaApi | undefined,
    private readonly now: () => string,
  ) {}

  async facts(): Promise<PackFleetFacts> {
    const runtimes = this.runtimes();
    const facts = runtimes === undefined ? undefined : this.runtimeFacts();
    const usage = this.usage();
    const [catalog, tools, credentials, paneLimits] = await Promise.all([
      facts?.catalog() ?? [],
      facts?.tools() ?? [],
      usage?.logins() ?? ([] as readonly PackCredentialFacts[]),
      usage?.paneLimits() ?? (new Map() as ReadonlyMap<string, PaneLimit>),
    ]);
    // The start's own resolution, per agent runtime: a runtime a start would refuse is not ready.
    const refusals =
      runtimes === undefined
        ? []
        : await Promise.all(
            catalog
              .filter(runtime => runtime.agent)
              .map(async runtime => {
                const id = RuntimeIdSchema.safeParse(runtime.id);
                if (!id.success) return [[runtime.wrapper, `${runtime.id} is not a runtime name`] as const];
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
