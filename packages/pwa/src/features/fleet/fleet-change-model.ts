/**
 * The pure half of the fleet cockpit: what the daemon said, what the person is drafting, and what
 * the change would do to the host.
 *
 * Three rules are enforced here rather than in the screen, because a screen is where they get quietly
 * dropped:
 *
 *  1. **A failed read is never an empty fleet.** Missing configuration, damaged configuration, a
 *     never-applied host and a genuinely empty one are four different states with four different
 *     sentences. `classifyInventory` is the only place that decides which one is true, and it decides
 *     it from positive evidence.
 *  2. **The preview is the change.** The operation ledger and the live-versus-proposed roster are
 *     projections of what the DAEMON derived, never of what the browser drafted. A browser that
 *     rendered its own guess would be showing a review of a change nobody is going to apply.
 *  3. **The asset grammar is checked before the round trip, not restated.** `fleetAssetRefProblem` in
 *     the shared protocol is the ONE description of what a remote caller may name; this module calls it
 *     so a person gets a straight answer while typing, and adds only the field label the reason belongs
 *     beside. A second copy of the rule is how the browser ends up laxer than the daemon — which is
 *     exactly what happened while it was copied: the copy allowed `~`, `$HOME` and format controls.
 */

import {
  fleetAssetRefProblem,
  type GrantRefusal,
  type HarnessDiscovery,
  type HarnessDiscoveryReport,
  isLoopbackHost,
} from '@ferretry/protocol';
import { type GrantRefusalNotice, grantGuidance } from '../../lib/grants.ts';
import type {
  FleetApplyOutcome,
  FleetAssetIndex,
  FleetConfigView,
  FleetManifestAccountView,
  FleetManifestSummary,
  FleetPermissions,
  FleetProposalRequest,
  FleetRefusalView,
  FleetWriteOperation,
} from './fleet-api.ts';
import { type LocalNetworkAccess, localNetworkBlocked } from '../../lib/local-network-access.ts';
import { defaultFleetHarness, type FleetHarnessKind, type FleetHarnessView } from './fleet-model.ts';

/** A read that either produced evidence or produced a stated refusal. There is no third answer. */
export type FleetProbe<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: FleetRefusalView };

/**
 * What this daemon's fleet is, said out loud.
 *
 * `live` is the ONLY state that may render a roster, and an empty roster inside it is a positively
 * observed empty fleet rather than an absence of evidence.
 */
export type FleetInventory =
  | { readonly kind: 'live'; readonly manifest: FleetManifestSummary }
  | { readonly kind: 'uninitialized'; readonly detail: string }
  | { readonly kind: 'not-applied'; readonly detail: string }
  | { readonly kind: 'damaged'; readonly detail: string }
  /**
   * The read was refused. `grant` is present when the OPERATOR refused it rather than the credential
   * class — three different situations a person acts on differently, which a single "may not read the
   * fleet" sentence collapses into a dead end.
   */
  | { readonly kind: 'forbidden'; readonly detail: string; readonly grant?: GrantRefusalNotice }
  | { readonly kind: 'unreachable'; readonly detail: string };

export const classifyInventory = (
  manifest: FleetProbe<FleetManifestSummary>,
  config: FleetProbe<FleetConfigView>,
): FleetInventory => {
  if (manifest.ok) return { kind: 'live', manifest: manifest.value };
  const refusal = manifest.refusal;
  if (refusal.kind === 'forbidden')
    return {
      kind: 'forbidden',
      detail: refusal.detail,
      ...(refusal.grant === undefined ? {} : { grant: refusal.grant }),
    };
  if (refusal.kind === 'unreachable') return { kind: 'unreachable', detail: refusal.detail };
  if (refusal.kind !== 'not-applied') return { kind: 'damaged', detail: refusal.detail };
  // The manifest is absent. Whether that is a first run or an unapplied edit is the config's answer.
  if (config.ok) return { kind: 'not-applied', detail: refusal.detail };
  if (config.refusal.kind === 'config-missing') return { kind: 'uninitialized', detail: config.refusal.detail };
  return { kind: 'damaged', detail: config.refusal.detail };
};

/** A change can only be derived from a configuration that exists and parses. */
export const mayComposeChange = (inventory: FleetInventory): boolean =>
  inventory.kind === 'live' || inventory.kind === 'not-applied';

export const mayInitialize = (inventory: FleetInventory): boolean => inventory.kind === 'uninitialized';

/**
 * IS THIS DAEMON OUT OF REACH RIGHT NOW — from the evidence, or from the last thing that was tried.
 *
 * Read by every control whose precondition is a daemon that answers. A staged change outlives the
 * reachability of the host it was staged against: somebody stages, the address stops answering, and the
 * review is still on screen with an enabled Apply and a password field in front of a limiter that
 * cannot be asked anything. An enabled control that cannot possibly work is the same dead end a greyed
 * control with no explanation is, arrived at from the other side.
 *
 * TWO SOURCES, because they fail at different moments. `inventory` is the last READ of the host, and
 * `refusal` is the last thing this panel ATTEMPTED — an apply whose fetch never completed is the first
 * news the panel gets, and it arrives before any re-read has landed.
 */
export const daemonOutOfReach = (inventory: FleetInventory | null, refusal: FleetRefusalView | null): boolean =>
  inventory?.kind === 'unreachable' || refusal?.kind === 'unreachable';

/**
 * What a browser that could not reach a daemon KNOWS, and deliberately not one sentence more.
 *
 * ## IT MUST NOT NAME A CAUSE IT HAS NOT ESTABLISHED
 *
 * "Start the daemon" was the obvious remedy and it is wrong, in the way that costs somebody an
 * afternoon: a daemon that is serving and a request this browser never sent produce the SAME failure
 * here — no status, no body, nothing but the fetch not completing. The owner who met this had `fyd`
 * serving with a pid at the time. So the copy names the two possibilities and gives the check that
 * tells them apart, rather than asserting the one that is easier to word.
 *
 * ## ONE CAUSE IT CAN ESTABLISH, PARTLY
 *
 * A page served over `https` fetching an `http` address is a mixed request, and a browser may refuse it
 * before anything leaves the tab. The scheme pair is a fact the page holds, so that possibility is
 * NAMED when it is true and absent when it is not — which is different from claiming it is the cause.
 * Nothing here reads a peer address to decide anything about authority; the schemes decide only which
 * sentence is honest.
 *
 * It names TWO restrictions rather than one, and the second was measured in this repository: #369 found
 * that Chrome 150 refuses a page on a public origin reaching `http://127.0.0.1:<port>` before any request
 * is sent — the server sees no preflight and no connection — because local network access is denied by
 * default. So an earlier draft of this sentence, which said Chrome and Firefox allow such a request for a
 * loopback address, was false reassurance pointing away from the likeliest cause.
 *
 * ## AND ONE IT CAN ESTABLISH OUTRIGHT, WHEN THE BROWSER ANSWERS
 *
 * Naming two possibilities is honest; knowing which one it is, is useful. `localNetwork` is the
 * browser's own answer about this site's local-network permission, and when it says "not granted" the
 * refusal is no longer a candidate — it is a fact, with a remedy. The default is `'unknown'`, which is
 * every browser that has no such permission and every query that failed, and it words the two
 * possibilities exactly as it did before this was asked at all.
 *
 * `'prompt'` COUNTS AS BLOCKED, which is the counter-intuitive half: it was measured WHILE the fetch
 * was refused and zero requests reached the server, because Chrome does not raise a prompt first. A
 * check that treated anything but `'denied'` as fine would report the blocked case as healthy.
 */
export interface FleetUnreachableDiagnosis {
  readonly headline: string;
  readonly body: string;
  /** The address, carried so a control that has to say ONE short sentence can name it too. */
  readonly target: string;
  /** Ordered, and each one DISCRIMINATES: a check whose answer changes nothing is noise beside a failure. */
  readonly checks: readonly string[];
}

/**
 * The permission's own wording, as Chrome writes it — read out of `locales/en-US.pak` rather than
 * paraphrased, because it is what a person types into a settings search box. The navigation to it is
 * deliberately NOT written down: nobody here has verified a menu path, and an invented one sends a
 * reader somewhere that may not exist. Searchable wording is a fact; a path would be a guess.
 */
const LOCAL_NETWORK_WORDING = 'access other devices on your local network';

/**
 * Is the address this pairing carries one the local-network restriction could apply to?
 *
 * COPY ONLY, like the scheme pair above. Nothing about authority, locality or governance is derived
 * here — `src/lib/grants.ts` states why deciding that from an address would be the worst bug in this
 * feature — and the predicate itself is the protocol's, because a second spelling of "loopback" is
 * how two files end up disagreeing about which machine an address names.
 */
const localTarget = (target: string): boolean => URL.canParse(target) && isLoopbackHost(new URL(target).hostname);

