/**
 * The recommendation engine's application service: it gathers the three facts a recommendation
 * needs — who is in the fleet, how each account is scored, and how spent each one is — and hands
 * them to the pure {@link recommendTeam}.
 *
 * It exists so the composition root has one thing to build and the API layer has one thing to call.
 * The engine itself stays pure and takes everything as an argument; nothing below this line knows
 * where a manifest lives or that a usage feed caches.
 */
import type { UsageFeedPort } from '../usage/index.ts';
import type { RoutingCatalog } from './catalog.ts';
import type { Budget, TeamRole } from './classification.ts';
import { selectableAutoAccounts, type AccountInventoryPort } from './inventory.ts';
import { recommendTeam, type TeamRecommendation } from './team.ts';
import type { AccountAuthMode } from '../usage/types.ts';

/** Supplied by an adapter over the operator's routing configuration. */
export interface RoutingCatalogPort {
  catalog(): Promise<RoutingCatalog>;
}

export interface AdviceRequest {
  readonly task: string;
  readonly budget?: Budget;
  /** Force the team shape instead of deriving it from the classification. */
  readonly roles?: readonly TeamRole[];
  /** Declared authentication mode per account id, used only for remediation wording. */
  readonly authModes?: Readonly<Record<string, AccountAuthMode>>;
  /** Include interactive accounts too. Unattended work may only use the auto lane. */
  readonly includeInteractive?: boolean;
}

export class TeamAdvisor {
  constructor(
    private readonly inventory: AccountInventoryPort,
    private readonly routing: RoutingCatalogPort,
    private readonly usage: UsageFeedPort,
  ) {}

  /**
   * Recommend a team for one task.
   *
   * The usage read never blocks the answer: {@link UsageFeedPort} serves its last snapshot when a
   * refresh fails, and an account the feed says nothing about is ranked as average rather than
   * empty, so a blind feed degrades the ordering instead of inverting it.
   */
  async recommend(request: AdviceRequest, signal?: AbortSignal): Promise<TeamRecommendation> {
    const [all, catalog, usage] = await Promise.all([
      this.inventory.accounts(),
      this.routing.catalog(),
      this.usage.accounts(signal),
    ]);
    return recommendTeam({
      task: request.task,
      accounts: request.includeInteractive === true ? all : selectableAutoAccounts(all),
      catalog,
      usage,
      ...(request.budget === undefined ? {} : { budget: request.budget }),
      ...(request.roles === undefined ? {} : { roles: request.roles }),
      ...(request.authModes === undefined ? {} : { authModes: request.authModes }),
    });
  }
}
