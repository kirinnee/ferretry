/**
 * The recommendation engine: read the request, choose a team shape, and rank a model and account
 * for every role in it. It never launches anything.
 */
import type { AccountUsage } from '@ferretry/protocol';
import { authFailureRemedy } from '../usage/index.ts';
import { spentPercent, unusableAccountReason } from './account-health.ts';
import {
  baseRoleScore,
  indexCatalog,
  kindBonus,
  type RoutingAccount,
  type RoutingCatalog,
  type RoutingIndex,
  type RoutingModel,
} from './catalog.ts';
import {
  classifyTask,
  describeClassification,
  type Budget,
  type TaskClassification,
  type TeamRole,
} from './classification.ts';
import type { AccountAuthMode } from '../usage/types.ts';
import type { CoreAccount, HarnessKind } from './inventory.ts';

/** Why an option is offered but not preferred. It stays on the menu — the caller may know more. */
export type OptionCaveat = 'below-doctrine-floor' | 'same-model-family' | 'not-for-product-facing';

export interface RoleOption {
  readonly accountId: string;
  readonly agent: string;
  readonly accountName: string;
  readonly model: string;
  readonly modelLabel: string;
  /** The `--model` value to pass; absent means the account's own default. */
  readonly modelFlag?: string;
  readonly family: HarnessKind;
  readonly tier: string;
  /** One line: quality, speed, cost. */
  readonly tradeoff: string;
  readonly score: number;
  readonly caveat?: OptionCaveat;
}

export interface RoleRecommendation {
  readonly role: TeamRole;
  readonly why: string;
  /** Suggested agent count; fan-out roles only. */
  readonly count?: number;
  readonly primary: RoleOption;
  readonly alternatives: readonly RoleOption[];
}

export interface AccountExclusion {
  readonly accountId: string;
  readonly agent: string;
  readonly reason: string;
}

export interface TeamRecommendation {
  readonly task: string;
  readonly budget: Budget;
  readonly classification: TaskClassification;
  readonly reasoning: string;
  readonly roles: readonly RoleRecommendation[];
  readonly exclusions: readonly AccountExclusion[];
  readonly warnings: readonly string[];
}

export interface RecommendTeamRequest {
  readonly task: string;
  readonly accounts: readonly CoreAccount[];
  readonly catalog: RoutingCatalog;
  readonly budget?: Budget;
  /** Force the team shape instead of deriving it from the classification. */
  readonly roles?: readonly TeamRole[];
  readonly usage?: readonly AccountUsage[];
  /** Declared authentication mode per account id, used only for remediation wording. */
  readonly authModes?: Readonly<Record<string, AccountAuthMode>>;
}

const costLabels: Readonly<Record<RoutingModel['cost'], string>> = {
  low: 'cheap',
  medium: 'mid-cost',
  high: 'expensive',
  'very-high': 'very expensive',
};

function tradeoffLine(model: RoutingModel, routing: RoutingAccount): string {
  const preferred = routing.preferredSpend ? ', preferred-spend account' : '';
  return `${model.note} — ${model.speed}, ${costLabels[model.cost]}${preferred}`;
}

/**
 * The least capable model allowed to lead a role. This is what stops hard or critical work landing
 * on the mass-chore tier.
 *
 * Buying quality raises the floor a tier rather than nudging scores — it changes which tier is
 * eligible, not the ordering inside one — and never applies to mechanical work, where the top tier
 * is waste rather than quality. Buying cheap leaves the floors alone; they are not negotiable.
 */
export function primaryFloor(
  index: RoutingIndex,
  role: TeamRole,
  classification: TaskClassification,
  budget: Budget,
): number {
  const floors = index.catalog.floors;
  if (role === 'fan-out') return 0;
  if (role === 'reviewer') return floors.reviewer;
  if (role === 'planner') return floors.planner;
  const { complexity, risk, size } = classification;
  const qualityFirst = budget === 'max' && complexity !== 'mechanical' ? floors.qualityFirst : 0;
  if (complexity === 'hard' && (risk === 'critical' || size === 'large')) return floors.hardAndDemanding;
  if (complexity === 'hard' || risk === 'critical') return Math.max(qualityFirst, floors.hardOrCritical);
  if (complexity === 'mid') return Math.max(qualityFirst, floors.mid);
  return qualityFirst;
}