export const unreachableDiagnosis = (
  /** The direct address this pairing carries. Named because the reader has to type it somewhere. */
  target: string,
  /** The scheme this page is served over, exactly as `location.protocol` spells it. */
  pageScheme: string,
  /** What the browser said about reaching the local network, or `'unknown'` when it said nothing. */
  localNetwork: LocalNetworkAccess = 'unknown',
  clientName = 'fy',
): FleetUnreachableDiagnosis => {
  const mixedRequest = pageScheme === 'https:' && target.startsWith('http://');
  /** A permission can only be what happened if it covers the address that was tried. */
  const restrictable = mixedRequest || localTarget(target);
  const blocked = restrictable && localNetworkBlocked(localNetwork);
  const refused = localNetwork === 'denied';
  return {
    headline: blocked
      ? 'This browser is blocking this page from your local network'
      : 'This browser could not reach this daemon',
    target,
    body: blocked
      ? `This site is not allowed to ${LOCAL_NETWORK_WORDING}, which is what the browser answered when this page asked it — measured, not guessed.${refused ? ' It was refused rather than never asked for, so the answer already stored for this site is the one to change.' : ''} A browser that has not allowed it refuses the request before anything is sent, which is why nothing came back and why the daemon has no record of it: no request to ${target} left this page. Allow this site to ${LOCAL_NETWORK_WORDING} and reload. That is a per-site permission worded exactly that way, so searching your browser's settings for that wording finds it. None of this is evidence about the daemon itself, so if allowing it does not fix this, the checks below still apply.`
      : `Nothing came back, so nothing about this host is known from here. That is NOT evidence that the daemon is stopped — a daemon that is serving and a request this browser never sent fail in exactly the same way, and this panel will not guess which one happened. This pairing's direct address is ${target}; the line below is what the attempt itself said.${restrictable && localNetwork === 'granted' ? ` This site IS allowed to ${LOCAL_NETWORK_WORDING}, so that restriction is one thing this failure is not.` : ''}`,
    checks: [
      `Is the daemon serving? Run \`${clientName} daemon status\` on that machine. If it prints a pid, the daemon is not what is wrong.`,
      `Can this browser reach that address at all? Open ${target}/healthz in a tab on this device. A request the browser itself refuses never reaches this page as an error, so it looks identical to silence.`,
      // Only while the state is unknown. Once the browser has answered, the body says which it was, and
      // a check whose answer is already on screen is noise beside a failure.
      ...(restrictable && localNetwork === 'unknown'
        ? [
            `Has this site been allowed to ${LOCAL_NETWORK_WORDING}? Chrome refuses a page's request to a loopback or private address until it has been, and refuses it before anything is sent, so it looks exactly like a stopped daemon. This browser gave no answer when this page asked, so it is worth checking by hand: it is a per-site permission worded exactly that way.`,
          ]
        : []),
      ...(mixedRequest
        ? [
            `This page is served over https and that address is plain http, so every request to it is a mixed one, and Safari has historically refused those outright. Nothing is sent when it does, so this page sees exactly what it would see from a stopped daemon. That is a browser rule rather than a fault on the host.`,
          ]
        : []),
    ],
  };
};

/**
 * How this caller may turn a reviewed change into host state, before it tries.
 *
 * ## THE FLEET HAS NO AUTHORITY OF ITS OWN ANY MORE
 *
 * This used to name three fleet-private modes — `direct`, `approval`, `read-only` — over a wire shape
 * that carried a command for minting single-use codes. There is no second authority system now:
 * `mayApply` is `fleet.configure` as `decideCapability` decided it, `applyRefusal` is the SAME
 * `GrantRefusal` every other capability reports, and the only thing left that is specific to a change
 * is `confirmation` — the operator password proved once more against this exact diff.
 *
 * ## ONE PASSWORD, TYPED AT MOST ONCE
 *
 * `locked` and a confirmation can both be true at the same moment: a remote caller on a machine with a
 * password, which is locked AND owes a per-change confirmation. Two prompts for one click is the disease
 * this change exists to cure, so `locked` carries `alsoConfirms` and the panel spends ONE typed value on
 * both steps — mint the unlock with it, then send it as the confirmation on the apply.
 */
export type FleetApplyAuthority =
  /** Apply now, and nothing else is asked. The host's own token, or a local browser that has unlocked. */
  | { readonly kind: 'open' }
  /** Allowed, and applying proves the operator password once against this one change. */
  | { readonly kind: 'confirm' }
  /**
   * Refused until this browser unlocks, which it can do from here.
   *
   * `alsoConfirms` is the load-bearing field: true when the same secret must also be spent as this
   * change's confirmation, which is what lets one field serve both steps.
   */
  | { readonly kind: 'locked'; readonly alsoConfirms: boolean }
  /**
   * Refused for a reason an unlock would not fix — switched off, rate-limited, or an unreadable grant
   * document. Offering a password field here is the theatre a refusal that names no remedy amounts to.
   */
  | { readonly kind: 'refused'; readonly refusal: GrantRefusal }
  /**
   * This browser never learned what it may do here, because the permissions read itself failed.
   *
   * DELIBERATELY NOT `refused`. Rendering it as one would put a sentence about the operator's decisions
   * on screen on the strength of no answer at all — and `undetermined`, the closest refusal, says the
   * DAEMON could not read its grant document, which is a claim about the host this browser cannot make.
   */
  | { readonly kind: 'unreadable' };

export const fleetApplyAuthority = (permissions: FleetPermissions | null): FleetApplyAuthority => {
  if (permissions === null) return { kind: 'unreadable' };
  const alsoConfirms = permissions.confirmation === 'operator-password';
  if (!permissions.mayApply)
    return permissions.applyRefusal === 'locked'
      ? { kind: 'locked', alsoConfirms }
      : { kind: 'refused', refusal: permissions.applyRefusal };
  return alsoConfirms ? { kind: 'confirm' } : { kind: 'open' };
};

/** Whether the panel should render an operator-password field at all. */
export const fleetApplyNeedsPassword = (authority: FleetApplyAuthority): boolean =>
  authority.kind === 'confirm' || authority.kind === 'locked';

/** What the panel says about this authority, and how loudly. */
export interface FleetApplyCopy {
  /** Two or three words, for the header chip. */
  readonly badge: string;
  /** The shared badge's own tone vocabulary, so this chip is not a fifth chip design. */
  readonly tone: 'ok' | 'accent' | 'warn' | 'err';
  /** What is true and what to do about it. Empty for `open`, where there is nothing to say. */
  readonly explanation: string;
}

/**
 * The sentence and the chip, taken from the SHARED grant vocabulary wherever it has an answer.
 *
 * `grantGuidance` is the one browser-side rendering of every refusal (`src/lib/grants.ts`), so a fleet
 * refusal reads exactly as the same refusal reads on the grants surface beside it. Only two states need
 * words of their own: the per-change confirmation, which no capability but this one asks for, and a
 * permissions read that never landed.
 */
export const fleetApplyCopy = (authority: FleetApplyAuthority): FleetApplyCopy => {
  if (authority.kind === 'open') return { badge: grantGuidance('granted').badge, tone: 'ok', explanation: '' };
  if (authority.kind === 'confirm')
    return {
      badge: grantGuidance('locked').badge,
      tone: 'accent',
      explanation:
        'Applying this change asks for this machine’s operator password once. It is spent on this exact change and on nothing else — a password entered for one change does not carry over to the next.',
    };
  if (authority.kind === 'locked') {
    const guidance = grantGuidance('locked', 'fleet');
    return { badge: guidance.badge, tone: 'warn', explanation: guidance.explanation };
  }
  if (authority.kind === 'refused') {
    const guidance = grantGuidance(authority.refusal, 'fleet');
    return {
      badge: guidance.badge,
      tone: guidance.tone === 'fault' ? 'err' : 'warn',
      explanation: guidance.explanation,
    };
  }
  return {
    badge: 'Cannot tell',
    tone: 'err',
    explanation:
      'This daemon did not say what this browser may change here, so nothing is claimed either way. Applying may still be refused, and the refusal will say why.',
  };
};

// ─── the operation ledger ─────────────────────────────────────────────────────────────────────

const OPERATION_ACTIONS: Readonly<Record<FleetWriteOperation['kind'], string>> = {
  directory: 'create directory',
  file: 'write file',
  copy: 'copy asset',
  symlink: 'link',
  settings: 'merge settings',
  'codex-sqlite-ownership': 'take codex history ownership',
  prune: 'remove unclaimed wrappers',
  // Said as what it removes rather than as "prune", because this is the line a person reads before
  // approving the removal of a skill an account is no longer selecting.
  'prune-directory': 'remove unselected items',
};

/** One numbered line of the change manifest. */
export interface FleetLedgerEntry {
  /** 1-based, because the ledger is read aloud and referred to by number. */
  readonly index: number;
  readonly kind: FleetWriteOperation['kind'];
  readonly action: string;
  readonly path: string;
  readonly source?: string;
  /** Everything else the operation states, in the words a person checking it would use. */
  readonly details: readonly string[];
}

/**
 * What this operation does beyond touching a path.
 *
 * A mode is octal because that is how a person reads permissions. A settings merge says whether it
 * keeps what the harness wrote, because a re-apply that clobbered `/effort` would silently reset
 * somebody. A prune says how many names it spares and that it only removes files carrying Ferretry's
 * own marker, because "remove unclaimed wrappers" otherwise reads as "delete things in a bin directory".
 */
const octal = (value: number): string => `mode ${value.toString(8).padStart(4, '0')}`;

const operationDetails = (operation: FleetWriteOperation): readonly string[] => {
  switch (operation.kind) {
    case 'directory':
    case 'copy':
      return operation.mode === undefined ? [] : [octal(operation.mode)];
    case 'file':
      return [octal(operation.mode)];
    case 'symlink':
      return [];
    case 'settings':
      return [
        octal(operation.mode),
        `format ${operation.format}`,
        `${operation.layerCount} settings layer${operation.layerCount === 1 ? '' : 's'}`,
        operation.preserveExisting ? 'folds in the file already there' : 'replaces the file already there',
      ];
    case 'codex-sqlite-ownership':
      return [
        operation.enabled ? 'takes ownership of the sidecar' : 'gives the sidecar back',
        `marker ${operation.markerPath}`,
        `sqlite home ${operation.sqliteHome}`,
      ];
    default:
      return [
        'removes only files carrying Ferretry’s marker',
        operation.keep.length === 0 ? 'keeps nothing' : `keeps ${operation.keep.join(', ')}`,
      ];
  }
};

