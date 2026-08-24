import type {
  CredentialState,
  DisplacedState,
  FleetApplyCommittedState,
  FleetApplyFailure,
  FleetApplyPreview,
  FleetApplyResult,
  FleetAccountHealth,
  FleetHealthReason,
  FleetHealthSnapshot,
  FleetHealthVerdict,
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
import type { FleetAssetSharing, FleetCompositionOrigin, FleetSharing } from '@ferretry/protocol';
import type { RoleOption, TeamRecommendation } from './wire.ts';

const INDENT = '    ';

const plural = (count: number, singular: string): string => `${count} ${count === 1 ? singular : `${singular}s`}`;

/** The path an operation touches; a copy and a symlink name their source too. */
function operationTarget(operation: FleetWriteOperation): string {
  switch (operation.kind) {
    case 'copy':
    case 'symlink':
      return `${operation.path} ← ${operation.source}`;
    case 'settings': {
      const sources = operation.layers.map(layer => (layer.from === 'file' ? layer.path : '[inline settings]'));
      return sources.length === 0 ? operation.path : `${operation.path} ← ${sources.join(' + ')}`;
    }
    case 'prune':
    case 'prune-directory':
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

/** Structural, so the renderer needs nothing exported from the domain beyond the preview itself. */
type SharedHistoryRefusal = NonNullable<SharedHistoryPreview['refusals']>[number];

type SharedHistoryMerge = Extract<SharedHistoryChange, { kind: 'merge-jsonl' }>;

function isMerge(change: SharedHistoryChange): change is SharedHistoryMerge {
  return change.kind === 'merge-jsonl';
}

type SharedHistoryLink = Extract<SharedHistoryChange, { kind: 'link' }>;

function isLink(change: SharedHistoryChange): change is SharedHistoryLink {
  return change.kind === 'link';
}

const directoryCount = (count: number): string =>
  plural(count, 'source directory').replace('directorys', 'directories');

/**
 * The account-home directories that stop existing, split by what stands where they were.
 *
 * A directory being emptied and removed is the only part of this migration that takes away something
 * a person put there, so each one is named rather than counted, and the reason it is safe travels on
 * the same line — the contents left first.
 *
 * But `emptiedSourceDirectories` is every directory the migration drained, at every depth, and only
 * the shared-history entry at the top of each one gets a pool symlink put back. Saying "a link takes
 * each one's place" over that whole list is simply false for the nested ones: those are removed with
 * nothing put back, which is correct — the entry above them already carries the link — and is a
 * different sentence. The `link` changes in this same preview name exactly the entry-level paths, so
 * the split is read off the evidence already being reported rather than guessed from path shapes.
 */
function emptiedSourceLines(preview: SharedHistoryPreview): string[] {
  const emptied = preview.emptiedSourceDirectories ?? [];
  if (emptied.length === 0) return [];
  const linked = new Set(preview.changes.filter(isLink).map(change => change.path));
  const replaced = emptied.filter(path => linked.has(path));
  const drained = emptied.filter(path => !linked.has(path));
  return [
    ...(replaced.length === 0
      ? []
      : [
          `${INDENT}${directoryCount(replaced.length)} emptied by moving every entry into the pool, then replaced by a link to the pool:`,
          ...replaced.map(path => `${INDENT}  ${path}`),
        ]),
    ...(drained.length === 0
      ? []
      : [
          `${INDENT}${directoryCount(drained.length)} emptied further down and removed with nothing put back, because the shared-history entry above each one carries the pool link:`,
          ...drained.map(path => `${INDENT}  ${path}`),
        ]),
  ];
}

/**
 * What a prompt-history merge does and does not carry across.
 *
 * The pooled file is only ever appended to, so the merge cannot lose what is already pooled. What it
 * cannot capture is the other direction: the source file is quarantined by rename, and an agent that
 * already holds it open keeps writing into that same quarantined copy, whose lines therefore never
 * reach the pool. Every one of those lines is still on disk at the preserved path — so the honest
 * report names the path, says migrating an idle account avoids the split, and never calls it a loss.
 *
 * Stated per merge because the preserved path differs per account, and a person chasing one missing
 * prompt needs the exact file, not a general warning.
 */
function mergeCaveatLines(preview: SharedHistoryPreview): string[] {
  const merges = preview.changes.filter(isMerge);
  if (merges.length === 0) return [];
  return [
    ...merges.map(
      merge =>
        `${INDENT}prompt history ${merge.source}: only the lines observed here are appended to ${merge.destination}; whatever is written to it afterwards stays at ${merge.sourcePreservedAt} and never joins the pool`,
    ),
    `${INDENT}  the pooled file is only appended to and every preserved copy is kept, so no prompt is discarded either way — pool prompt history while these accounts are idle if you want their last lines in the pool rather than beside it`,
  ];
}

/**
 * The homes that could not be read, and what that costs.
 *
 * A refusal is not a skip, and the difference is the whole point of printing it: an apply that meets
 * one migrates nothing for this harness rather than pooling the homes it happened to manage to read.
 * A report that listed these quietly would describe a partial migration that never happens.
 */
function refusalLines(preview: SharedHistoryPreview): string[] {
  const refusals: readonly SharedHistoryRefusal[] = preview.refusals ?? [];
  if (refusals.length === 0) return [];
  return [
    `${INDENT}! ${plural(refusals.length, 'account home')} could not be read, so an apply REFUSES the whole ${preview.kind} pool — it does not migrate the rest and quietly leave these out:`,
    ...refusals.map(
      refusal => `${INDENT}  ${refusal.account} (${refusal.home}) — ${refusal.reason}; refused at ${refusal.path}`,
    ),
    `${INDENT}  make ${refusals.length === 1 ? 'that home' : 'those homes'} readable, or stop declaring ${refusals.length === 1 ? 'it' : 'them'}, and run this again.`,
  ];
}

/**
 * Everything about one pool that neither the counts nor the change list already say.
 *
 * Shared by the dry run and the applied report so the two cannot drift: a caveat a person reads
 * before deciding must still be there in the record of what was decided.
 */
function sharedHistoryDetail(preview: SharedHistoryPreview): string[] {
  return [...emptiedSourceLines(preview), ...mergeCaveatLines(preview), ...refusalLines(preview)];
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
    ...sharedHistoryDetail(preview),
  ]);
  const caveat = sharesCodexHistory(plan.sharedHistory) ? CODEX_HISTORY_CAVEAT : [];
  return [header, ...operations, ...history, `  manifest   ${plan.manifestPath}`, ...caveat].join('\n');
}

/** What an apply actually did, including anything it swept away. */
export function renderApplyResult(result: FleetApplyResult): string {
  const lines =
    result.accountCount === 0
      ? [
          `The manifest declares no accounts; no wrappers were created in ${plural(result.operationCount, 'operation')}.`,
          '  Next: declare an account in config.yaml and run "fy fleet apply". On a new host, "fy fleet init --first-account" creates one for you.',
          `  manifest: ${result.manifestPath}`,
        ]
      : [
          `applied ${plural(result.accountCount, 'account')} in ${plural(result.operationCount, 'operation')}`,
          `  manifest: ${result.manifestPath}`,
        ];
  if (result.prunedWrappers.length > 0) {
    lines.push(`  pruned ${plural(result.prunedWrappers.length, 'wrapper')}: ${result.prunedWrappers.join(', ')}`);
  }
  for (const shared of result.sharedHistory) {
    lines.push(
      `  shared ${shared.kind}: ${shared.migrated} migrated entries, ${shared.conflicts} collisions preserved, ${shared.links} links → ${shared.pool}`,
      ...sharedHistoryDetail(shared),
    );
  }
  if (sharesCodexHistory(result.sharedHistory)) lines.push(...CODEX_HISTORY_CAVEAT);
  lines.push(...residueLines(result.backupResidue), ...lockResidueLines(result.lockResidue));
  return lines.join('\n');
}

/**
 * Moved-aside originals still on disk.
 *
 * Residue, never a failure — the apply committed and the manifest describes what is there now. It is
 * reported anyway because it is the only remaining copy of what was displaced, so a person tidying up
 * needs to be told it exists rather than discovering it later and guessing what it was.
 */
function residueLines(backupResidue: readonly string[] | undefined): readonly string[] {
  const residue = backupResidue ?? [];
  if (residue.length === 0) return [];
  return [
    `  left ${plural(residue.length, 'moved-aside original')} on disk — the only copy of what was displaced:`,
    ...residue.map(path => `${INDENT}${path}`),
  ];
}

/**
 * The exclusive apply claim this run could not verify releasing.
 *
 * Residue, never a failure — reporting it as one would turn a fleet that fully landed into a fleet
 * the reader believes was refused. But it is not cosmetic either: it BLOCKS THE NEXT APPLY until it
 * is removed, so a reader who is told nothing discovers it as an inexplicable refusal later. Named,
 * with what to do about it, on every surface that can carry one.
 */
function lockResidueLines(lockResidue: string | undefined): readonly string[] {
  if (lockResidue === undefined) return [];
  return [
    `  the exclusive apply claim at ${lockResidue} could not be cleared`,
    `${INDENT}the next apply will refuse until it is removed`,
  ];
}

/** What a host carries after ordinary provisioning committed, printed as fact rather than as loss. */
function committedLines(committed: FleetApplyCommittedState): readonly string[] {
  const lines = [
    `  committed ${plural(committed.accountCount, 'account')} in ${plural(committed.operationCount, 'operation')}`,
    `  manifest: ${committed.manifestPath}`,
  ];
  if (committed.prunedWrappers.length > 0) {
    lines.push(
      `  pruned ${plural(committed.prunedWrappers.length, 'wrapper')}: ${committed.prunedWrappers.join(', ')}`,
    );
  }
  for (const shared of committed.sharedHistory) {
    lines.push(
      `  shared ${shared.kind}: ${shared.migrated} migrated entries, ${shared.conflicts} collisions preserved, ${shared.links} links → ${shared.pool}`,
    );
  }
  lines.push(...residueLines(committed.backupResidue), ...lockResidueLines(committed.lockResidue));
  return lines;
}

/**
 * Content that was NOT this apply's, moved out of the way and not put back.
 *
 * Deliberately its own block rather than more rows in the unrestored list, because they are not the
 * same thing and a reader acts differently on each. Unrestored is OUR state we could not restore;
 * displaced is SOMEBODY ELSE'S file now living under a different name. Merging them would quietly
 * recreate the flattening this whole rendering exists to remove.
 */
function displacedLines(displaced: readonly DisplacedState[] | undefined): readonly string[] {
  const moved = displaced ?? [];
  if (moved.length === 0) return [];
  return [
    `  ${plural(moved.length, 'path')} not belonging to this apply, moved aside and left there:`,
    ...moved.map(entry => `${INDENT}${entry.path} → ${entry.movedTo}`),
  ];
}

/**
 * A failed apply, in the shape the reader actually has to act on.
 *
 * THE QUESTION THIS ANSWERS IS "WHAT IS MY HOST NOW", not "which write threw". Those are different
 * questions with the same cause, and only the first one decides what a person does next: re-run,
 * repair by hand, or stop and look. Flattening all three into "apply failed" is how a fleet that
 * genuinely landed gets applied again blindly, and how a host left half-restored gets re-run on the
 * assumption it is clean.
 *
 * So each outcome leads with its verdict rather than with the error, and the two that changed the
 * host name the exact paths — an unverified restoration is only actionable if you know which entries
 * it could not confirm, and a committed fleet is only safe to leave alone if you can see what it
 * committed.
 */
export function renderFleetApplyFailure(failure: FleetApplyFailure, lockResidue?: string): string {
  // The committed block prints the claim it carries, so printing the error's copy of the same path
  // again underneath it would read as two separate stuck claims.
  const alreadyNamed = failure.kind === 'history-failed-after-commit' ? failure.committed.lockResidue : undefined;
  const lock = lockResidueLines(lockResidue === alreadyNamed ? undefined : lockResidue);

  if (failure.kind === 'rolled-back') {
    return [
      `apply failed at ${failure.failedOperation}: ${failure.reason}`,
      '  the host is exactly as it was — every change was put back and nothing was committed',
      ...lock,
      // A stuck claim makes "just run it again" false: the next apply refuses until it is gone. The
      // advice has to bend to the residue rather than the residue being a footnote under the advice.
      lockResidue === undefined
        ? '  safe to fix the cause and run "fy fleet apply" again'
        : '  fix the cause AND clear the claim above, then run "fy fleet apply" again',
    ].join('\n');
  }
  if (failure.kind === 'rollback-incomplete') {
    return [
      `apply failed at ${failure.failedOperation}: ${failure.reason}`,
      '  THE HOST IS IN AN UNVERIFIED STATE — restoration was attempted and could not be confirmed',
      `  ${plural(failure.unrestored.length, 'path')} whose previous state could not be put back:`,
      ...failure.unrestored.flatMap(entry => [
        `${INDENT}${entry.path} — ${entry.reason}`,
        ...(entry.backup === undefined ? [] : [`${INDENT}  the original is still at ${entry.backup}`]),
      ]),
      ...displacedLines(failure.displaced),
      ...lock,
      '  do NOT re-run until these are resolved by hand; a second apply would build on a state nobody verified',
    ].join('\n');
  }
  return [
    `${failure.failedHarness} shared history failed after the fleet was applied: ${failure.reason}`,
    '  THE FLEET DID LAND. Shared history has its own boundary and did not roll it back, so this is',
    '  what the host now carries:',
    ...committedLines(failure.committed),
    ...lock,
    '  do NOT treat this as a failed apply — the manifest above is live. Only the history step needs',
    '  another attempt.',
  ].join('\n');
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
  if (manifest.accounts.length === 0) {
    return [
      'The fleet manifest declares no accounts.',
      '  Next: declare an account in config.yaml and run "fy fleet apply". On a new host, "fy fleet init --first-account" creates one for you.',
    ].join('\n');
  }
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

/**
 * Account health in a terminal.
 *
 * The verdict is a code on the wire and words here, because the browser renders the same codes in its
 * own words: a daemon that shipped the sentence would be writing this file's copy, and two surfaces
 * would eventually disagree about what a `403` means.
 *
 * `NEEDS CREDENTIAL` is not a softer `NEEDS LOGIN`. An account authenticated by an environment
 * variable or a token file cannot be fixed by signing in — the harness reads that value and never
 * looks at its own credential store — so telling somebody to log in would send them to do something
 * that cannot work.
 */
const HEALTH_VERDICT_LABEL: Readonly<Record<FleetHealthVerdict, string>> = {
  healthy: 'HEALTHY',
  needs_relogin: 'NEEDS LOGIN',
  needs_credentials: 'NEEDS CREDENTIAL',
  unknown: 'UNKNOWN',
};

/** Why, in one clause. Every reason has one: a bare verdict with no reason is not actionable. */
const HEALTH_REASON_LABEL: Readonly<Record<FleetHealthReason, string>> = {
  provider_accepted: 'the provider accepted this credential',
  usage_scope_unavailable: 'accepted; this token cannot read usage, so quota is unknown',
  oauth_credential_missing: 'no credential in this account home',
  oauth_access_expired: 'the access token expired and there is nothing to renew it with',
  oauth_token_rejected: 'the provider rejected this token',
  static_credential_missing: 'the configured credential is absent',
  static_credential_rejected: 'the provider rejected the configured credential',
  never_checked: 'never checked',
  credential_unreadable: 'the credential could not be read',
  oauth_refreshable: 'expired, but renewable — not signed out',
  codex_liveness_unproven: 'Codex has no free way to prove a login; nothing here is a verdict',
  check_timeout: 'the check timed out',
  provider_unavailable: 'the provider could not be reached',
  provider_not_asked: 'signed in locally; the provider has not confirmed it',
  credential_changed_during_check: 'the credential changed while the check ran',
  account_unavailable: 'the manifest declares this account unavailable',
  stale: 'the last result is too old to trust',
};

/** Whole units, coarsest that fits. A terminal reader wants "4m ago", never a millisecond count. */
export function renderRelativeInstant(instant: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - instant) / 1_000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * Which account a verdict is ABOUT — and BOTH halves are needed, which is the whole point.
 *
 * The row used to print `health.accountId` alone: an opaque UUID. That answered "how many accounts
 * need a login" and never "which", so the verdict was correct and addressed to nobody.
 *
 * BUT THE ID IS NOT DECORATION. `fy fleet login <accountId>` matches on exactly that id — see
 * `selectIdentities` — so replacing it with a name would have made the row readable and
 * unactionable, which is the opposite failure. A reader needs the name to know WHICH account and the
 * id to DO something about it, so the row carries the name and the remedy line carries the id.
 *
 * Names come from the manifest the controller already loaded, so nothing new is read and no field is
 * added to the wire: the browser joins by id against the roster it already holds, and only the
 * terminal needs this. `displayName` rather than `wrapper`, because a manifest wrapper is an ABSOLUTE
 * PATH — printing it put `/tmp/…/fleet/bin/claude-default` in the row.
 *
 * FALLS BACK TO THE ID rather than hiding the row or inventing a name. A stored head can outlive the
 * account it is about — the manifest moved, the account was removed — and a verdict about something
 * the manifest cannot name is still a true verdict.
 */
export type FleetAccountNames = ReadonlyMap<string, string>;

function healthSubject(health: FleetAccountHealth, names: FleetAccountNames): string {
  return names.get(health.accountId) ?? health.accountId;
}

/** The verdicts a person can actually do something about, and the id the remedy needs. */
const HEALTH_REMEDY: Readonly<Partial<Record<FleetHealthVerdict, (accountId: string) => string>>> = {
  needs_relogin: accountId => `fy fleet login ${accountId}`,
};

function renderHealthRow(health: FleetAccountHealth, now: number, names: FleetAccountNames): string {
  const checked = health.lastCheckedAt === null ? 'never checked' : renderRelativeInstant(health.lastCheckedAt, now);
  // What it WAS, when staleness is the only reason it is unknown. A bare UNKNOWN there reads exactly
  // like an account nobody has ever looked at, which is the opposite of what happened.
  const was = health.staleVerdict === undefined ? '' : ` (was ${HEALTH_VERDICT_LABEL[health.staleVerdict]})`;
  const inconclusive = health.lastCheckInconclusive ? '; last check was inconclusive' : '';
  const row = `  ${healthSubject(health, names)}  ${HEALTH_VERDICT_LABEL[health.verdict]}${was}  checked ${checked} — ${HEALTH_REASON_LABEL[health.reason]}${inconclusive}`;
  // The exact command, on its own line, for the one verdict a person can act on. "NEEDS LOGIN" with
  // no way to act on it is the state this whole feature exists to stop producing — and the id the
  // command needs is not something a reader could have derived from the name above it.
  const remedy = HEALTH_REMEDY[health.verdict]?.(health.accountId);
  return remedy === undefined ? row : `${row}\n${INDENT}${remedy}`;
}

/**
 * The whole fleet's health.
 *
 * The counts name the two verdicts somebody must act on and deliberately do not add "unknown" to
 * them. Unknown is not a fault: on Codex it is the correct published answer, and counting it beside
 * real rejections would send a person looking for a problem that is not there.
 */
export function renderHealth(snapshot: FleetHealthSnapshot, names: FleetAccountNames = new Map()): string {
  if (snapshot.accounts.length === 0) return 'No accounts to report health for.';
  const counts = (verdict: FleetHealthVerdict): number =>
    snapshot.accounts.filter(account => account.verdict === verdict).length;
  const login = counts('needs_relogin');
  const credential = counts('needs_credentials');
  const suffix = [login === 0 ? '' : `${login} need sign-in`, credential === 0 ? '' : `${credential} need a credential`]
    .filter(Boolean)
    .join(', ');
  return [
    `${snapshot.accounts.length} accounts${suffix === '' ? '' : `, ${suffix}`}`,
    ...snapshot.accounts.map(account => renderHealthRow(account, snapshot.at, names)),
    '',
    // Said every time, because the command it replaces spent real money and somebody who used it
    // before has every reason to assume this one does too.
    'This reads credentials and one free provider status endpoint. It asks no model and uses no inference quota.',
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
export function renderScaffoldResult(
  result: FleetScaffoldResult,
  firstAccount: 'claude' | 'codex' | 'detected' | undefined = undefined,
): string {
  const lines =
    result.created.length === 0 && result.updated.length === 0
      ? ['The fleet is already set up; nothing was changed.']
      : [
          `prepared the fleet in ${result.directories[0] ?? 'its directory'}`,
          ...result.created.map(path => `  created  ${path} (Ferretry starter)`),
          ...result.updated.map(path => `  updated  ${path} (declared the requested first account)`),
        ];
  for (const path of result.kept)
    lines.push(`  kept     ${path} (pre-existing file wins; Ferretry did not replace it)`);
  lines.push('', 'Add this to your shell profile so the generated wrappers are on PATH:', `  ${result.pathEntry}`);
  lines.push(
    '',
    result.declaredAccounts !== undefined
      ? // The harnesses rather than a count, because each one declares two accounts — an interactive
        // lane and an unattended one — so "declared 2 accounts" would read as two harnesses.
        `Declared the default ${result.declaredAccounts.join(' and ')} accounts. Run "fy fleet apply" to materialise their wrappers.`
      : firstAccount === undefined
        ? 'Then declare an account in the configuration and run "fy fleet apply".'
        : 'Kept the existing configuration unchanged; it already declares one or more accounts, so no account was added.',
  );
  return lines.join('\n');
}

/**
 * One login outcome.
 *
 * Every status is named. `usable`, `login-needed` and `indeterminate` are three different reasons
 * nothing happened, and the last one is not a milder version of the other two: it means this home was
 * never read successfully, so nothing can be concluded about it. Collapsing them is how a report ends
 * up implying a fleet is signed in when part of it was never checked.
 *
 * `renewed` is likewise not a quieter `usable`: this account's token had expired, and the run got it
 * back without anybody being asked for anything. That is the line worth reading in the report.
 */
export function renderLoginRow(result: FleetLoginResult): string {
  const detail = result.message === undefined ? '' : ` — ${result.message}`;
  switch (result.status) {
    case 'logged-in':
      return `  ${result.accountId}  logged in`;
    case 'renewed':
      return `  ${result.accountId}  expired token renewed itself, nobody was asked`;
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

/** Where a value came from, in the words a person reading a configuration would use. */
function originLabel(origin: FleetCompositionOrigin): string {
  if (origin.kind === 'account') return 'this account';
  if (origin.kind === 'variant') return `the ${origin.name} lane`;
  if (origin.kind === 'agent') return `the ${origin.name} agent`;
  // Every remaining slot is a named profile — the base one, an agent's, or a lane's — and a reader
  // does not need to be told which list it appeared in to know where to edit it.
  return `the ${origin.name} profile`;
}

/**
 * One selection, said as one line per item.
 *
 * Per item rather than summarized, because the account's selection IS the list and a count of it
 * ("4 skills") answers none of the questions a person opens this screen with: which ones, which of
 * those are the store's, and who else is on each.
 */
function selectionLines(field: string, sharing: Extract<FleetAssetSharing, { state: 'selection' }>): string[] {
  if (sharing.items.length === 0) {
    return [`  ${field.padEnd(9)}none selected · from ${originLabel(sharing.origin)}`];
  }
  const lines = [`  ${field.padEnd(9)}${plural(sharing.items.length, 'item')} · from ${originLabel(sharing.origin)}`];
  for (const item of sharing.items) {
    const others = item.referrers - 1;
    const shared = item.sharedName === undefined ? 'own' : `SHARED "${item.sharedName}"`;
    const also = others === 0 ? 'only this account' : `with ${plural(others, 'other account')}`;
    lines.push(`  ${' '.repeat(9)}${item.name}  ${shared} · ${also} · ${item.path}`);
  }
  return lines;
}

/** One field's state, said in one line: shared with how many, its own, or nothing declared. */
function sharingLine(field: string, sharing: Exclude<FleetAssetSharing, { state: 'selection' }>): string {
  if (sharing.state === 'absent') return `  ${field.padEnd(9)}—`;
  const others = sharing.referrers - 1;
  const state =
    sharing.state === 'shared'
      ? `SHARED "${sharing.name}" · ${others === 0 ? 'only this account' : `with ${plural(others, 'other account')}`}`
      : // A private copy several accounts happen to use is a fleet sharing something it never declared,
        // and saying so is the offer to fix it. One account using its own document needs no adjective.
        `own copy${others === 0 ? '' : ` · also used by ${plural(others, 'other account')}, undeclared`}`;
  return `  ${field.padEnd(9)}${state}\n  ${' '.repeat(9)}${sharing.path} · from ${originLabel(sharing.origin)}`;
}

/**
 * The sharing screen: which documents this fleet offers, and what each account actually uses.
 *
 * Written so the two questions a person has are answered in the order they ask them — "what is
 * shared" then "who is on it" — and so a document nobody uses is visible rather than implied by
 * absence from the account list. An account field that resolves to an undeclared path shared by
 * others is called out, because that is a fleet sharing something it never said it shared.
 */
export function renderFleetSharing(sharing: FleetSharing): string {
  const lines: string[] = [];
  lines.push(sharing.documents.length === 0 ? 'This fleet declares no shared documents.' : 'Shared documents');
  for (const document of sharing.documents) {
    const users = document.accounts.length === 0 ? 'used by no account' : plural(document.accounts.length, 'account');
    lines.push(`  ${document.field}/${document.name}  ${document.path} · ${users}`);
  }
  lines.push('');
  if (sharing.accounts.length === 0) {
    lines.push('This fleet declares no accounts.');
    return lines.join('\n');
  }
  for (const account of sharing.accounts) {
    lines.push(`${account.displayName} (${account.wrapper}, ${account.kind})`);
    for (const field of account.linkable) {
      const sharing = account.fields[field];
      if (sharing.state === 'selection') lines.push(...selectionLines(field, sharing));
      else lines.push(sharingLine(field, sharing));
    }
    for (const layer of account.settings) {
      lines.push(
        layer.kind === 'inline'
          ? `  settings  [${layer.position}] inline · from ${originLabel(layer.origin)}`
          : `  settings  [${layer.position}] ${layer.name === undefined ? 'own' : `SHARED "${layer.name}"`} · ${layer.path} · from ${originLabel(layer.origin)}`,
      );
    }
    lines.push('');
  }
  lines.push('Link one to a shared document, or give it its own copy, from the Fleet tab.');
  return lines.join('\n');
}