interface Candidate {
  readonly option: RoleOption;
  readonly model: RoutingModel;
}

function candidatesFor(
  index: RoutingIndex,
  role: TeamRole,
  pool: readonly PooledAccount[],
  classification: TaskClassification,
  budget: Budget,
  usageByAgent: ReadonlyMap<string, AccountUsage>,
): readonly Candidate[] {
  const weights = index.catalog.weights;
  const costPenalty = index.catalog.costPenalty[budget] ?? {};
  const candidates: Candidate[] = [];

  for (const { account, routing } of pool) {
    for (const option of routing.options) {
      const model = index.model(option.model);
      if (model === undefined) continue;
      // An account that declares it cannot serve this model is not a candidate for it. The source
      // had no such declaration and happily recommended a model its own configuration said was
      // down.
      if (!account.models.some(entry => entry.id === option.model && entry.available)) continue;

      const base = baseRoleScore(model, role, classification.complexity);
      if (base <= 0) continue;

      let score = base;
      score -= costPenalty[model.cost] ?? 0;
      if (routing.preferredSpend) score += weights.preferredSpendBonus;
      // Same tier, least-spent account first. An account with no reading at all is left alone
      // rather than treated as empty, which is how the source made unmeasured accounts win.
      score -= (spentPercent(usageByAgent.get(account.agent)) ?? 0) / weights.spentPercentDivisor;
      if (option.modelFlag === undefined) score += weights.accountDefaultBonus;
      if (role === 'implementer') score += kindBonus(model, classification.kind);
      // A plan-following implementer drags a planner onto the team. On a cheap budget that is the
      // most expensive teammate in the shape, added to save money.
      if (role === 'implementer' && budget === 'cheap' && model.needsPlan) score -= weights.needsPlanCheapPenalty;
      if (role === 'researcher' && classification.size === 'large' && model.power < weights.researcherReachFloor)
        score -= weights.smallResearcherPenalty;

      candidates.push({
        model,
        option: {
          accountId: account.id,
          agent: account.agent,
          accountName: account.displayName,
          model: model.id,
          modelLabel: model.label,
          ...(option.modelFlag === undefined ? {} : { modelFlag: option.modelFlag }),
          family: model.family,
          tier: model.tier,
          tradeoff: tradeoffLine(model, routing),
          score: Math.round(score * 10) / 10,
        },
      });
    }
  }

  // One entry per model: the alternatives list is about model choices, not the same model on four
  // interchangeable accounts.
  const byModel = new Map<string, Candidate>();
  for (const candidate of [...candidates].sort((a, b) => b.option.score - a.option.score)) {
    if (!byModel.has(candidate.model.id)) byModel.set(candidate.model.id, candidate);
  }
  return [...byModel.values()].sort((a, b) => b.option.score - a.option.score);
}

/** The team shape the handoff chain calls for. */
export function roleShape(classification: TaskClassification, budget: Budget): readonly TeamRole[] {
  const { complexity, kind, risk, ambiguity, size } = classification;
  const roles: TeamRole[] = [];

  const wantsPlanner =
    budget === 'max' ||
    ambiguity === 'high' ||
    complexity === 'hard' ||
    (risk === 'critical' && complexity !== 'mechanical');
  if (wantsPlanner && !(budget === 'cheap' && ambiguity === 'low')) roles.push('planner');

  const fanOut = kind === 'bulk-chore' || (kind === 'migration' && size === 'large');
  // A pure chore has no single implementer — the fan-out is the implementation. Adding both put a
  // top-tier implementer next to a one-file-per-agent swarm.
  if (kind === 'research') roles.push('researcher');
  else if (kind !== 'review' && !(fanOut && kind === 'bulk-chore')) roles.push('implementer');
  if (fanOut) roles.push('fan-out');

  const wantsReviewer =
    budget === 'max' || risk === 'critical' || complexity !== 'mechanical' || kind === 'review' || kind === 'frontend';
  if (wantsReviewer && !(budget === 'cheap' && risk === 'low')) roles.push('reviewer');

  return roles.length > 0 ? roles : ['implementer'];
}

