import type {
  CredentialState,
  FleetApplyPreview,
  FleetApplyResult,
  FleetHealth,
  FleetHealthSnapshot,
  FleetIdentityStatus,
  FleetLoginResult,
  FleetManifest,
  FleetManifestAccount,
  FleetScaffoldResult,
  FleetUsage,
  FleetUsageSnapshot,
  FleetWriteOperation,
  SharedHistoryChange,
  SharedHistoryPreview,
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
    case 'codex-sqlite-ownership':
      return operation.enabled
        ? `${operation.path} (own sqlite_home=${operation.sqliteHome}; sidecar ${operation.markerPath})`
        : `${operation.path} (restore/remove only Ferretry's owned sqlite_home; sidecar ${operation.markerPath})`;
    default:
      return operation.path;
  }
}

function historyChange(change: SharedHistoryChange): string {
  switch (change.kind) {
    case 'create-pooled-entry':
      return `create ${change.entryType} ${change.path}`;
    case 'move':
      return `rename ${change.source} → ${change.destination}`;
    case 'collision':
      return `collision ${change.incoming} ↔ ${change.pooled}; winner ${change.winner}; preserve loser ${change.loser} at ${change.preservedAt}`;
    case 'merge-jsonl':
      return `merge ${change.source} → ${change.destination}; preserve source at ${change.sourcePreservedAt}`;
    case 'link':
      return `link ${change.path} → ${change.target}`;
    default:
      return `keep shared link ${change.path} → ${change.target}`;
  }
}

/**
 * The one thing pooling Codex history cannot promise yet.
 *
 * Codex offers a session for resume from its own index, and Ferretry does not yet reconcile a pooled
 * rollout into that index — the upstream re-indexing command is a declared GAP. The rollout is on
 * disk and linked into every Codex home either way, so the honest statement is "present, possibly
 * not listed yet", and it is worth three lines: a person who starts Codex, sees a short resume list
 * and is told nothing concludes that Ferretry ate their history.
 *
 * Written in the present tense so the same words are true before an apply and after one, and shown
 * only for Codex — Claude reads its transcripts straight off the pooled directories, so attaching
 * this to a Claude-only run would be a warning about nothing.
 */
const CODEX_HISTORY_CAVEAT: readonly string[] = [
  '  ! Codex resume: a pooled rollout stays on disk and is linked into every Codex home, but Ferretry',
  `${INDENT}does not re-index it. Codex may not list a migrated session for resume until it reconciles`,
  `${INDENT}its own index. No history is deleted.`,
];

function sharesCodexHistory(previews: readonly SharedHistoryPreview[]): boolean {
  return previews.some(preview => preview.kind === 'codex');
}

/**
 * Every write a plan would perform, in order.
 *
 * `--dry-run` prints exactly this and stops, so what a human reviews is the same value the applier
 * consumes — kteam's dry run re-derived a summary and could disagree with the real thing.
 */