export const operationLedger = (operations: readonly FleetWriteOperation[]): readonly FleetLedgerEntry[] =>
  operations.map((operation, index) => ({
    index: index + 1,
    kind: operation.kind,
    action: OPERATION_ACTIONS[operation.kind],
    path: operation.path,
    ...('source' in operation ? { source: operation.source } : {}),
    details: operationDetails(operation),
  }));

// ─── live host versus proposed host ───────────────────────────────────────────────────────────

export type FleetRosterChange = 'unchanged' | 'added' | 'changed' | 'removed';

export interface FleetRosterRow {
  readonly id: string;
  readonly change: FleetRosterChange;
  /** The proposed account, or the live one when the proposal removes it. */
  readonly account: FleetManifestAccountView;
}

/**
 * The proposed roster beside the live one, so the difference is a property of the row rather than
 * something the reader has to hold in their head across two panels.
 */
/**
 * The account, as a value two schemas can be compared on.
 *
 * NOT `JSON.stringify` of the object: the live manifest and a proposal's derived manifest are parsed by
 * different schemas, and two schemas can emit the same fields in a different property order. Comparing
 * the serialisations would then mark every untouched row "changed", which is the one thing this panel
 * exists not to do.
 */
const sameModels = (before: FleetManifestAccountView['models'], after: FleetManifestAccountView['models']): boolean =>
  before.length === after.length &&
  before.every((model, index) => {
    const other = after[index];
    if (other === undefined) return false;
    // Read through one narrow shape rather than the union: an unavailable model carries a reason an
    // available one does not, and both belong in the comparison.
    const facts = (entry: typeof model): readonly [string, boolean, string | undefined, string | undefined] => {
      const detail = entry as { readonly displayName?: string; readonly unavailableReason?: string };
      return [entry.id, entry.available, detail.displayName, detail.unavailableReason];
    };
    return facts(model).every((fact, at) => fact === facts(other)[at]);
  });

const sameAccount = (before: FleetManifestAccountView, after: FleetManifestAccountView): boolean =>
  before.kind === after.kind &&
  before.mode === after.mode &&
  before.wrapper === after.wrapper &&
  before.home === after.home &&
  before.displayName === after.displayName &&
  before.defaultModel === after.defaultModel &&
  before.available === after.available &&
  before.unavailableReason === after.unavailableReason &&
  sameModels(before.models, after.models);

export const rosterDiff = (
  live: readonly FleetManifestAccountView[],
  proposed: readonly FleetManifestAccountView[],
): readonly FleetRosterRow[] => {
  const before = new Map(live.map(account => [account.id, account]));
  const rows: FleetRosterRow[] = proposed.map(account => {
    const previous = before.get(account.id);
    if (previous === undefined) return { id: account.id, change: 'added', account };
    return { id: account.id, change: sameAccount(previous, account) ? 'unchanged' : 'changed', account };
  });
  const kept = new Set(proposed.map(account => account.id));
  for (const account of live) {
    if (!kept.has(account.id)) rows.push({ id: account.id, change: 'removed', account });
  }
  return rows;
};

/**
 * Harness evidence from the published manifest, in the shape the existing default policy consumes.
 *
 * The policy itself — Claude when there is one, otherwise Codex — lives in `defaultFleetHarness` and
 * is NOT restated here. What this does is narrower and worth being exact about: it turns "this daemon
 * published these accounts" into "this harness has a wrapper on this host", which is positive evidence
 * of the fleet's contents rather than of a PATH lookup. A harness with no published account produces
 * no entry at all, so an unread manifest can never suggest a harness.
 */
export const harnessEvidence = (accounts: readonly FleetManifestAccountView[]): readonly FleetHarnessView[] => {
  const kinds: readonly FleetHarnessKind[] = ['claude', 'codex'];
  return kinds
    .filter(kind => accounts.some(account => account.kind === kind))
    .map(kind => {
      const mine = accounts.filter(account => account.kind === kind);
      return {
        kind,
        launchable: mine.filter(account => account.available).map(account => account.wrapper),
        blocked: mine
          .filter(account => account.unavailableReason !== null)
          .map(account => `${account.wrapper}: ${account.unavailableReason ?? ''}`),
      };
    });
};

// ─── what an apply did to the host ────────────────────────────────────────────────────────────

export interface FleetOutcomeSummary {
  readonly tone: 'ok' | 'warn' | 'err';
  readonly title: string;
  /** What the host IS now. The one sentence a person must be able to act on. */
  readonly hostState: string;
}

export const outcomeSummary = (outcome: FleetApplyOutcome): FleetOutcomeSummary => {
  switch (outcome.outcome) {
    case 'committed':
      return {
        tone: 'ok',
        title: 'Applied',
        hostState: `The host published ${outcome.result.accountCount} account(s) from ${outcome.result.operationCount} operation(s).`,
      };
    case 'committed-with-history-failure':
      return {
        tone: 'warn',
        title: 'Applied — shared history did not finish',
        hostState: `The fleet DID land: ${outcome.committed.accountCount} account(s) and the manifest at ${outcome.committed.manifestPath} are published. The ${outcome.failedHarness} history step failed afterwards and was not rolled back. Do not re-apply to fix the history step.`,
      };
    case 'initialized':
      // NOT "applied zero accounts": preparing a host publishes no manifest, and reporting it as an
      // apply of nothing would tell a person their fleet is empty rather than that it is now ready.
      return {
        tone: 'ok',
        title: 'Host prepared',
        hostState: `Created ${outcome.created.length} file(s) and kept ${outcome.kept.length} that already existed. NO fleet manifest has been published yet — declare the accounts you want and apply that change to publish one.`,
      };
    case 'initialization-partial':
      return {
        tone: 'warn',
        title: 'Host partly prepared',
        hostState: `Preparation stopped at ${outcome.failedPath}. ${outcome.created.length} file(s) were created and ${outcome.kept.length} existing one(s) were kept. Nothing was overwritten and nothing was undone, so running it again is safe: it only ever creates what is still absent.`,
      };
    case 'rolled-back':
      return {
        tone: 'warn',
        title: 'Not applied — host unchanged',
        hostState: `"${outcome.failedOperation}" failed and every captured entry was verified back to its prior state. The host still carries the configuration, assets and manifest it had before.`,
      };
    default:
      return {
        tone: 'err',
        title: 'Applied partially — host state unverified',
        hostState: `"${outcome.failedOperation}" failed and ${outcome.unrestored.length} path(s) could not be verified back to their prior state. Read the paths below before touching this host again.`,
      };
  }
};

// ─── drafts ───────────────────────────────────────────────────────────────────────────────────

/**
 * One environment variable in this account's own layer.
 *
 * `id` is a DOM identity, not fleet data: a row a person is still typing into has no name yet, and two
 * empty rows keyed by their contents would be the same row as far as React is concerned.
 */
export interface FleetEnvEntry {
  readonly id: string;
  readonly name: string;
  readonly value: string;
}

/** One text document written into the daemon's asset tree. An empty path means "not set". */
export interface FleetAssetDraft {
  readonly path: string;
  readonly text: string;
}

/** A skill document, carrying the same row identity an environment row needs. */
export interface FleetSkillDraft extends FleetAssetDraft {
  readonly id: string;
}

/**
 * This one account's overlay. It is applied after every shared slot, so two lanes of one agent can
 * carry different instructions, skills, settings and environment without either leaking onto the
 * other.
 */
export interface FleetLayerDraft {
  readonly instructions: FleetAssetDraft;
  /** `layer.skills` — a directory inside the asset tree the harness's skills are copied from. */
  readonly skillsDirectory: string;
  /** Documents written beneath that directory. */
  readonly skills: readonly FleetSkillDraft[];
  /** Inline settings, as the JSON a person typed. */
  readonly settingsText: string;
  readonly env: readonly FleetEnvEntry[];
  /**
   * Everything this layer declares that this editor cannot faithfully edit.
   *
   * Two kinds of thing land here: fields the surface does not offer at all (`flags`, `hooks`,
   * `hooksDir`, `mcp`, a `claude:`/`codex:` overlay), and one of the four it does offer whose declared
   * value is a shape it cannot represent — a `settings:` that is a FILE REFERENCE rather than an inline
   * object. An edit omits every key in here, and the daemon's patch semantics keep them: absent keeps,
   * `null` removes. Naming a key here is therefore how the surface promises not to touch it.
   */
  readonly preserved: Readonly<Record<string, unknown>>;
}

/** The four slots this editor owns, when their declared value is a shape it can show. */
const EDITABLE_LAYER_FIELDS: readonly string[] = ['memory', 'skills', 'settings', 'env'];

export const emptyLayerDraft = (): FleetLayerDraft => ({
  instructions: { path: '', text: '' },
  skillsDirectory: '',
  skills: [],
  settingsText: '',
  env: [],
  preserved: {},
});

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const asPath = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Can this editor show this declared value, and therefore speak for it?
 *
 * A `settings:` file reference, or a `memory:`/`skills:` that is a list rather than one path, is a
 * shape none of the boxes below can hold. Editing beside it must not send an opinion about it.
 */
const editableHere = (key: string, value: unknown): boolean => {
  if (!EDITABLE_LAYER_FIELDS.includes(key)) return false;
  if (key === 'settings' || key === 'env') return asRecord(value) !== undefined;
  return typeof value === 'string';
};

/**
 * Seed a draft from the layer this account already declares.
 *
 * A settings value that is a FILE REFERENCE rather than an inline object is deliberately not pulled
 * into the JSON box: editing it here would replace a reference the operator wrote with a literal, and
 * that is a change nobody asked for.
 */