function roleWhy(role: TeamRole, classification: TaskClassification): string {
  const { complexity, kind, risk, size, ambiguity } = classification;
  switch (role) {
    case 'planner':
      return ambiguity === 'high'
        ? 'ambiguity is high — pin the design down before any code is written'
        : `${complexity} work with ${risk} risk: plan first, then hand the plan to an implementer`;
    case 'implementer':
      return `${complexity} ${kind} work, ${size} scope — this is the tier the doctrine allows here`;
    case 'researcher':
      return 'read-and-report work: no diff to defend, so favour reach and judgement over diligence';
    case 'reviewer':
      if (kind === 'research') return 'independent cross-family check of the findings before they are acted on';
      return risk === 'critical'
        ? 'critical change — review from a different model family'
        : 'independent cross-family review of the diff before it lands';
    case 'fan-out':
      return 'divide-and-conquer chore: one unit of work per agent on the mass-chore tier';
  }
}

const LARGE_FAN_OUT = 4;
const SMALL_FAN_OUT = 2;

function fanOutCount(classification: TaskClassification): number {
  return classification.size === 'large' ? LARGE_FAN_OUT : SMALL_FAN_OUT;
}

/** A usable account paired with its routing entry, so neither has to be looked up again. */
interface PooledAccount {
  readonly account: CoreAccount;
  readonly routing: RoutingAccount;
}

interface Pool {
  readonly usable: readonly PooledAccount[];
  readonly exclusions: readonly AccountExclusion[];
}

/**
 * Split the inventory into what may be recommended and what may not, with a reason for every
 * exclusion. An account the manifest declares unavailable is excluded on that declaration alone —
 * the case the source could not express, and the one that misrouted real work.
 */
function selectPool(
  index: RoutingIndex,
  accounts: readonly CoreAccount[],
  usageByAgent: ReadonlyMap<string, AccountUsage>,
  authModes: Readonly<Record<string, AccountAuthMode>>,
): Pool {
  const usable: PooledAccount[] = [];
  const exclusions: AccountExclusion[] = [];
  for (const account of accounts) {
    const routing = index.account(account.id);
    const health = usageByAgent.get(account.agent);
    const exclude = (reason: string): void => {
      exclusions.push({ accountId: account.id, agent: account.agent, reason });
    };

    if (!account.available) exclude(account.unavailableReason ?? 'declared unavailable by the fleet manifest');
    else if (routing === undefined) exclude('no routing entry for this account — route it manually');
    else if (routing.excludedReason !== undefined) exclude(routing.excludedReason);
    else if (health?.authOk === false) exclude(`credentials rejected — ${authFailureRemedy(authModes[account.id])}`);
    else {
      const unusable = unusableAccountReason(health);
      if (unusable === undefined) usable.push({ account, routing });
      else exclude(unusable);
    }
  }
  return { usable, exclusions };
}

function withCaveats(
  candidates: readonly Candidate[],
  floor: number,
  productBarred: (candidate: Candidate) => boolean,
): readonly RoleOption[] {
  return candidates.map(candidate => ({
    ...candidate.option,
    caveat:
      candidate.model.power < floor
        ? ('below-doctrine-floor' as const)
        : productBarred(candidate)
          ? ('not-for-product-facing' as const)
          : ('same-model-family' as const),
  }));
}

