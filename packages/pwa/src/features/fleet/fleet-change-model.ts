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

import { fleetAssetRefProblem } from '@ferretry/protocol';
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
import type { GrantRefusalNotice } from '../../lib/grants.ts';
import type { FleetHarnessKind, FleetHarnessView } from './fleet-model.ts';

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

/** How this credential may change the host, before it tries. A 403 race is still handled where it lands. */
export type FleetAuthorityMode = 'direct' | 'approval' | 'read-only';

export const fleetAuthority = (permissions: FleetPermissions | null): FleetAuthorityMode => {
  if (permissions === null) return 'read-only';
  if (permissions.mayApplyDirectly) return 'direct';
  return permissions.mayApplyWithApproval ? 'approval' : 'read-only';
};

/** The exact command a person runs on the host to mint an approval for one exact proposal. */
export const approvalCommand = (permissions: FleetPermissions, proposalId: string): string =>
  `${permissions.approvalCommand} ${proposalId}`;

// ─── the operation ledger ─────────────────────────────────────────────────────────────────────

const OPERATION_ACTIONS: Readonly<Record<FleetWriteOperation['kind'], string>> = {
  directory: 'create directory',
  file: 'write file',
  copy: 'copy asset',
  symlink: 'link',
  settings: 'merge settings',
  'codex-sqlite-ownership': 'take codex history ownership',
  prune: 'remove unclaimed wrappers',
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

export interface FleetAccountDraft {
  readonly harness: FleetHarnessKind;
  readonly name: string;
  readonly variant: string;
  readonly displayName: string;
  readonly mode: 'interactive' | 'auto';
  /** One model per line, or comma separated. Whichever the person typed. */
  readonly modelsText: string;
  readonly defaultModel: string;
  readonly layer: FleetLayerDraft;
}

export const emptyAccountDraft = (harness: FleetHarnessKind): FleetAccountDraft => ({
  harness,
  name: '',
  variant: 'default',
  displayName: '',
  mode: 'auto',
  modelsText: '',
  defaultModel: '',
  layer: emptyLayerDraft(),
});

export const draftModels = (modelsText: string): readonly string[] =>
  modelsText
    .split(/[\n,]/u)
    .map(model => model.trim())
    .filter(model => model.length > 0);

/** The wrapper name the daemon will derive. Shown, never sent: identity stays server-derived. */
export const derivedWrapper = (draft: FleetAccountDraft): string =>
  draft.variant === 'default' ? `${draft.harness}-${draft.name}` : `${draft.harness}-${draft.variant}-${draft.name}`;

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

export const layerProblems = (layer: FleetLayerDraft): readonly string[] => {
  const problems: string[] = [];
  const instructionsPath = layer.instructions.path.trim();
  if (instructionsPath === '') {
    if (layer.instructions.text !== '') problems.push('name the file the instructions are written to');
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

export const accountProblems = (draft: FleetAccountDraft, config: FleetConfigView | null): readonly string[] => {
  const problems: string[] = [];
  const name = draft.name.trim();
  if (name === '') problems.push('name the provider account this lane belongs to');
  else if (name !== draft.name) problems.push('the account name must not start or end with whitespace');
  else if (name.length > 64) problems.push('the account name must be 64 characters or shorter');
  else if (/[/\\]/u.test(name) || name.includes('..') || CONTROL_CHARACTER.test(name)) {
    problems.push('the account name must not contain a path separator, "..", or control characters');
  }

  const variant = draft.variant.trim();
  if (variant === '') problems.push('name the lane this account occupies');
  else if (config !== null && config.variants[variant] === undefined) {
    problems.push(`this fleet declares no "${variant}" lane; declare it on the host before adding an account to it`);
  }

  const models = draftModels(draft.modelsText);
  const defaultModel = draft.defaultModel.trim();
  if (models.length === 0) problems.push('an available account must list at least one model it can serve');
  else if (defaultModel === '') problems.push('name the default model this account serves');
  else if (!models.includes(defaultModel)) {
    problems.push(`the default model "${defaultModel}" is not one of the models listed`);
  }

  return [...problems, ...layerProblems(draft.layer)];
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

export const createAccountProposal = (draft: FleetAccountDraft): FleetProposalRequest => {
  const layer = createLayer(draft.layer);
  const displayName = draft.displayName.trim();
  return {
    mutation: {
      kind: 'create-account',
      harness: draft.harness,
      name: draft.name.trim(),
      variant: draft.variant.trim(),
      mode: draft.mode,
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
