import type { FerretPaneLimit } from '@ferretry/core-ferrets/contract';
import { RuntimeIdSchema, type RuntimesApi } from '@ferretry/plugin-runtimes/contract';
import type { LoginFactsApi, UsageHeadroomApi } from '../../contract/others.ts';
import type { FleetCredentialView, PackFleetFacts } from '../lib/foreign-pack.ts';
import type { PaneLimit } from '../lib/foreign-pane-limit.ts';

/**
 * The fleet facts `fy recommend` judges a login from — the runtimes, the logins' sign-in and quota, the machine's tools and
 * the limits live panes prove — read for the auto-move (`auto-move-service.ts`), the way Packs' own `FleetFacts` reads them
 * (Packs owns `recommend`; the Move is its second reader and the two cannot drift apart unnoticed).
 *
 * Usage and the live ferrets are optional (§2.3) and only ever ADD a pane limit. Runtimes and Logins are not: either one
 * missing or failing THROWS, because no login is chosen blind (`WardenAutoMovePorts.facts`) — answering NO credentials
 * would read every login as signed out and blame each one for a fault that is Logins'.
 */
export class WardenFleetFacts {
  constructor(
    private readonly runtimes: () => Pick<RuntimesApi, 'catalog' | 'tools' | 'resolve'> | undefined,
    private readonly logins: () => LoginFactsApi | undefined,
    private readonly usage: () => UsageHeadroomApi | undefined,
    private readonly ferretLimits: () => Promise<readonly FerretPaneLimit[]>,
    private readonly now: () => string,
  ) {}

  async facts(): Promise<PackFleetFacts> {
    const runtimes = this.runtimes();
    if (runtimes === undefined) throw new Error('the runtimes are not available, so no login can be chosen');
    const logins = this.logins();
    if (logins === undefined) throw new Error('the logins are not available, so no login can be chosen');
    const usage = this.usage();
    const [catalog, tools, credentials, panes, ferrets] = await Promise.all([
      runtimes.catalog(),
      runtimes.tools(),
      readLogins(logins),
      usage?.paneLimits === undefined ? [] : settle(async () => (await usage.paneLimits?.()) ?? [], []),
      settle(async () => await this.ferretLimits(), []),
    ]);
    // A limit is the LOGIN's, whichever runtime's ferret hit it; a ferret that names no login is known by its runtime.
    const paneLimits = new Map<string, PaneLimit>();
    const add = (login: string, limit: PaneLimit): void => {
      if (!paneLimits.has(login)) paneLimits.set(login, limit);
    };
    for (const limit of [...ferrets, ...panes]) {
      const found: PaneLimit = {
        notice: limit.notice,
        spend: limit.spend,
        ...(limit.retryAt === undefined ? {} : { retryAt: limit.retryAt }),
      };
      const login =
        limit.login ??
        (limit.runtime === undefined ? undefined : catalog.find(r => r.name === limit.runtime)?.credential.id);
      if (login !== undefined) add(login, found);
    }
    // The start's own resolution, per agent runtime: a runtime a start would refuse is not ready.
    const refusals = await Promise.all(
      catalog.map(async runtime => {
        const id = RuntimeIdSchema.safeParse(runtime.name);
        if (!id.success) return [[runtime.wrapper, `${runtime.name} is not a runtime name`] as const];
        const resolved = await runtimes.resolve(id.data);
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
    } as PackFleetFacts;
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

/** The logins as Logins lists them; a Logins that cannot answer is said, never read as "no login is signed in". */
async function readLogins(logins: LoginFactsApi): Promise<readonly FleetCredentialView[]> {
  try {
    return (await logins.list()).logins as readonly FleetCredentialView[];
  } catch {
    throw new Error('the logins could not be read, so no login can be chosen');
  }
}