export function recommendTeam(request: RecommendTeamRequest): TeamRecommendation {
  const budget = request.budget ?? 'balanced';
  const index = indexCatalog(request.catalog);
  const classification = classifyTask(request.task);
  const usageByAgent = new Map((request.usage ?? []).map(row => [row.agent, row]));
  const { usable, exclusions } = selectPool(index, request.accounts, usageByAgent, request.authModes ?? {});
  const warnings: string[] = [];
  const roles: RoleRecommendation[] = [];

  const shape =
    request.roles !== undefined && request.roles.length > 0 ? request.roles : roleShape(classification, budget);
  const alternativesShown = index.catalog.weights.alternativesShown;

  for (const role of shape) {
    const ranked = candidatesFor(index, role, usable, classification, budget, usageByAgent);
    const best = ranked[0];
    if (best === undefined) {
      warnings.push(`no usable account could fill the ${role} role`);
      continue;
    }
    const floor = primaryFloor(index, role, classification, budget);
    const productBarred = (candidate: Candidate): boolean =>
      role === 'implementer' && classification.productFacing && candidate.model.noProductFacing;

    let eligible = ranked.filter(candidate => candidate.model.power >= floor && !productBarred(candidate));

    // A reviewer must come from the other harness family than whoever produced the work.
    const producerFamily = roles.find(item => item.role === 'implementer' || item.role === 'researcher')?.primary
      .family;
    if (role === 'reviewer' && producerFamily !== undefined && eligible.length > 0) {
      const cross = eligible.filter(candidate => candidate.option.family !== producerFamily);
      if (cross.length > 0) eligible = cross;
      else warnings.push('no cross-family reviewer is available; the reviewer shares the implementer’s model family');
    }

    const belowFloor = eligible.length === 0;
    if (belowFloor) {
      warnings.push(
        `no available account meets the ${role} floor for ${classification.complexity}/${classification.risk} work; ` +
          `falling back to ${best.option.modelLabel} — treat its output as provisional`,
      );
      eligible = [...ranked];
    }

    // Every fallback option is below the floor, so the whole menu carries the caveat rather than
    // only the tail: the source marked none of them and it read as an ordinary recommendation.
    const preferred = belowFloor
      ? withCaveats(eligible, floor, productBarred)
      : eligible.map(candidate => candidate.option);
    const rest = withCaveats(
      ranked.filter(candidate => !eligible.includes(candidate)),
      floor,
      productBarred,
    );
    const primary = preferred[0] ?? best.option;

    roles.push({
      role,
      why: roleWhy(role, classification),
      ...(role === 'fan-out' ? { count: fanOutCount(classification) } : {}),
      primary,
      alternatives: [...preferred.slice(1), ...rest].slice(0, alternativesShown),
    });
  }

  // Handoff-chain invariant: a plan-following implementer may only work from a plan written by a
  // more capable model, so it drags a planner onto the team rather than silently breaking the chain.
  const implementer = roles.find(item => item.role === 'implementer');
  const implementerModel = implementer === undefined ? undefined : index.model(implementer.primary.model);
  if (implementerModel?.needsPlan === true && !roles.some(item => item.role === 'planner')) {
    const floor = primaryFloor(index, 'planner', classification, budget);
    const eligible = candidatesFor(index, 'planner', usable, classification, budget, usageByAgent).filter(
      candidate => candidate.model.power >= floor,
    );
    const planner = eligible[0];
    if (planner !== undefined) {
      roles.unshift({
        role: 'planner',
        why: `${implementerModel.label} implements only against a plan from a more capable model — that plan is this role`,
        primary: planner.option,
        alternatives: eligible.slice(1, 1 + alternativesShown).map(candidate => candidate.option),
      });
    } else {
      warnings.push(
        `${implementerModel.label} must not plan its own work, and no planner-tier account is available — ` +
          'write the plan in the lead thread first',
      );
    }
  }

  const shapeLine = roles.length > 0 ? roles.map(item => item.role).join(' → ') : 'none';
  return {
    task: request.task,
    budget,
    classification,
    reasoning: `${describeClassification(classification)} Team shape: ${shapeLine}.`,
    roles,
    exclusions,
    warnings,
  };
}
