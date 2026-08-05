import type {
  FleetApplyPlan,
  FleetApplyResult,
  FleetLoginResult,
  FleetManifest,
  FleetManifestAccount,
  FleetUsage,
  FleetUsageSnapshot,
  FleetWriteOperation,
} from '@ferretry/fleet';
import type { RoleOption, TeamRecommendation } from './wire.ts';

const INDENT = '    ';

const plural = (count: number, singular: string): string => `${count} ${count === 1 ? singular : `${singular}s`}`;

/** The path an operation touches; a copy and a symlink name their source too. */
function operationTarget(operation: FleetWriteOperation): string {
  switch (operation.kind) {
    case 'copy':
    case 'symlink':
      return `${operation.path} ← ${operation.source}`;
    case 'prune':
      return `${operation.path} (keeping ${operation.keep.length})`;
    default:
      return operation.path;
  }
}

/**
 * Every write a plan would perform, in order.
 *
 * `--dry-run` prints exactly this and stops, so what a human reviews is the same value the applier
 * consumes — kteam's dry run re-derived a summary and could disagree with the real thing.
 */
export function renderApplyPlan(plan: FleetApplyPlan): string {
  const header = `${plural(plan.manifest.accounts.length, 'account')}, ${plural(plan.operations.length, 'operation')} — nothing has been written`;
  const operations = plan.operations.map(operation => `  ${operation.kind.padEnd(9)} ${operationTarget(operation)}`);
  return [header, ...operations, `  manifest   ${plan.manifestPath}`].join('\n');
}

/** What an apply actually did, including anything it swept away. */
export function renderApplyResult(result: FleetApplyResult): string {
  const lines = [
    `applied ${plural(result.accountCount, 'account')} in ${plural(result.operationCount, 'operation')}`,
    `  manifest: ${result.manifestPath}`,
  ];
  if (result.prunedWrappers.length > 0) {
    lines.push(`  pruned ${plural(result.prunedWrappers.length, 'wrapper')}: ${result.prunedWrappers.join(', ')}`);
  }
  return lines.join('\n');
}

/** One account row: what it is, and whether it can be used. */
export function renderAccount(account: FleetManifestAccount): string {
  const models = account.models.filter(model => model.available).map(model => model.id);
  const state = account.available ? 'available' : `unavailable — ${account.unavailableReason}`;
  return [
    `  ${account.id}  [${account.kind}/${account.mode}]  ${account.displayName}`,
    `${INDENT}wrapper ${account.wrapper} · home ${account.home}`,
    `${INDENT}default ${account.defaultModel ?? 'none'} · models ${models.length === 0 ? 'none available' : models.join(', ')}`,
    `${INDENT}${state}`,
  ].join('\n');
}

/** The provisioned fleet. */
export function renderManifest(manifest: FleetManifest): string {
  if (manifest.accounts.length === 0) return 'The fleet manifest declares no accounts.';
  const header = `${plural(manifest.accounts.length, 'account')} provisioned ${manifest.generatedAt}`;
  return [header, ...manifest.accounts.map(renderAccount)].join('\n');
}

/** A quota window as a percentage, or a dash when the provider did not say. */
function percent(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value)}%`;
}

/** One usage row. An account at its limit is called out, because that is the actionable case. */
export function renderUsageRow(usage: FleetUsage): string {
  if (usage.unavailable) return `  ${usage.accountId}  unavailable — ${usage.unavailableReason ?? 'no reason given'}`;
  if (!usage.ok) return `  ${usage.accountId}  probe failed — ${usage.error ?? 'no reason given'}`;
  if (!usage.usageBased) return `  ${usage.accountId}  pay-as-you-go — no quota to report`;
  const limit = usage.atLimit ? '  AT LIMIT' : '';
  return `  ${usage.accountId}  short ${percent(usage.shortWindow?.usedPercent)} · long ${percent(usage.longWindow?.usedPercent)}${limit}`;
}

/** The whole fleet's quota picture. */
export function renderUsage(snapshot: FleetUsageSnapshot): string {
  if (snapshot.accounts.length === 0) return 'No accounts to report usage for.';
  const exhausted = snapshot.accounts.filter(account => account.atLimit).length;
  const header = `${plural(snapshot.accounts.length, 'account')}${exhausted === 0 ? '' : `, ${exhausted} at limit`}`;
  return [header, ...snapshot.accounts.map(renderUsageRow)].join('\n');
}

/** One login outcome. Every status is named, so "nothing happened" is never how a failure reads. */
export function renderLoginRow(result: FleetLoginResult): string {
  const detail = result.message === undefined ? '' : ` — ${result.message}`;
  switch (result.status) {
    case 'logged-in':
      return `  ${result.accountId}  logged in`;
    case 'not-required':
      return `  ${result.accountId}  no login needed (this account authenticates with a key)`;
    case 'unavailable':
      return `  ${result.accountId}  skipped, the manifest declares it unavailable${detail}`;
    default:
      return `  ${result.accountId}  FAILED${detail}`;
  }
}

/**
 * The whole login pass.
 *
 * The header counts failures explicitly rather than only successes: a run where three of four
 * accounts failed and the summary said "4 accounts" is the shape of report this product keeps
 * getting wrong.
 */
export function renderLoginResults(results: readonly FleetLoginResult[]): string {
  if (results.length === 0) return 'No accounts to log in.';
  const failed = results.filter(result => result.status === 'failed').length;
  const header = `${plural(results.length, 'account')}${failed === 0 ? '' : `, ${failed} failed`}`;
  return [header, ...results.map(renderLoginRow)].join('\n');
}

function optionLine(option: RoleOption, prefix: string): string {
  const caveat = option.caveat === undefined ? '' : ` — ${option.caveat}`;
  return `${prefix}${option.agent} (${option.model}, account ${option.accountId}): ${option.tradeoff}${caveat}`;
}

/**
 * The recommendation as a decision guide, not an order.
 *
 * Alternatives and exclusions are printed alongside the pick because the human, not the recommender,
 * chooses: kteam printed only the winner and a launch command, which read as an instruction and hid
 * the fact that an account had been skipped for being out of quota.
 */
export function renderRecommendation(recommendation: TeamRecommendation): string {
  const sections = [`${recommendation.task}`, `  ${recommendation.classification} — ${recommendation.reasoning}`];
  for (const role of recommendation.roles) {
    const count = role.count === undefined ? '' : ` ×${role.count}`;
    sections.push(`  ${role.role}${count}: ${role.why}`, optionLine(role.primary, `${INDENT}pick  `));
    sections.push(...role.alternatives.map(option => optionLine(option, `${INDENT}or    `)));
  }
  if (recommendation.exclusions.length > 0) {
    sections.push('  not considered:');
    sections.push(
      ...recommendation.exclusions.map(
        exclusion => `${INDENT}${exclusion.agent} (${exclusion.accountId}): ${exclusion.reason}`,
      ),
    );
  }
  sections.push(...recommendation.warnings.map(warning => `  ! ${warning}`));
  return sections.join('\n');
}