export const layerDraftFrom = (layer: Readonly<Record<string, unknown>> | undefined): FleetLayerDraft => {
  if (layer === undefined) return emptyLayerDraft();
  const settings = asRecord(layer.settings);
  const env = asRecord(layer.env);
  return {
    instructions: { path: asPath(layer.memory), text: '' },
    skillsDirectory: asPath(layer.skills),
    skills: [],
    settingsText: settings === undefined ? '' : JSON.stringify(settings, null, 2),
    preserved: Object.fromEntries(Object.entries(layer).filter(([key, value]) => !editableHere(key, value))),
    env:
      env === undefined
        ? []
        : // A declared variable's name IS its identity, so a seeded row needs no minted one.
          Object.entries(env).map(([name, value]) => ({
            id: name,
            name,
            value: typeof value === 'string' ? value : String(value),
          })),
  };
};

/**
 * An asset this account's layer references that the browser does NOT hold the current text of.
 *
 * `scope` is what decides whether editing can clear it. A `file` entry is about ONE named document, so
 * a draft that stops naming that document stops being blocked by it. A `tree` entry is about contents
 * nobody enumerated — a walk the daemon stopped at a bound — and no edit in this browser can answer it,
 * so it blocks unconditionally.
 */
export interface FleetUnreadableAsset {
  readonly scope: 'file' | 'tree';
  readonly path: string;
  readonly reason: string;
}

export interface FleetLayerAssetSelection {
  /** Paths inside this layer whose text can be fetched and edited. */
  readonly readable: readonly string[];
  readonly unreadable: readonly FleetUnreadableAsset[];
}

/**
 * Every asset this one layer references: its instructions file, and every document under its skills
 * directory.
 *
 * The whole tree is enumerated rather than just the instructions file, because a layer that declares a
 * skills directory declares everything in it. An editor that showed one file and hid the other four
 * would let a person "edit the layer" and then send a proposal that silently left four documents out.
 *
 * A DECLARED INSTRUCTIONS PATH IS ALWAYS READ, listed or not. The index not mentioning it means one of
 * two things — the file is absent, or the walk did not reach it — and the editor cannot tell which from
 * here. Attempting the read is what tells it: the daemon either returns the text or refuses, and a
 * refusal becomes a blocker. Skipping the read instead would leave the empty box looking like the
 * file's real contents, and staging would then write nothing over a document nobody has seen.
 */
export const selectLayerAssets = (
  index: FleetAssetIndex,
  instructionsPath: string,
  skillsDirectory: string,
): FleetLayerAssetSelection => {
  const mine = index.files.filter(
    file =>
      (instructionsPath !== '' && file.path === instructionsPath) ||
      (skillsDirectory !== '' && file.path.startsWith(`${skillsDirectory}/`)),
  );
  const unreadable: FleetUnreadableAsset[] = mine
    .filter(file => !file.readable)
    .map(file => ({ scope: 'file' as const, path: file.path, reason: file.reason }));
  // A truncated walk is not a short tree. Whatever the bound cut off could be a skill document this
  // editor would then omit from the proposal, so an incomplete index blocks the change outright.
  if (!index.complete) {
    unreadable.push({
      scope: 'tree',
      path: skillsDirectory === '' ? 'fleet/assets' : skillsDirectory,
      reason: 'the daemon stopped walking the asset tree at a bound, so this list is not all of it',
    });
  }
  const readable = mine.filter(file => file.readable).map(file => file.path);
  const declaredButUnlisted = instructionsPath !== '' && !index.files.some(file => file.path === instructionsPath);
  return { readable: declaredButUnlisted ? [instructionsPath, ...readable] : readable, unreadable };
};

/**
 * The blockers that are still true OF THE DRAFT IN FRONT OF THE PERSON.
 *
 * The load-time list is evidence about what the daemon could read when the editor opened. It is not a
 * verdict on every later draft: clearing the instructions path, or deleting the skill row that named an
 * unreadable file, means staging no longer sends text for it — `editLayerPatch` sends `memory: null` and
 * `assetEdits` carries nothing — so there is nothing left to overwrite and nothing left to warn about.
 * Keeping the blocker anyway made the one repair a person could do from a browser impossible, and left a
 * sentence on screen that was no longer true of what they had typed.
 *
 * A `tree` entry survives every edit, because an unenumerated directory is not a file anybody can stop
 * naming: the skills directory is still declared and its contents are still unknown.
 */
export const currentUnreadable = (
  entries: readonly FleetUnreadableAsset[],
  layer: FleetLayerDraft,
): readonly FleetUnreadableAsset[] => {
  const named = new Set<string>([layer.instructions.path.trim(), ...layer.skills.map(skill => skill.path.trim())]);
  const skillsDirectory = layer.skillsDirectory.trim();
  // A file the editor could not load has no row to delete, so "still named" also covers a file sitting
  // under a skills directory the draft STILL declares: the directory hands over contents this browser
  // never saw, and the only way to stop naming it is to stop declaring the directory.
  const insideDeclaredSkills = (path: string): boolean =>
    skillsDirectory !== '' && path.startsWith(`${skillsDirectory}/`);
  const current = entries.filter(
    entry => entry.scope === 'tree' || named.has(entry.path) || insideDeclaredSkills(entry.path),
  );
  // One sentence per path. Load-time evidence and draft-time evidence can both reach the same file — a
  // document the index called unreadable that the draft also newly names — and the daemon's own refusal
  // is the more useful of the two reasons, so the earlier entry wins.
  const spoken = new Set<string>();
  const once: FleetUnreadableAsset[] = [];
  for (const entry of current) {
    if (spoken.has(entry.path)) continue;
    spoken.add(entry.path);
    once.push(entry);
  }
  return once;
};

/**
 * What this browser knows about the asset tree the draft is pointing into.
 *
 * `listed` is the daemon's answer to "what is already there"; `loaded` is the strictly smaller set this
 * editor holds the current text of. The gap between them is the whole point: a path in `listed` that is
 * not in `loaded` is a real document whose contents nobody here has seen.
 */
export interface FleetAssetKnowledge {
  /** Every path the daemon's index listed for this fleet, readable or not. */
  readonly listed: readonly string[];
  /** Paths whose current text this editor holds, and may therefore rewrite without erasing anything. */
  readonly loaded: readonly string[];
}

/**
 * Documents the draft NEWLY names that already exist and were never loaded.
 *
 * The load-time blockers answer "what could the daemon not give us"; they say nothing about a path typed
 * afterwards. Retargeting the instructions box from `a.md` to an existing `b.md` used to stage
 * `{path: "b.md", content: <a.md's text>}`, and a new skill row naming an existing document staged
 * `content: ""` for it — both writing over text this browser never saw, which is the one thing the
 * unreadable machinery exists to prevent. So the same `file`-scope entry is derived from the draft, and
 * it clears itself the moment the draft stops naming the path.
 *
 * A path the index does NOT list is left alone: naming a document that is not there yet is how a person
 * creates one, and there is nothing to overwrite. When the index is incomplete this set is therefore
 * partial — which is exactly why `selectLayerAssets` raises an unconditional `tree` blocker for a
 * truncated walk rather than trusting the listing.
 */
export const unseenAssets = (
  layer: FleetLayerDraft,
  knowledge: FleetAssetKnowledge,
): readonly FleetUnreadableAsset[] => {
  const listed = new Set(knowledge.listed);
  const loaded = new Set(knowledge.loaded);
  const named = [layer.instructions.path.trim(), ...layer.skills.map(skill => skill.path.trim())];
  return named
    .filter(path => path !== '' && listed.has(path) && !loaded.has(path))
    .map(path => ({
      scope: 'file' as const,
      path,
      reason: 'this editor has not loaded the document already at that path',
    }));
};

/**
 * Why an unreadable asset must stop a change rather than merely be mentioned.
 *
 * Staging an edit sends the text the editor holds for every path it names. If the browser could not
 * read one of those files, the text it holds is empty — so applying would replace a document nobody
 * has seen with nothing. Fail closed: say which file, say why, and refuse to stage until it reads.
 */
export const unreadableAssetProblems = (entries: readonly FleetUnreadableAsset[]): readonly string[] =>
  entries.map(
    entry =>
      `"${entry.path}" could not be read (${entry.reason}), so staging a change would overwrite text this browser never saw`,
  );

/** The layer the route with this id declares, if the configuration declares one at all. */
export const declaredLayer = (
  config: FleetConfigView | null,
  accountId: string,
): Readonly<Record<string, unknown>> | undefined => {
  for (const agent of config?.agents ?? []) {
    for (const route of Object.values(agent.routes)) {
      if (route.id === accountId) return route.layer;
    }
  }
  return undefined;
};

/**
 * A field whose value came from the daemon's detection rather than from the person.
 *
 * TRACKED PER FIELD, because "this form filled itself in" is only safe if the screen can say WHICH
 * parts it filled. A prefilled box nobody can distinguish from a typed one forces a person to re-check
 * every field, which is exactly the work the prefill was supposed to remove — and if one of them is
 * wrong, an indistinguishable prefill is worse than an empty box.
 */
export type FleetPrefilledField = 'models' | 'defaultModel' | 'instructionsPath' | 'instructionsText';

/**
 * Where each still-detected value came from, one checkable sentence per field.
 *
 * A key present means "this is still what detection put here"; a key absent means the person owns that
 * field now. So this is both the provenance the screen renders AND the record of what may be refilled
 * when the harness changes underneath it.
 */
export type FleetPrefillNotes = Readonly<Partial<Record<FleetPrefilledField, string>>>;

/** The two ways an account can run, and the only two the manifest publishes. */
export type FleetAccountMode = 'interactive' | 'auto';

/**
 * One account this draft will create: the composition slot it occupies, and the mode it publishes.
 *
 * The PAIR is the unit. `variant` and `mode` are not one field wearing two names — a variant is a
 * named slot the fleet declares, a mode is what consumers read to decide whether an account may be
 * driven unattended — and the stepper DERIVES the first from the second rather than asking for both.
 * Holding them together is what lets one pass create two accounts without a second list somebody has
 * to zip against this one.
 */
