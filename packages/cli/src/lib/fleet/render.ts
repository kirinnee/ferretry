import type {
  CredentialState,
  DisplacedState,
  FleetAccountHealth,
  FleetApplyCommittedState,
  FleetApplyFailure,
  FleetApplyPreview,
  FleetApplyResult,
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
import type {
  FleetAssetMaterialization,
  FleetAssetSharing,
  FleetCompositionOrigin,
  FleetSharing,
} from '@ferretry/protocol';
import type { FleetInk, FleetPalette, FleetPresentation, PaintedFragment } from './presentation.ts';
import { packFragments, softWrap } from './presentation.ts';
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
 * What a `symlink` line in a plan means for the person approving it.
 *
 * Shown only when the plan has one, and worth its three lines because the word is the one operation in
 * the list whose effect keeps going after the apply finishes: every other line writes bytes once, and
 * this one makes two names into one file. Somebody who reads `symlink` as "copy, but cleverer" will be
 * surprised the first time an edit to one account's instructions turns up in another's.
 */
const SYMLINK_NOTE: readonly string[] = [
  '  ! a symlink line makes the destination the SAME FILE as the source, which is the point: editing',
  `${INDENT}the shared document is already every account that references it, with no apply in between.`,
  `${INDENT}A source outside this fleet’s asset tree is copied instead, and says "copy" above.`,
];

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
  const linking = plan.operations.some(operation => operation.kind === 'symlink') ? SYMLINK_NOTE : [];
  return [header, ...operations, ...history, `  manifest   ${plan.manifestPath}`, ...linking, ...caveat].join('\n');
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

/**
 * One model in the list an account's row leads with: its identifier, and what is true about it.
 *
 * The IDENTIFIER is the subject and the rest is annotation, because the id is what a person types
 * into `--model` and what the provider answers to. A display name is a nicety and the default is a
 * property, so both are annotations on the one string that matters rather than a second column.
 */
function modelEntry(account: FleetManifestAccount, model: FleetManifestAccount['models'][number]): string {
  const notes = [
    ...(model.displayName === undefined ? [] : [model.displayName]),
    ...(account.defaultModel === model.id ? ['default'] : []),
  ];
  return notes.length === 0 ? model.id : `${model.id} (${notes.join(', ')})`;
}

/**
 * One account row: what it is, which models it serves, and whether it can be used.
 *
 * EVERY DECLARED MODEL IS NAMED, and an unavailable one is named WITH ITS REASON on its own line.
 * The row used to filter the list to available models, so an account declaring
 * `available: false, unavailableReason: …` on one model printed a shorter list and nothing else — the
 * declaration a person had written, and the reason they had written it for, were both invisible in
 * the one command that exists to say what this host publishes. A reason nobody can read is a reason
 * nobody acts on, and the account went on reading `available` underneath it.
 *
 * THE VERB CHANGES WITH THE ACCOUNT, because the model list means something different either side of
 * it. Nothing routes to an unavailable account — `selectableModelIds` empties for one whatever its
 * models say — so a row that claimed such an account `serves` them would be stating a capability the
 * fleet would refuse to use. It `declares` them instead, and the account's own line says why not.
 */
export function renderAccount(account: FleetManifestAccount): string {
  const entries = account.models.filter(model => model.available).map(model => modelEntry(account, model));
  const verb = account.available ? 'serves' : 'declares';
  const unavailable = account.models.flatMap(model =>
    model.available ? [] : [`${INDENT}model ${model.id} is unavailable — ${model.unavailableReason}`],
  );
  return [
    `  ${account.id}  [${account.kind}/${account.mode}]  ${account.displayName}`,
    `${INDENT}wrapper ${account.wrapper} · home ${account.home}`,
    `${INDENT}${entries.length === 0 ? `${verb} no models` : `${verb} ${entries.join(', ')}`}`,
    ...unavailable,
    `${INDENT}${account.available ? 'available' : `unavailable — ${account.unavailableReason}`}`,
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

/**
 * Which account a row is ABOUT.
 *
 * A row that printed `accountId` alone printed an opaque UUID, which answered "how many accounts are
 * at their limit" or "how many need a login" and never "which". Every row was correct and addressed to
 * nobody.
 *
 * Names come from the manifest the controller already loaded, so nothing new is read and no field is
 * added to the wire: the browser joins by id against the roster it already holds, and only the
 * terminal needs this. `displayName` rather than `wrapper`, because a manifest wrapper is an ABSOLUTE
 * PATH — printing it put `/tmp/…/fleet/bin/claude-default` in the row.
 *
 * FALLS BACK TO THE ID rather than hiding the row or inventing a name. A stored head can outlive the
 * account it is about — the manifest moved, the account was removed — and a report about something
 * the manifest cannot name is still a true report.
 */
export type FleetAccountNames = ReadonlyMap<string, string>;

/** The one join from a manifest to the lookup every row-namer takes, so the two surfaces cannot drift. */
export function fleetAccountNames(manifest: FleetManifest): FleetAccountNames {
  return new Map(manifest.accounts.map(account => [account.id, account.displayName]));
}

function accountSubject(accountId: string, names: FleetAccountNames): string {
  return names.get(accountId) ?? accountId;
}

/** A quota window as a percentage, or a dash when the provider did not say. */
function percent(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value)}%`;
}

/**
 * One usage row. An account at its limit is called out, because that is the actionable case.
 *
 * NO REMEDY LINE, deliberately, and that is the difference from a health row rather than an omission.
 * `fy fleet health` prints `fy fleet login <accountId>` beside an account a login repairs, so the id
 * has to travel with the name. There is no command that "fixes" a quota number — a window resets on
 * the provider's clock — so a row here carries the name alone, and printing an instruction nobody can
 * act on would be the same defect in a different costume.
 */
export function renderUsageRow(usage: FleetUsage, names: FleetAccountNames = new Map()): string {
  const subject = accountSubject(usage.accountId, names);
  if (usage.unavailable) return `  ${subject}  unavailable — ${usage.unavailableReason ?? 'no reason given'}`;
  if (!usage.ok) return `  ${subject}  probe failed — ${usage.error ?? 'no reason given'}`;
  if (!usage.usageBased) return `  ${subject}  pay-as-you-go — no quota to report`;
  const limit = usage.atLimit ? '  AT LIMIT' : '';
  return `  ${subject}  short ${percent(usage.shortWindow?.usedPercent)} · long ${percent(usage.longWindow?.usedPercent)}${limit}`;
}

/** The whole fleet's quota picture. */
export function renderUsage(snapshot: FleetUsageSnapshot, names: FleetAccountNames = new Map()): string {
  if (snapshot.accounts.length === 0) return 'No accounts to report usage for.';
  const exhausted = snapshot.accounts.filter(account => account.atLimit).length;
  const header = `${plural(snapshot.accounts.length, 'account')}${exhausted === 0 ? '' : `, ${exhausted} at limit`}`;
  return [header, ...snapshot.accounts.map(account => renderUsageRow(account, names))].join('\n');
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

/**
 * Why, in ONE clause. Every reason has one: a bare verdict with no reason is not actionable.
 *
 * One clause, not three. `codex_liveness_unproven` used to say "Codex has no free way to prove a
 * login; nothing here is a verdict" and then had "; last check was inconclusive" appended to it — the
 * same fact three times, on the row where the reader has least reason to keep reading, on the only
 * verdict that repeats identically down the whole report.
 */
const HEALTH_REASON_LABEL: Readonly<Record<FleetHealthReason, string>> = {
  provider_accepted: 'the provider accepted this credential',
  usage_scope_unavailable: 'accepted; this token cannot read usage, so quota is unknown',
  oauth_credential_missing: 'no credential in this account home',
  oauth_access_expired: 'the access token expired and there is nothing to renew it with',
  oauth_token_rejected: 'the provider rejected this token',
  static_credential_missing: 'the configured credential is absent',
  static_credential_rejected: 'the provider rejected the configured credential',
  never_checked: 'no check has run for this account',
  credential_unreadable: 'the credential could not be read',
  oauth_refreshable: 'expired, but renewable — not signed out',
  codex_liveness_unproven: 'Codex offers no free check',
  check_timeout: 'the check timed out',
  provider_unavailable: 'the provider could not be reached',
  provider_not_asked: 'signed in locally; the provider has not confirmed it',
  credential_changed_during_check: 'the credential changed while the check ran',
  account_unavailable: 'the manifest declares this account unavailable',
  stale: 'the last result is too old to trust',
};

/**
 * Worst first, and every verdict appears exactly once.
 *
 * Rows used to come out in manifest order, so an account a person must act on sat between two that
 * need nothing and the report had to be read end to end before anything could be triaged. This is
 * also the order the summary counts in, so the header and the rows tell the same story top to bottom.
 *
 * The two actionable verdicts lead, `needs_relogin` first because it is the one with a command beside
 * it. `unknown` sits BELOW both and above `healthy`: it is not a fault, and putting it among the
 * faults is what made the old header undercount.
 */
const HEALTH_VERDICT_ORDER: readonly FleetHealthVerdict[] = [
  'needs_relogin',
  'needs_credentials',
  'unknown',
  'healthy',
];

/**
 * The second channel, so triage survives `NO_COLOR`, a pipe and colour blindness.
 *
 * Colour carries severity here, and colour alone would be the only channel — which is exactly what a
 * redirect, a `NO_COLOR` terminal or a reader who cannot separate red from grey would silently lose.
 * The glyph says the same thing in the same column on every row, with or without paint.
 */
const HEALTH_GLYPH: Readonly<Record<FleetHealthVerdict, string>> = {
  needs_relogin: '✗',
  needs_credentials: '✗',
  unknown: '?',
  healthy: '✓',
};

/**
 * Each verdict's share of the fleet, in words.
 *
 * EVERY ACCOUNT IS COUNTED. The header used to name only the two actionable verdicts, so "4 accounts,
 * 2 need sign-in" said nothing about the other two and read as a promise that they were fine. They
 * were `UNKNOWN`.
 */
const HEALTH_COUNT_LABEL: Readonly<Record<FleetHealthVerdict, (count: number) => string>> = {
  needs_relogin: count => `${count} need${count === 1 ? 's' : ''} sign-in`,
  needs_credentials: count => `${count} need${count === 1 ? 's' : ''} a credential`,
  unknown: count => `${count} unknown`,
  healthy: count => `${count} healthy`,
};

/**
 * Which ink a verdict is written in.
 *
 * `UNKNOWN` IS MUTED AND DELIBERATELY NOT A WARNING COLOUR. It is the honest published answer for a
 * Codex account rather than a problem, and a fleet whose every Codex row glowed amber would teach its
 * owner to look past amber — which is the one place a real warning has to work.
 */
function healthInk(verdict: FleetHealthVerdict, palette: FleetPalette): FleetInk {
  switch (verdict) {
    case 'needs_relogin':
    case 'needs_credentials':
      return palette.danger;
    case 'healthy':
      return palette.good;
    default:
      return palette.muted;
  }
}

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
 * The verdicts a person can actually do something about, and the id the remedy needs.
 *
 * THE ID IS NOT DECORATION HERE, which is why a health row carries BOTH halves while a usage row
 * carries only the name. `fy fleet login <accountId>` matches on exactly that id — see
 * `selectIdentities` — so a row that named the account and nothing else would be readable and
 * unactionable, the opposite of the failure naming it fixed.
 */
const HEALTH_REMEDY: Readonly<Partial<Record<FleetHealthVerdict, (accountId: string) => string>>> = {
  needs_relogin: accountId => `fy fleet login ${accountId}`,
};

/** Where a row starts, where its own overflow goes, and where its command sits. Three depths, three meanings. */
const HEALTH_ROW_INDENT = '  ';
/** Under the account name, never at a row's own depth: a wrapped clause must not read as a new account. */
const HEALTH_WRAP_INDENT = '    ';
const HEALTH_REMEDY_INDENT = '      ';
const HEALTH_GUTTER = '  ';
/** A name past this stops widening the column for everybody; it overflows its own row instead. */
const HEALTH_NAME_COLUMN_CAP = 32;
/** Below this there is no room for a clause worth reading, so the reason takes its own line. */
const HEALTH_MINIMUM_REASON_COLUMN = 24;

/**
 * Said every time, because the command this replaced spent real money and somebody who used it before
 * has every reason to assume this one does too. Shortened, never dropped: it is the promise.
 */
const HEALTH_DISCLOSURE = 'Reads credentials and one free status endpoint — no model, no inference quota.';

/** When the check ran, in the words the header and a row both use so they cannot disagree. */
function healthCheckedLabel(health: FleetAccountHealth, now: number): string {
  return health.lastCheckedAt === null
    ? 'never checked'
    : `checked ${renderRelativeInstant(health.lastCheckedAt, now)}`;
}

/**
 * The instant every row shares, or nothing when they differ.
 *
 * `checked just now` on all four rows was four copies of one fact, in the widest column, pushing the
 * reason off the edge of the terminal. It is hoisted into the header when it is the same everywhere
 * and stays on the rows when it is not — because THEN it is per-row information, and a header that
 * flattened two different instants into one would be reporting something nobody measured.
 *
 * Compared as RENDERED words rather than as instants: two checks a second apart are both "just now"
 * to a reader, and that is the fact being deduplicated.
 */
function sharedHealthCheck(accounts: readonly FleetAccountHealth[], now: number): string | undefined {
  const labels = new Set(accounts.map(account => healthCheckedLabel(account, now)));
  return labels.size === 1 ? [...labels][0] : undefined;
}

/** Reasons that already say the check proved nothing; a second clause saying it is noise. */
const HEALTH_SELF_EVIDENT_INCONCLUSIVE: ReadonlySet<FleetHealthReason> = new Set<FleetHealthReason>([
  'codex_liveness_unproven',
  'never_checked',
]);

/**
 * Everything after the verdict, as clauses a reader can stop after any one of.
 *
 * `was HEALTHY` travels HERE rather than beside the verdict, where it used to sit. In the verdict
 * column it made one row wider than every other and broke the alignment the eye runs down — and what
 * a stale verdict WAS is detail, while what it is now is the thing being triaged.
 */
function healthReasonTail(health: FleetAccountHealth, sharedCheck: string | undefined, now: number): string {
  const clauses = [HEALTH_REASON_LABEL[health.reason]];
  // What it WAS, when staleness is the only reason it is unknown. A bare UNKNOWN there reads exactly
  // like an account nobody has ever looked at, which is the opposite of what happened.
  if (health.staleVerdict !== undefined) clauses.push(`was ${HEALTH_VERDICT_LABEL[health.staleVerdict]}`);
  if (health.lastCheckInconclusive && !HEALTH_SELF_EVIDENT_INCONCLUSIVE.has(health.reason)) {
    clauses.push('last check inconclusive');
  }
  if (sharedCheck === undefined) clauses.push(healthCheckedLabel(health, now));
  return clauses.join(' · ');
}

/** The two padded columns, measured once over the whole report so every row lines up under the last. */
interface HealthColumns {
  readonly name: number;
  readonly verdict: number;
}

function healthColumns(accounts: readonly FleetAccountHealth[], names: FleetAccountNames): HealthColumns {
  const widths = accounts.map(account => accountSubject(account.accountId, names).length);
  return {
    name: Math.min(Math.max(...widths), HEALTH_NAME_COLUMN_CAP),
    verdict: Math.max(...accounts.map(account => HEALTH_VERDICT_LABEL[account.verdict].length)),
  };
}

/** Padding is applied OUTSIDE the ink, so a column's width is never measured against escape codes. */
function padding(text: string, column: number): string {
  return ' '.repeat(Math.max(0, column - text.length));
}

/**
 * One account, as the lines it occupies.
 *
 * A LIST OF LINES RATHER THAN A STRING WITH NEWLINES IN IT, because every one of them needs its own
 * indent: a reason that overflows an 80-column terminal used to be wrapped by the terminal itself,
 * with no indent at all, so the second half of a sentence started hard against the left margin and
 * read as the next account. The structure survived only on a wide screen.
 */
function healthRowLines(
  health: FleetAccountHealth,
  names: FleetAccountNames,
  columns: HealthColumns,
  presentation: FleetPresentation,
  sharedCheck: string | undefined,
  now: number,
): readonly string[] {
  const { palette, width } = presentation;
  const ink = healthInk(health.verdict, palette);
  const subject = accountSubject(health.accountId, names);
  const label = HEALTH_VERDICT_LABEL[health.verdict];
  const head = `${HEALTH_ROW_INDENT}${ink(HEALTH_GLYPH[health.verdict])} ${subject}${padding(subject, columns.name)}${HEALTH_GUTTER}${ink(label)}${padding(label, columns.verdict)}${HEALTH_GUTTER}`;
  const headWidth =
    HEALTH_ROW_INDENT.length +
    2 +
    Math.max(subject.length, columns.name) +
    HEALTH_GUTTER.length +
    Math.max(label.length, columns.verdict) +
    HEALTH_GUTTER.length;
  const wrapped = width - HEALTH_WRAP_INDENT.length;
  const tail = healthReasonTail(health, sharedCheck, now);
  const inline = width - headWidth >= HEALTH_MINIMUM_REASON_COLUMN;
  const segments = softWrap(tail, inline ? width - headWidth : wrapped, wrapped);
  const lines = inline
    ? [
        `${head}${palette.muted(segments[0] ?? '')}`,
        ...segments.slice(1).map(part => `${HEALTH_WRAP_INDENT}${palette.muted(part)}`),
      ]
    : [head.trimEnd(), ...segments.map(part => `${HEALTH_WRAP_INDENT}${palette.muted(part)}`)];
  // The exact command, on its own line, for the one verdict a person can act on. "NEEDS LOGIN" with
  // no way to act on it is the state this whole feature exists to stop producing — and the id the
  // command needs is not something a reader could have derived from the name above it. NEVER WRAPPED:
  // this line exists to be selected, and a break inside the id produces something that looks copyable.
  const remedy = HEALTH_REMEDY[health.verdict]?.(health.accountId);
  return remedy === undefined ? lines : [...lines, `${HEALTH_REMEDY_INDENT}${palette.command(remedy)}`];
}

/** The summary, as fragments that keep their own colour so packing them cannot lose the paint. */
function healthHeaderFragments(
  accounts: readonly FleetAccountHealth[],
  palette: FleetPalette,
  sharedCheck: string | undefined,
): readonly PaintedFragment[] {
  const total = plural(accounts.length, 'account');
  const fragments: PaintedFragment[] = [{ plain: total, painted: total }];
  for (const verdict of HEALTH_VERDICT_ORDER) {
    const count = accounts.filter(account => account.verdict === verdict).length;
    if (count === 0) continue;
    const text = HEALTH_COUNT_LABEL[verdict](count);
    fragments.push({ plain: text, painted: healthInk(verdict, palette)(text) });
  }
  if (sharedCheck !== undefined) fragments.push({ plain: sharedCheck, painted: palette.muted(sharedCheck) });
  return fragments;
}

/**
 * The whole fleet's health, ordered and coloured so nobody has to read it to triage it.
 *
 * COLOUR IS THE SECOND CHANNEL AND NEVER THE ONLY ONE. It arrives as a palette rather than being
 * decided here, so a pipe, a redirect and `NO_COLOR` all get the identity palette — and the glyph
 * column, the verdict column and the worst-first order carry the same information without it.
 */
export function renderHealth(
  snapshot: FleetHealthSnapshot,
  names: FleetAccountNames,
  presentation: FleetPresentation,
): string {
  if (snapshot.accounts.length === 0) return 'No accounts to report health for.';
  const { palette, width } = presentation;
  const sharedCheck = sharedHealthCheck(snapshot.accounts, snapshot.at);
  const header = packFragments(
    healthHeaderFragments(snapshot.accounts, palette, sharedCheck),
    ' · ',
    width,
    width - HEALTH_ROW_INDENT.length,
  );
  const columns = healthColumns(snapshot.accounts, names);
  const ordered = [...snapshot.accounts].sort(
    (left, right) => HEALTH_VERDICT_ORDER.indexOf(left.verdict) - HEALTH_VERDICT_ORDER.indexOf(right.verdict),
  );
  return [
    ...header.map((line, index) => (index === 0 ? line : `${HEALTH_ROW_INDENT}${line}`)),
    '',
    ...ordered.flatMap(account => healthRowLines(account, names, columns, presentation, sharedCheck, snapshot.at)),
    '',
    ...softWrap(HEALTH_DISCLOSURE, width - HEALTH_ROW_INDENT.length, width - HEALTH_ROW_INDENT.length).map(
      line => `${HEALTH_ROW_INDENT}${palette.muted(line)}`,
    ),
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
 * What each mechanism means for the person doing the editing.
 *
 * Three sentences rather than a table, and each one is about the EDIT rather than about the filesystem:
 * "symlink" tells somebody nothing about whether their change survives, which is the only thing they
 * came here to find out.
 */
const MECHANISM_LEGEND: readonly string[] = [
  'linked = one file. Editing it edits every account that references it, with no apply in between.',
  'copied at apply = the bytes as of the last apply, because the source is outside this fleet’s asset tree.',
  'generated = composed from its layers on every apply. Edit a layer, never the file in the home.',
  '',
];

/**
 * How the value actually reaches the home, in the words that tell a person what an edit does.
 *
 * Said on every line that names a path, because it is the difference between "editing this changes
 * every account" and "editing this is overwritten by the next apply" — and somebody who is not told
 * which one they have will eventually find out the expensive way. An absent mechanism is a field this
 * harness has no destination for, and those are already filtered out of `linkable` before this is
 * reached, so there is nothing to say for it.
 */
function mechanismLabel(materialization: FleetAssetMaterialization | undefined): string {
  if (materialization === 'link') return ' · linked';
  if (materialization === 'copy') return ' · copied at apply';
  if (materialization === 'generated') return ' · merged into a generated file';
  return '';
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
    lines.push(
      `  ${' '.repeat(9)}${item.name}  ${shared} · ${also} · ${item.path}${mechanismLabel(item.materialization)}`,
    );
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
  return `  ${field.padEnd(9)}${state}\n  ${' '.repeat(9)}${sharing.path} · from ${originLabel(sharing.origin)}${mechanismLabel(sharing.materialization)}`;
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
    // Said per account rather than only in the legend, because a stack is the one field where the
    // destination is not any of the things listed above it: the layers are merged in memory and written
    // as one file, so editing that file in the home is an edit the next apply discards.
    if (account.settings.length > 0) {
      lines.push(`  settings  ${plural(account.settings.length, 'layer')} merged in order into one generated file`);
    }
    lines.push('');
  }
  lines.push(...MECHANISM_LEGEND);
  lines.push('Link one to a shared document, or give it its own copy, from the Fleet tab.');
  return lines.join('\n');
}