export function renderApplyPlan(plan: FleetApplyPreview): string {
  const historyChanges = plan.sharedHistory.reduce((total, preview) => total + preview.changes.length, 0);
  const header = `${plural(plan.manifest.accounts.length, 'account')}, ${plural(plan.operations.length, 'operation')}, ${plural(historyChanges, 'history change')} — nothing has been written`;
  const operations = plan.operations.map(operation => `  ${operation.kind.padEnd(9)} ${operationTarget(operation)}`);
  const history = plan.sharedHistory.flatMap(preview => [
    `  shared    ${preview.kind} pool ${preview.pool} (${preview.migrated} migrated entries, ${preview.conflicts} collisions, ${preview.links} links)`,
    ...preview.changes.map(change => `    ${historyChange(change)}`),
  ]);
  const caveat = sharesCodexHistory(plan.sharedHistory) ? CODEX_HISTORY_CAVEAT : [];
  return [header, ...operations, ...history, `  manifest   ${plan.manifestPath}`, ...caveat].join('\n');
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
  for (const shared of result.sharedHistory) {
    lines.push(
      `  shared ${shared.kind}: ${shared.migrated} migrated entries, ${shared.conflicts} collisions preserved, ${shared.links} links → ${shared.pool}`,
    );
  }
  if (sharesCodexHistory(result.sharedHistory)) lines.push(...CODEX_HISTORY_CAVEAT);
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

function renderHealthRow(health: FleetHealth): string {
  const reason = health.error === undefined ? '' : ` — ${health.error}`;
  return `  ${health.accountId}  ${health.state.toUpperCase()}${health.cached ? ' (cached)' : ''}${reason}`;
}

export function renderHealth(snapshot: FleetHealthSnapshot): string {
  if (snapshot.accounts.length === 0) return 'No accounts to probe for health.';
  const down = snapshot.accounts.filter(account => account.state === 'down').length;
  const unknown = snapshot.accounts.filter(account => account.state === 'unknown').length;
  const suffix = [down === 0 ? '' : `${down} down`, unknown === 0 ? '' : `${unknown} unknown`]
    .filter(Boolean)
    .join(', ');
  return [
    `${snapshot.accounts.length} accounts${suffix === '' ? '' : `, ${suffix}`}`,
    ...snapshot.accounts.map(renderHealthRow),
  ].join('\n');
}

/**
 * What init prepared, what it deliberately left, and the one thing a person must still do.
 *
 * The `PATH` line is printed every time, including on a re-run that created nothing: the command
 * that makes a directory of executables is the only place where saying how the shell will find them
 * is guaranteed to be read, and an apply that writes wrappers nowhere on `PATH` reports success and
 * produces nothing runnable.
 */
export function renderScaffoldResult(result: FleetScaffoldResult): string {
  const lines =
    result.created.length === 0
      ? ['The fleet is already set up; nothing was changed.']
      : [
          `prepared the fleet in ${result.directories[0] ?? 'its directory'}`,
          ...result.created.map(path => `  created  ${path}`),
        ];
  for (const path of result.kept) lines.push(`  kept     ${path} (already there, left as it is)`);
  lines.push('', 'Add this to your shell profile so the generated wrappers are on PATH:', `  ${result.pathEntry}`);
  lines.push('', 'Then declare an account in the configuration and run "fy fleet apply".');
  return lines.join('\n');
}

/**
 * One login outcome.
 *
 * Every status is named. `usable`, `login-needed` and `indeterminate` are three different reasons
 * nothing happened, and the last one is not a milder version of the other two: it means this home was
 * never read successfully, so nothing can be concluded about it. Collapsing them is how a report ends
 * up implying a fleet is signed in when part of it was never checked.
 */
export function renderLoginRow(result: FleetLoginResult): string {
  const detail = result.message === undefined ? '' : ` — ${result.message}`;
  switch (result.status) {
    case 'logged-in':
      return `  ${result.accountId}  logged in`;
    case 'synced':
      return `  ${result.accountId}  credential copied from this identity`;
    case 'usable':
      return `  ${result.accountId}  already had a usable credential`;
    case 'not-required':
      return `  ${result.accountId}  no login needed (this account authenticates with a key)`;
    case 'login-needed':
      return `  ${result.accountId}  needs a login, not attempted${detail}`;
    case 'indeterminate':
      return `  ${result.accountId}  UNKNOWN, left untouched${detail}`;
    case 'unavailable':
      return `  ${result.accountId}  skipped, the manifest declares it unavailable${detail}`;
    default:
      return `  ${result.accountId}  FAILED${detail}`;
  }
}

/**
 * The whole login pass.
 *
 * The header counts what went wrong explicitly rather than only successes: a run where three of four
 * accounts failed and the summary said "4 accounts" is the shape of report this product keeps
 * getting wrong. Unknowns are counted separately from failures, because "I could not read it" and "it
 * did not work" call for different next steps.
 */
export function renderLoginResults(results: readonly FleetLoginResult[]): string {
  if (results.length === 0) return 'No accounts to log in.';
  const failed = results.filter(result => result.status === 'failed').length;
  const unknown = results.filter(result => result.status === 'indeterminate').length;
  const notes = [
    ...(failed === 0 ? [] : [`${failed} failed`]),
    ...(unknown === 0 ? [] : [`${unknown} could not be read`]),
  ];
  const header = `${plural(results.length, 'account')}${notes.length === 0 ? '' : `, ${notes.join(', ')}`}`;
  return [header, ...results.map(renderLoginRow)].join('\n');
}

const CREDENTIAL_MARK: Readonly<Record<CredentialState, string>> = {
  valid: 'valid',
  refreshable: 'expired, renewable',
  missing: 'none',
  unreadable: 'UNREADABLE',
};

/** What one identity's verdict means for a human about to be asked for something. */
function verdictLine(status: FleetIdentityStatus): string {
  switch (status.verdict.kind) {
    case 'no-login':
      return `no provider login — ${status.verdict.reason}`;
    case 'complete':
      return 'every home has a usable credential';
    case 'sync':
      return `${plural(status.targets.length, 'home')} would be copied from ${status.verdict.donor.accountId}`;
    case 'indeterminate':
      return `UNKNOWN — ${status.verdict.reason}`;
    default:
      return 'needs one browser approval, which would then cover every home here';
  }
}

/**
 * What `--status` prints: what each home holds, and what would happen, with nothing done.
 *
 * Grouped by identity rather than listed by account, because the credential belongs to the identity —
 * a flat per-account list is what made the old report look like thirty separate logins.
 */
export function renderIdentityStatus(statuses: readonly FleetIdentityStatus[]): string {
  if (statuses.length === 0) return 'No identities on this host.';
  const lines: string[] = [plural(statuses.length, 'identity').replace('identitys', 'identities')];
  for (const status of statuses) {
    lines.push(`  ${status.identity.key}  ${verdictLine(status)}`);
    if (!status.identity.declared) {
      lines.push(`${INDENT}(the configuration no longer declares this account, so it shares with nothing)`);
    }
    for (const member of status.members) {
      lines.push(`${INDENT}${member.member.accountId}  ${CREDENTIAL_MARK[member.reading.state]}`);
    }
    for (const member of status.unavailable) {
      lines.push(`${INDENT}${member.accountId}  unavailable, not read`);
    }
  }
  return lines.join('\n');
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