export interface FleetLaneDraft {
  readonly mode: FleetAccountMode;
  readonly variant: string;
}

/**
 * One provider account, and every lane this pass will create on it.
 *
 * `lanes` is a LIST because the mode question is multi-select: ticking both "interactive" and "auto"
 * creates two accounts — two wrappers, two homes — on the ONE provider login, in one reviewed change.
 * Everything else here is shared by all of them, which is the shape that makes a single sign-in reach
 * both. An EMPTY list is representable and is a blocker the identity step owns: a person who has
 * ticked nothing has not yet answered, and a draft that silently kept the last answer would be one
 * that creates an account nobody asked for.
 */
export interface FleetAccountDraft {
  readonly harness: FleetHarnessKind;
  readonly name: string;
  readonly lanes: readonly FleetLaneDraft[];
  readonly displayName: string;
  /** One model per line, or comma separated. Whichever the person typed. */
  readonly modelsText: string;
  readonly defaultModel: string;
  readonly layer: FleetLayerDraft;
  readonly prefilled: FleetPrefillNotes;
}

export const emptyAccountDraft = (harness: FleetHarnessKind): FleetAccountDraft => ({
  harness,
  name: '',
  lanes: [{ mode: 'auto', variant: 'default' }],
  displayName: '',
  modelsText: '',
  defaultModel: '',
  layer: emptyLayerDraft(),
  prefilled: {},
});

export const draftModels = (modelsText: string): readonly string[] =>
  modelsText
    .split(/[\n,]/u)
    .map(model => model.trim())
    .filter(model => model.length > 0);

/** The wrapper name the daemon will derive for ONE lane. Shown, never sent: identity stays server-derived. */
export const derivedWrapper = (draft: FleetAccountDraft, lane: FleetLaneDraft): string =>
  lane.variant === 'default' ? `${draft.harness}-${draft.name}` : `${draft.harness}-${lane.variant}-${draft.name}`;

/**
 * Every wrapper this one pass will create, in lane order.
 *
 * Named rather than counted, wherever it is shown. "2 accounts" tells a person nothing they can act
 * on; `claude-atelier` and `claude-auto-atelier` are what they will type and what `fy fleet ls` will
 * print, and seeing both before they leave the step is how ticking a second box stops being a
 * surprise at the end.
 */
export const derivedWrappers = (draft: FleetAccountDraft): readonly string[] =>
  draft.lanes.map(lane => derivedWrapper(draft, lane));

// ─── what the host detected, and what the person chose ─────────────────────────────────────────

/**
 * The directory a derived instructions document goes in.
 *
 * `instructions/` is where the fleet's own scaffold puts them and what the field's placeholder has
 * always shown, so a derived path lands beside whatever is already there rather than inventing a
 * second convention.
 */
const INSTRUCTIONS_DIRECTORY = 'instructions';

/**
 * The fixed part of an instructions document's name, per harness.
 *
 * The PREFIX is not a choice and the middle is. A person browsing the store should be able to see at
 * a glance which harness a document is for, and `CLAUDE-` / `AGENTS-` is what each harness already
 * calls its own file — so the prefix follows from the harness the account runs and is never offered.
 * What they name is the part after it: `CLAUDE-auto.md`, `AGENTS-review.md`.
 */
export const INSTRUCTIONS_PREFIX: Readonly<Record<FleetHarnessKind, string>> = {
  claude: 'CLAUDE-',
  codex: 'AGENTS-',
};

/** A store document's path from the part a person named. Empty middle names nothing, never a bare prefix. */
export const instructionsPathFor = (harness: FleetHarnessKind, middle: string): string =>
  middle.trim() === '' ? '' : `${INSTRUCTIONS_DIRECTORY}/${INSTRUCTIONS_PREFIX[harness]}${middle.trim()}.md`;

/**
 * The part a person named, recovered from a path this scheme produced, or `undefined` for anything
 * else.
 *
 * `undefined` rather than a best guess: a path that does not follow the scheme — one typed before
 * this scheme existed, or one pointing at a document somebody else named — is not a middle with a
 * prefix missing, and offering to edit "the name" of it would silently rewrite where it points.
 */
export const instructionsMiddleOf = (harness: FleetHarnessKind, path: string): string | undefined => {
  const head = `${INSTRUCTIONS_DIRECTORY}/${INSTRUCTIONS_PREFIX[harness]}`;
  if (!path.startsWith(head) || !path.endsWith('.md')) return undefined;
  const middle = path.slice(head.length, -'.md'.length);
  return middle === '' ? undefined : middle;
};

/**
 * The document a NEW account's instructions are written to, derived from the account being created.
 *
 * The middle is the FIRST lane's wrapper minus its harness prefix: `claude-auto-atelier` gives
 * `CLAUDE-auto-atelier.md`, so an account created only in the unattended lane derives a name that
 * says so, and one created in the ordinary lane derives the bare `CLAUDE-atelier.md`. The person
 * renames it to anything they like.
 *
 * **A DECLARED GAP when both modes are ticked.** This step composes ONE document, so both accounts
 * point at it, and the identity step says so out loud rather than leaving somebody to find out. The
 * default fleet gives each lane its own document for a real reason — "never stop and ask" is correct
 * advice in exactly one of the two lanes — so composing a second document per lane is worth having;
 * it is a redesign of this step rather than a derivation, and it is not pretended here.
 *
 * Empty while the account has no name, and while it has no lane. Deriving `instructions/CLAUDE-.md`
 * from a half-typed form would be a fabricated path — and worse, one that stops matching the account
 * the moment a name lands.
 */
export const derivedInstructionsPath = (draft: FleetAccountDraft): string => {
  const name = draft.name.trim();
  const first = draft.lanes[0];
  if (name === '' || first === undefined) return '';
  const wrapper = derivedWrapper({ ...draft, name }, first);
  return instructionsPathFor(draft.harness, wrapper.slice(`${draft.harness}-`.length));
};

/** One harness's discovery, or `undefined` when this report says nothing about that kind. */
export const discoveredHarness = (
  discovery: HarnessDiscoveryReport | null,
  kind: FleetHarnessKind,
): HarnessDiscovery | undefined => discovery?.harnesses.find(harness => harness.kind === kind);

/**
 * What this host has, in the shape the ONE default-harness rule already consumes.
 *
 * The rule itself — Claude when both, otherwise Codex — is `defaultFleetHarness` and is deliberately
 * not restated. What differs from `harnessEvidence` above is the EVIDENCE it reads: that one asks the
 * published manifest which wrappers exist, this one asks the host which harness commands exist. Both
 * are positive evidence, and they answer different questions — a machine with Claude Code installed and
 * no account published has the second and none of the first, which is precisely the person adding their
 * first account.
 */
export const harnessPathEvidence = (discovery: HarnessDiscoveryReport): readonly FleetHarnessView[] =>
  discovery.harnesses.map(harness => ({
    kind: harness.kind,
    launchable: harness.command === undefined ? [] : [harness.command],
    blocked: [],
  }));

/** What the host said about its harnesses, and what this form did about it. */
export interface FleetHarnessDetection {
  /** The harness to preselect, when there is positive evidence for one. Absent is never a guess. */
  readonly harness?: FleetHarnessKind;
  /** What was found, in one sentence, said out loud rather than silently applied. */
  readonly detail: string;
  /**
   * No harness command resolved at all.
   *
   * The state a person most needs to be told, and the one this form used to hide: it would happily
   * compose an account for a harness this host cannot launch, and nothing said so until a session
   * failed to start. It is a WARNING and not a refusal, because installing a harness minutes later is
   * ordinary and a form that blocked would be strictly worse than one that says what is missing.
   */
  readonly noneInstalled: boolean;
}

const HARNESS_LABEL: Readonly<Record<FleetHarnessKind, string>> = { claude: 'Claude', codex: 'Codex' };

export const harnessDetection = (discovery: HarnessDiscoveryReport | null): FleetHarnessDetection => {
  if (discovery === null)
    return {
      detail: 'This daemon did not say which harnesses this host has, so nothing here was preselected.',
      noneInstalled: false,
    };
  const installed = discovery.harnesses.filter(harness => harness.command !== undefined);
  if (installed.length === 0)
    return {
      detail:
        'Neither claude nor codex is on this host’s PATH. An account can still be declared here, but no session could start until the harness is installed on this machine.',
      noneInstalled: true,
    };
  const preselected = defaultFleetHarness(harnessPathEvidence(discovery));
  const found = installed.map(harness => `${harness.kind} at ${harness.command ?? ''}`).join(' and ');
  return {
    ...(preselected === undefined ? {} : { harness: preselected }),
    // Both are NAMED when both are present, rather than one being chosen quietly: the rule is
    // "prefer Claude", and a person who wanted the other one has to be able to see the choice was made.
    detail:
      installed.length === 1
        ? `Detected ${found}.`
        : `Detected ${found}. ${HARNESS_LABEL[preselected ?? 'claude']} is preselected; switch if you meant the other.`,
    noneInstalled: false,
  };
};

/** The one sentence a model box carries about where its contents came from. */
const modelNote = (models: HarnessDiscovery['models']): string =>
  models.origin === 'detected'
    ? `Detected — read from ${models.source}.`
    : `Not detected — ${models.source}. Check it before applying.`;

const instructionsTextNote = (source: string, bytes: number): string =>
  `Imported — ${source} (${String(bytes)} bytes). Edit it here; nothing is written until you review and authorize the change.`;

