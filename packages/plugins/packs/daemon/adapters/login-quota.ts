import type { FerretSummary } from '@ferretry/core-ferrets/contract';
import type { LoginsApi } from '@ferretry/plugin-logins/contract';
import type { PackCredentialFacts, PackQuotaSource, PaneLimit } from '../../contract/index.ts';

/**
 * What Packs reads about each login's sign-in, quota and budget: the Logins port's own list, whose rows already carry
 * them (`LoginView`), so Packs asks the plugin that owns the facts and no second port that merely shares a name.
 *
 * The PANE limits: a spend limit only the harness announces ("You've hit your org's monthly spend limit") shows in no
 * provider window, so a login whose ferret is parked `rate_limited` on one is exhausted until the time the harness gave.
 * It is read from Ferrets' own summaries (the limit notice a rate-limited ferret's quota records), live, nothing remembered:
 * it ends the moment the last such ferret is released or its reset passes. A read that fails is no limit, never a failed
 * recommend: pane evidence only ever ADDS a limit the provider did not say.
 */
export class LoginQuotaFacts implements PackQuotaSource {
  constructor(
    private readonly logins: () => LoginsApi | undefined,
    private readonly ferrets: () => Promise<readonly FerretSummary[]> = async () => [],
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async credentials(): Promise<readonly PackCredentialFacts[]> {
    return (await this.logins()?.list())?.logins ?? [];
  }

  async paneLimits(): Promise<ReadonlyMap<string, PaneLimit>> {
    let summaries: readonly FerretSummary[];
    try {
      summaries = await this.ferrets();
    } catch {
      return new Map();
    }
    const now = this.nowMs();
    const limits = new Map<string, PaneLimit>();
    for (const ferret of summaries) {
      const notice = ferret.quota?.limitNotice;
      // `limitNotice` is present exactly while Ferretry reads the ferret as rate limited: the harness's own words for it.
      if (notice === undefined || ferret.login === undefined) continue;
      const retryAt = ferret.quota?.retryAt;
      if (retryAt !== undefined && retryAt <= now) continue;
      const limit: PaneLimit = {
        notice,
        spend: ferret.quota?.unavailableReason === 'spend_limit',
        ...(retryAt === undefined ? {} : { retryAt }),
      };
      const kept = limits.get(ferret.login);
      // Where several ferrets share a login, the latest reset wins.
      if (kept === undefined || (kept.retryAt !== undefined && (retryAt === undefined || retryAt > kept.retryAt)))
        limits.set(ferret.login, limit);
    }
    return limits;
  }
}
