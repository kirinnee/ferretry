import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import type { LoginsApi } from '@ferretry/plugin-logins/contract';
import type { PackCredentialFacts, PackQuotaSource, PaneLimit } from '../../contract/index.ts';

/**
 * What Packs reads about each login's sign-in, quota and budget: the Logins port's own list, whose rows already carry
 * them (`LoginView`), so Packs asks the plugin that owns the facts and no second port that merely shares a name.
 *
 * The PANE limits: a spend limit only the harness announces ("You've hit your org's monthly spend limit") shows in no
 * provider window, so a login whose ferret is parked `rate_limited` on one is exhausted until the time the harness gave.
 * The evidence is read from the REAL Ferrets port: `list()` names the live ferrets and the login each runs on (the
 * summary carries no quota), and `prompt()` answers, per ferret, the `limit` its session document records while it is
 * `rate_limited` (`FerretPrompt.limit`). Live, nothing remembered: it ends the moment the last such ferret is released or
 * its reset passes. A read that fails is no limit, never a failed recommend: pane evidence only ever ADDS a limit the
 * provider did not say.
 */
export class LoginQuotaFacts implements PackQuotaSource {
  constructor(
    private readonly logins: () => LoginsApi | undefined,
    private readonly ferrets: () => Pick<FerretsApi, 'list' | 'prompt'> | undefined = () => undefined,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async credentials(): Promise<readonly PackCredentialFacts[]> {
    return (await this.logins()?.list())?.logins ?? [];
  }

  async paneLimits(): Promise<ReadonlyMap<string, PaneLimit>> {
    const ferrets = this.ferrets();
    if (ferrets?.prompt === undefined) return new Map();
    const ask = ferrets.prompt.bind(ferrets);
    let live: Awaited<ReturnType<FerretsApi['list']>>;
    try {
      live = (await ferrets.list()).filter(ferret => ferret.state !== 'stopped' && ferret.login !== undefined);
    } catch {
      return new Map();
    }
    const now = this.nowMs();
    const limits = new Map<string, PaneLimit>();
    // One ferret's failed read is that ferret's evidence missing, not the others'.
    const asked = await Promise.all(
      live.map(async ferret => [ferret, await ask(ferret.id).catch(() => undefined)] as const),
    );
    for (const [ferret, prompt] of asked) {
      const found = prompt?.limit;
      if (found === undefined || ferret.login === undefined) continue;
      const retryAt = found.retryAt;
      if (retryAt !== undefined && retryAt <= now) continue;
      const limit: PaneLimit = {
        notice: found.notice,
        spend: found.spend,
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