/**
 * The note under the derived document name — and it says WHAT it was derived from, in plain words.
 *
 * It used to read "from the account and **lane** above", which is a prefill note rather than a
 * comment: it is assigned to `instructionsPath` and rendered by `PrefillNote` on the instructions
 * step. So a person met the word this whole pass exists to remove, on a screen, four steps after the
 * two cards that replaced it — and no test caught it, because the drafts those tests mount carry no
 * prefill notes at all. {@link derivedInstructionsPath} builds the name from the wrapper, and the
 * wrapper is the account name plus how it runs, so those are the two facts said as such.
 *
 * "above" is dropped as well, and separately: the wrapper preview is on the identity step, so nothing
 * it referred to is on the screen this sentence appears on.
 *
 * EXPORTED so the design harness renders THIS sentence rather than one of its own. The harness fixture
 * had invented "Derived — from the wrapper name above", which is why a 390px capture of that step
 * looked clean while production said "lane" — the same class of lie as the fixture's instructions path,
 * and the reason a screenshot of a fixture is only evidence about the fixture.
 */
export const DERIVED_PATH_NOTE =
  'Derived — from the account name and how it runs. Rename it, or point at a document already in the store.';

/**
 * Does the person own this field now?
 *
 * Two conditions, and both matter. No provenance means they have typed over whatever was there; a
 * non-empty value means there is something of theirs to protect. A field they deliberately EMPTIED is
 * not owned — which is what makes clearing the path box a way to get the derived default back, rather
 * than a state the form can never leave.
 *
 * THE HARNESS IS NOT ONE OF THESE FIELDS. Ownership decides what a refill may overwrite, and the harness
 * is what TRIGGERS a refill — asking whether it may be overwritten is a question with no meaning.
 */
const personOwns = (draft: FleetAccountDraft, field: FleetPrefilledField): boolean => {
  if (draft.prefilled[field] !== undefined) return false;
  switch (field) {
    case 'models':
      return draft.modelsText.trim() !== '';
    case 'defaultModel':
      return draft.defaultModel.trim() !== '';
    case 'instructionsPath':
      return draft.layer.instructions.path.trim() !== '';
    default:
      return draft.layer.instructions.text !== '';
  }
};

const without = (notes: FleetPrefillNotes, field: FleetPrefilledField): FleetPrefillNotes => {
  const next = { ...notes };
  delete next[field];
  return next;
};

/**
 * Fill the fields the CHOSEN harness can speak for, leaving anything the person owns alone.
 *
 * Called when the harness changes, not on every keystroke. A refill that fought a person's typing would
 * be the worst of both worlds, and the harness is the one field whose change genuinely invalidates the
 * others: the model Codex reports is not a model a Claude account can serve.
 */
const withHarnessDetection = (
  draft: FleetAccountDraft,
  discovery: HarnessDiscoveryReport | null,
  refill: ReadonlySet<FleetPrefilledField>,
): FleetAccountDraft => {
  const found = discoveredHarness(discovery, draft.harness);
  if (found === undefined) return draft;
  let next = draft;
  if (refill.has('models')) {
    next = {
      ...next,
      modelsText: found.models.ids.join('\n'),
      prefilled: { ...next.prefilled, models: modelNote(found.models) },
    };
  }
  if (refill.has('defaultModel')) {
    next = {
      ...next,
      defaultModel: found.models.defaultModel,
      prefilled: { ...next.prefilled, defaultModel: modelNote(found.models) },
    };
  }
  if (refill.has('instructionsText')) {
    const instructions = found.instructions;
    next = {
      ...next,
      layer: {
        ...next.layer,
        instructions: { ...next.layer.instructions, text: instructions.found ? instructions.text : '' },
      },
      // A harness with no document to import leaves an empty box AND no claim about it. Keeping the
      // previous harness's "imported from" beside empty text would be a false statement.
      prefilled: instructions.found
        ? { ...next.prefilled, instructionsText: instructionsTextNote(instructions.source, instructions.bytes) }
        : without(next.prefilled, 'instructionsText'),
    };
  }
  return next;
};

/** Keep the derived document name in step with the account, until the person names their own. */
const withDerivedInstructionsPath = (draft: FleetAccountDraft): FleetAccountDraft => {
  if (personOwns(draft, 'instructionsPath')) return draft;
  const path = derivedInstructionsPath(draft);
  return {
    ...draft,
    layer: { ...draft.layer, instructions: { ...draft.layer.instructions, path } },
    // No path yet means no claim yet. A note beside an empty box would name a derivation that has not
    // happened, because the account has no name to derive from.
    prefilled:
      path === ''
        ? without(draft.prefilled, 'instructionsPath')
        : { ...draft.prefilled, instructionsPath: DERIVED_PATH_NOTE },
  };
};

/**
 * Which harness to preselect, from the host when the host answered and from the published fleet when
 * it did not.
 *
 * TWO GRADES OF EVIDENCE, and the weaker one is labelled as weaker. "This host has `claude` on its
 * PATH" is what a new account actually needs; "this fleet already publishes a Claude account" is a
 * second-hand inference that happens to be usually right, so it is used only when the first is
 * unavailable and the sentence says which one is talking.
 *
 * A host that answered and has NOTHING installed does not fall through to the manifest. That would
 * quietly restore a suggestion in the exact case the person most needs to be told nothing is there.
 */
export const accountHarnessDetection = (
  discovery: HarnessDiscoveryReport | null,
  published: readonly FleetManifestAccountView[],
): FleetHarnessDetection => {
  const host = harnessDetection(discovery);
  if (discovery !== null) return host;
  const fromManifest = defaultFleetHarness(harnessEvidence(published));
  return fromManifest === undefined
    ? host
    : {
        harness: fromManifest,
        detail: `${host.detail} ${HARNESS_LABEL[fromManifest]} is preselected because this fleet already publishes an account for it — which is not evidence that this host can launch it.`,
        noneInstalled: false,
      };
};

/**
 * The draft a form opens with: everything this host could answer, already answered.
 *
 * A daemon that said nothing about its harnesses produces the empty draft it always did — a form with
 * no detection is the old form, not a form full of guesses.
 */
export const detectedAccountDraft = (
  detection: FleetHarnessDetection,
  discovery: HarnessDiscoveryReport | null,
): FleetAccountDraft => {
  // No note for the harness itself: the detection sentence is rendered once, above the whole form, and
  // the selected chip carries the marker. A third statement of the same fact is noise.
  const opened = emptyAccountDraft(detection.harness ?? 'claude');
  return withDerivedInstructionsPath(
    withHarnessDetection(opened, discovery, new Set(['models', 'defaultModel', 'instructionsText'])),
  );
};

/**
 * The draft after a person touched it.
 *
 * Three things happen here and nowhere else, because a screen is where they get quietly dropped:
 * a field they edited stops claiming to be detected, a harness change refills what the OLD harness was
 * speaking for, and the derived document name keeps up with the account until they name their own.
 */
export const reconcileAccountDraft = (
  previous: FleetAccountDraft,
  next: FleetAccountDraft,
  discovery: HarnessDiscoveryReport | null,
): FleetAccountDraft => {
  let prefilled = next.prefilled;
  if (next.modelsText !== previous.modelsText) prefilled = without(prefilled, 'models');
  if (next.defaultModel !== previous.defaultModel) prefilled = without(prefilled, 'defaultModel');
  if (next.layer.instructions.path !== previous.layer.instructions.path)
    prefilled = without(prefilled, 'instructionsPath');
  if (next.layer.instructions.text !== previous.layer.instructions.text)
    prefilled = without(prefilled, 'instructionsText');
  const claimed: FleetAccountDraft = { ...next, prefilled };
  // Ownership is read from what they had BEFORE this edit: switching harness must not be taken as
  // consent to overwrite the model list they typed a moment ago.
  const refill = new Set<FleetPrefilledField>(
    next.harness === previous.harness
      ? []
      : (['models', 'defaultModel', 'instructionsText'] as const).filter(field => !personOwns(previous, field)),
  );
  return withDerivedInstructionsPath(withHarnessDetection(claimed, discovery, refill));
};

// ─── more than one instructions document ────────────────────────────────────────────────────────

/**
 * Skills directories the configuration declares.
 *
 * Read so an instructions picker never offers a skill document. The alternative was a naming
 * convention, which would be this browser guessing at what a path means; the configuration already
 * states which directories hold skills, so it is asked instead.
 */
const declaredSkillsDirectories = (config: FleetConfigView | null): readonly string[] => {
  const directories: string[] = [];
  for (const agent of config?.agents ?? []) {
    for (const route of Object.values(agent.routes)) {
      const skills = route.layer?.skills;
      if (typeof skills === 'string' && skills.trim() !== '') directories.push(skills.trim());
    }
  }
  return directories;
};

/**
 * Documents already in this fleet's asset tree that an account could use as its instructions.
 *
 * THE POINT OF THE FLEET HAVING MORE THAN ONE. A path per account meant every account got its own
 * document whether or not it wanted one, and two accounts that should read the same house rules had to
 * keep two copies in step by hand. These are the documents that exist; an account chooses one.
 */
export const instructionsAssets = (listed: readonly string[], config: FleetConfigView | null): readonly string[] => {
  const skills = declaredSkillsDirectories(config);
  return [...new Set(listed.filter(path => !skills.some(directory => path.startsWith(`${directory}/`))))].sort();
};

/** A new document at the derived path, seeded from this host's own instructions file. */
export const IMPORTED_INSTRUCTIONS_CHOICE = 'new-imported';
/** A new, empty document at the derived path. */
export const BLANK_INSTRUCTIONS_CHOICE = 'new-blank';
const EXISTING_INSTRUCTIONS_PREFIX = 'asset:';

/** One option in the instructions picker. `value` is opaque: two options may write the same path. */
export interface FleetInstructionsChoice {
  readonly value: string;
  readonly label: string;
  /** What choosing this one means, shown for the SELECTED option rather than crowding the list. */
  readonly detail: string;
}

const derivedLabel = (draft: FleetAccountDraft): string => {
  const path = derivedInstructionsPath(draft);
  return path === '' ? 'a new document for this account' : path;
};

export const instructionsChoices = (
  draft: FleetAccountDraft,
  discovery: HarnessDiscoveryReport | null,
  assets: readonly string[],
): readonly FleetInstructionsChoice[] => {
  const found = discoveredHarness(discovery, draft.harness);
  const importable = found?.instructions.found === true ? found.instructions : undefined;
  return [
    ...(importable === undefined
      ? []
      : [
          {
            value: IMPORTED_INSTRUCTIONS_CHOICE,
            label: `New — ${derivedLabel(draft)}, imported`,
            detail: instructionsTextNote(importable.source, importable.bytes),
          },
        ]),
    {
      value: BLANK_INSTRUCTIONS_CHOICE,
      label: `New — ${derivedLabel(draft)}, empty`,
      detail:
        found === undefined || found.instructions.found
          ? 'A new, empty document written at that path.'
          : `A new, empty document: ${found.instructions.reason} (looked at ${found.instructions.source}).`,
    },
    ...assets.map(path => ({
      value: `${EXISTING_INSTRUCTIONS_PREFIX}${path}`,
      label: path,
      detail:
        'Already in this fleet’s asset tree. This account will read it, and an edit here rewrites the one document every account using it reads.',
    })),
  ];
};

/** Which option the draft currently corresponds to, so the control shows the truth. */
export const instructionsChoiceValue = (draft: FleetAccountDraft, assets: readonly string[]): string => {
  const path = draft.layer.instructions.path.trim();
  if (path !== '' && assets.includes(path)) return `${EXISTING_INSTRUCTIONS_PREFIX}${path}`;
  return draft.prefilled.instructionsText === undefined ? BLANK_INSTRUCTIONS_CHOICE : IMPORTED_INSTRUCTIONS_CHOICE;
};

/**
 * The draft after choosing a document, and the path whose text must still be fetched.
 *
 * `load` is returned rather than performed: this module holds no client. An existing document arrives
 * with EMPTY text on purpose — until the fetch lands, `unseenAssets` blocks staging, so a person cannot
 * apply a change that would overwrite a document this browser has never seen.
 */
export const applyInstructionsChoice = (
  draft: FleetAccountDraft,
  value: string,
  discovery: HarnessDiscoveryReport | null,
): { readonly draft: FleetAccountDraft; readonly load?: string } => {
  if (value.startsWith(EXISTING_INSTRUCTIONS_PREFIX)) {
    const path = value.slice(EXISTING_INSTRUCTIONS_PREFIX.length);
    return {
      // Neither field claims to be detected any more: the person chose this document, and the derived
      // name must stop overwriting the one they picked.
      draft: {
        ...draft,
        prefilled: without(without(draft.prefilled, 'instructionsPath'), 'instructionsText'),
        layer: { ...draft.layer, instructions: { path, text: '' } },
      },
      load: path,
    };
  }
  const instructions = discoveredHarness(discovery, draft.harness)?.instructions;
  const importing = value === IMPORTED_INSTRUCTIONS_CHOICE && instructions?.found === true;
  // Both new-document options write the account's OWN document, so the path returns to the derived one
  // even when the person had picked a shared asset a moment ago. Set rather than left to the helper:
  // a path they had chosen counts as theirs, and the helper would correctly refuse to touch it.
  const path = derivedInstructionsPath(draft);
  return {
    draft: {
      ...draft,
      layer: { ...draft.layer, instructions: { path, text: importing && instructions.found ? instructions.text : '' } },
      prefilled: {
        ...without(without(draft.prefilled, 'instructionsPath'), 'instructionsText'),
        ...(path === '' ? {} : { instructionsPath: DERIVED_PATH_NOTE }),
        ...(importing && instructions.found
          ? { instructionsText: instructionsTextNote(instructions.source, instructions.bytes) }
          : {}),
      },
    },
  };
};

// ─── validation, against the SHARED asset grammar ─────────────────────────────────────────────

/**
 * A POSIX environment variable name. Not an asset reference and not the same rule, so it stays here.
 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Unicode's control category, for the ACCOUNT NAME — which is `SafeNameSchema`, a different rule from
 * the asset grammar. That schema refuses code points below `0x20` and nothing else, so this mirrors it
 * rather than the asset check, which refuses format controls too.
 */
const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * Why a path cannot name a fleet asset, labelled for the field it was typed into, or `null` when it can.
 *
 * The grammar itself is `fleetAssetRefProblem` in the shared protocol — the one description of what a
 * remote caller may name, used by the wire schema and by the daemon. This used to be a hand-maintained
 * copy of it, and a copy is how one side quietly becomes the laxer one: the copy permitted `~`,
 * `$HOME` and Unicode format controls, so the browser said "fine" and the daemon refused on submit.
 *
 * What is left here is the only part that IS a browser concern: which box the reason belongs to. The
 * shared helper returns a bare predicate ("must be relative to the asset directory") precisely so each
 * boundary can phrase its own refusal, and beside a form field the field's name is what makes the
 * sentence actionable.
 */
export const assetPathProblem = (path: string, label: string): string | null => {
  const problem = fleetAssetRefProblem(path);
  return problem === undefined ? null : `${label} ${problem}`;
};

const settingsProblem = (settingsText: string): string | null => {
  if (settingsText.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsText);
  } catch {
    return 'settings must be valid JSON';
  }
  return asRecord(parsed) === undefined ? 'settings must be a JSON object' : null;
};

export interface FleetLayerProblemOptions {
  /**
   * The instructions path is DERIVED from an account name that does not exist yet.
   *
   * Without this, a form that opens with an imported document and no account name shows two problems —
   * "name the provider account" and "name the file the instructions are written to" — and only the first
   * is the person's to fix. The second is a consequence of it, and it points at a box whose contents they
   * are not supposed to be typing. One cause, one sentence.
   */
  readonly instructionsPathPending?: boolean;
}

export const layerProblems = (layer: FleetLayerDraft, options: FleetLayerProblemOptions = {}): readonly string[] => {
  const problems: string[] = [];
  const instructionsPath = layer.instructions.path.trim();
  if (instructionsPath === '') {
    if (layer.instructions.text !== '' && options.instructionsPathPending !== true)
      problems.push('name the file the instructions are written to');
  } else {
    const problem = assetPathProblem(instructionsPath, 'the instructions path');
    if (problem !== null) problems.push(problem);
  }

  const skillsDirectory = layer.skillsDirectory.trim();
  if (skillsDirectory === '') {
    if (layer.skills.length > 0) problems.push('name the skills directory these documents belong to');
  } else {
    const problem = assetPathProblem(skillsDirectory, 'the skills directory');
    if (problem !== null) problems.push(problem);
  }

  for (const skill of layer.skills) {
    const path = skill.path.trim();
    if (path === '') {
      problems.push('every skill document needs a path');
      continue;
    }
    const problem = assetPathProblem(path, `the skill path "${path}"`);
    if (problem !== null) problems.push(problem);
    if (skillsDirectory !== '' && !path.startsWith(`${skillsDirectory}/`)) {
      problems.push(`"${path}" is not inside the skills directory "${skillsDirectory}"`);
    }
  }

  // One path, one text. `assetEdits` writes every named path in order, so two rows carrying the same path
  // — or a skill row that names the instructions file — used to resolve by last-write-wins: a person
  // reviewing the plan saw both texts and had no way to tell which one would survive. Refuse instead.
  const written = new Set<string>();
  const twice = new Set<string>();
  for (const path of [instructionsPath, ...layer.skills.map(skill => skill.path.trim())]) {
    if (path === '') continue;
    if (written.has(path)) twice.add(path);
    written.add(path);
  }
  for (const path of twice) problems.push(`"${path}" is written twice by this change; one path carries one text`);

  const settings = settingsProblem(layer.settingsText);
  if (settings !== null) problems.push(settings);

  const names = new Set<string>();
  for (const entry of layer.env) {
    const name = entry.name.trim();
    if (name === '') {
      problems.push('every environment variable needs a name');
      continue;
    }
    if (!ENV_NAME.test(name)) problems.push(`"${name}" is not a usable environment variable name`);
    if (names.has(name)) problems.push(`"${name}" is set more than once`);
    names.add(name);
  }
  return problems;
};

/**
 * The provider accounts this fleet already declares for one harness, and what each already carries.
 *
 * THE JOIN KEY IS THE DAEMON'S, not this browser's. `create-account` looks for an agent with the same
 * `name` AND the same harness and merges the new routes into it — otherwise it appends a new agent
 * (`packages/daemon/src/lib/fleet/mutations.ts`). So one provider login serving several accounts is not
 * a feature to build; it is a feature the browser never offered, and the answer is a PICK from this list.
 *
 * Read from the declared CONFIGURATION rather than from the published manifest, because the manifest
 * publishes wrappers and modes and never the login name the merge is keyed on. A fleet whose
 * configuration could not be read produces an empty list, which is a picker with nothing to offer
 * rather than a claim that this host has no accounts.
 */
export interface FleetExistingAccount {
  /** The provider login's name, exactly as the daemon would match it. */
  readonly name: string;
  /** What this login already carries: the slot each account occupies, and the wrapper it publishes. */
  readonly taken: readonly { readonly variant: string; readonly wrapper: string }[];
}

export const existingAccounts = (
  harness: FleetHarnessKind,
  config: FleetConfigView | null,
): readonly FleetExistingAccount[] =>
  (config?.agents ?? [])
    .filter(agent => agent.kind === harness)
    .map(agent => ({
      name: agent.name,
      taken: Object.entries(agent.routes).map(([variant, route]) => ({ variant, wrapper: route.wrapper })),
    }));

/**
 * What is wrong with the NAME this account is known by, in ONE place because two steps ask.
 *
 * The whole-draft check below and the identity step that owns these sentences in the stepper's
 * partition used to carry a copy of this chain each. A copy is how one of them quietly becomes the
 * laxer one, and the way it shows up is that the recap refuses a change for a reason no step would say.
 *
 * THE EMPTY SENTENCE ASKS FOR A CHOICE, not for typing. The step offers the accounts this fleet already
 * has before it offers a box, so "name the provider account" would have been a blocker pointing at a
 * control that is not on screen until somebody asks for it.
 */
export const accountNameProblems = (draft: FleetAccountDraft): readonly string[] => {
  const name = draft.name.trim();
  if (name === '') return ['pick the account this signs in as, or add a new one'];
  if (name !== draft.name) return ['the account name must not start or end with whitespace'];
  if (name.length > 64) return ['the account name must be 64 characters or shorter'];
  if (/[/\\]/u.test(name) || name.includes('..') || CONTROL_CHARACTER.test(name)) {
    return ['the account name must not contain a path separator, "..", or control characters'];
  }
  return [];
};

/**
 * What is wrong with the SET of accounts this draft would create, or nothing.
 *
 * Exported and single-sourced because two places ask: the whole-draft check below, and the identity
 * step that owns these sentences in the stepper's partition. Restating them there would be two
 * descriptions of one grammar, and the way two descriptions drift is that the recap refuses a change
 * for a reason no step would show — which is the exact failure the partition exists to prevent.
 *
 * The DUPLICATE rule is not a variation of the unknown-lane one. Two lanes derive their variants
 * independently, so a fleet declaring only `default` sends both modes to the same slot: two accounts
 * asked for, one wrapper name available. Nothing about either lane is invalid on its own, and the
 * daemon would refuse the pair — so the sentence has to arrive here, before somebody walks six steps
 * to be told.
 *
 * ## THE COLLISION WITH WHAT THIS FLEET ALREADY HAS, and why it is the same rule
 *
 * It takes the whole DRAFT rather than its lanes, because the third refusal needs the name and the
 * harness too. The daemon refuses `account "X" already has a "auto" lane on this fleet`
 * (`mutations.ts`), and nothing in this browser used to check it: somebody could pick a login they
 * already had, tick a way of running it already had, walk all seven steps, and be refused at proposal
 * time for something knowable at step two. So it is checked HERE, against the same declared routes the
 * daemon reads, and the sentence names the wrapper that already exists rather than the slot it occupies.
 *
 * THE SENTENCES SAY "group", NOT "lane". A variant is a named composition slot and `lane` is what
 * this codebase calls one; a person reading a blocker on the identity step has never met either
 * word, and a sentence that refuses a change in vocabulary the screen never taught cannot be acted
 * on. The type names stay — only what a person reads changes.
 */
export const laneProblems = (draft: FleetAccountDraft, config: FleetConfigView | null): readonly string[] => {
  const lanes = draft.lanes;
  if (lanes.length === 0) return ['pick at least one way this account runs; each one creates its own account'];
  const held = existingAccounts(draft.harness, config).find(account => account.name === draft.name.trim());
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const lane of lanes) {
    const variant = lane.variant.trim();
    if (variant === '') {
      problems.push('name the group this account joins');
      continue;
    }
    if (config !== null && config.variants[variant] === undefined) {
      problems.push(`this fleet declares no "${variant}" group; declare it on the host before adding an account to it`);
    }
    if (seen.has(variant)) {
      problems.push(
        `"${variant}" is the group for two of these accounts; one group holds one account, so they must differ`,
      );
    }
    seen.add(variant);
    const taken = held?.taken.find(entry => entry.variant === variant);
    if (taken !== undefined) {
      problems.push(
        `the ${lane.mode} account on "${held?.name ?? ''}" already exists as "${taken.wrapper}" — untick it, or pick a different account`,
      );
    }
  }
  return problems;
};

export const accountProblems = (draft: FleetAccountDraft, config: FleetConfigView | null): readonly string[] => {
  const name = draft.name.trim();
  const problems: string[] = [...accountNameProblems(draft), ...laneProblems(draft, config)];

  const models = draftModels(draft.modelsText);
  const defaultModel = draft.defaultModel.trim();
  if (models.length === 0) problems.push('an available account must list at least one model it can serve');
  else if (defaultModel === '') problems.push('name the default model this account serves');
  else if (!models.includes(defaultModel)) {
    problems.push(`the default model "${defaultModel}" is not one of the models listed`);
  }

  // The instructions path is derived from the account name, so an account with no name yet has no path
  // to complain about: that absence is the missing NAME, which is already the first sentence above.
  return [...problems, ...layerProblems(draft.layer, { instructionsPathPending: name === '' })];
};

// ─── drafts to a proposal request ─────────────────────────────────────────────────────────────

const layerEnv = (layer: FleetLayerDraft): Record<string, string> =>
  Object.fromEntries(layer.env.map(entry => [entry.name.trim(), entry.value]));

/**
 * A NEW account's layer: blank means "not declared", so a blank field is simply absent.
 *
 * There is nothing to preserve on an account that does not exist yet, which is why this is not the
 * same function as the edit patch below.
 */
const createLayer = (layer: FleetLayerDraft): Readonly<Record<string, unknown>> | undefined => {
  const value: Record<string, unknown> = {};
  const instructions = layer.instructions.path.trim();
  if (instructions !== '') value.memory = instructions;
  const skills = layer.skillsDirectory.trim();
  if (skills !== '') value.skills = skills;
  const settings = layer.settingsText.trim();
  if (settings !== '') value.settings = JSON.parse(settings) as Record<string, unknown>;
  const env = layerEnv(layer);
  if (Object.keys(env).length > 0) value.env = env;
  return Object.keys(value).length === 0 ? undefined : value;
};

/**
 * An EXISTING account's layer, as a field-level patch: absent keeps, `null` removes.
 *
 * Blank cannot mean absent here. A person who emptied the instructions box asked for the instructions
 * to be REMOVED, and omitting the key would silently keep the old value — so every concern this editor
 * displayed is stated explicitly, as a value or as `null`. Everything it could not display is omitted,
 * which is how `flags`, `hooks`, `mcp`, the per-harness overlays and a `settings:` file reference all
 * survive an edit to the box beside them.
 */
const editLayerPatch = (layer: FleetLayerDraft): Readonly<Record<string, unknown>> => {
  const patch: Record<string, unknown> = {};
  const state = (key: string, value: unknown): void => {
    if (key in layer.preserved) return;
    patch[key] = value;
  };
  const instructions = layer.instructions.path.trim();
  state('memory', instructions === '' ? null : instructions);
  const skills = layer.skillsDirectory.trim();
  state('skills', skills === '' ? null : skills);
  const settings = layer.settingsText.trim();
  state('settings', settings === '' ? null : (JSON.parse(settings) as Record<string, unknown>));
  const env = layerEnv(layer);
  state('env', Object.keys(env).length === 0 ? null : env);
  return patch;
};

/**
 * The asset text this change carries.
 *
 * An instructions path with no text is still sent, because an empty instructions file that exists is
 * a different host state from a declared file that does not — and the second one is what makes an
 * apply reference something that is not there.
 */
const assetEdits = (layer: FleetLayerDraft): { path: string; content: string }[] => {
  const edits = [];
  const instructions = layer.instructions.path.trim();
  if (instructions !== '') edits.push({ path: instructions, content: layer.instructions.text });
  for (const skill of layer.skills) edits.push({ path: skill.path.trim(), content: skill.text });
  return edits;
};

/**
 * ONE proposal, however many lanes were ticked.
 *
 * Two requests would mean two previews, two reviews and — for a caller this host's grants govern —
 * two operator-password confirmations for one decision a person made once. So the set of lanes
 * travels inside the single named intent, the daemon derives one configuration from it, and the
 * reviewer approves one plan that names both accounts.
 */
export const createAccountProposal = (draft: FleetAccountDraft): FleetProposalRequest => {
  const layer = createLayer(draft.layer);
  const displayName = draft.displayName.trim();
  return {
    mutation: {
      kind: 'create-account',
      harness: draft.harness,
      name: draft.name.trim(),
      lanes: draft.lanes.map(lane => ({ variant: lane.variant.trim(), mode: lane.mode })),
      models: draftModels(draft.modelsText),
      defaultModel: draft.defaultModel.trim(),
      ...(displayName === '' ? {} : { displayName }),
      ...(layer === undefined ? {} : { layer }),
    },
    assetEdits: assetEdits(draft.layer),
  };
};

/**
 * An edit sends a PATCH, never a replacement, and never `layer: null`.
 *
 * Clearing every box a person can see is a request to remove those four things — not a request to
 * delete the account's `flags` and its `claude:` overlay along with them, which is what removing the
 * whole layer would do.
 */
export const editAccountProposal = (accountId: string, layer: FleetLayerDraft): FleetProposalRequest => ({
  mutation: { kind: 'edit-account', accountId, layer: editLayerPatch(layer) },
  assetEdits: assetEdits(layer),
});

export const initializeProposal = (): FleetProposalRequest => ({ mutation: { kind: 'initialize' } });

/**
 * What the surface discloses about the limits of what it just did.
 *
 * These are real, declared gaps rather than caveats-in-general: the daemon rewrites the configuration
 * document, and the settings merge is a merge. Someone who is not told will find out by losing a
 * comment they wrote.
 */
export const CHANGE_LIMITS: readonly string[] = [
  'Applying rewrites fleet config.yaml from the parsed document: YAML comments, anchors and key order in that file are not preserved.',
  'Inline settings are MERGED over what the harness already wrote. A key cannot be deleted from here.',
  'Only text assets can be edited here. Executable hooks, per-skill selection and home pruning are not offered.',
];
