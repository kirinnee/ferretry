/**
 * One decision at a time: the sequence a person walks to add an account, and what each step owns.
 *
 * The form this replaces asked for everything at once — harness, provider name, lane, display name,
 * mode, a free-text model list, an instructions document, a skills directory, a JSON settings blob
 * and an environment table — on one screen, with two of those fields named after mechanisms
 * (`lane`, `layer`) that only the configuration schema has a word for. The complaint was not that
 * the fields were wrong. It was that a person meeting the screen could not tell which of them they
 * had to answer, and in what order, and what any of them would do.
 *
 * Three rules make the sequence honest, and each one is here rather than in the screen because a
 * screen is where they get quietly dropped:
 *
 *  1. **A step blocks only on its OWN answers.** {@link stepProblems} partitions the whole problem
 *     set by the step that can fix each one, so "next" is disabled by something on this screen and
 *     never by a field three steps away. The partition is proved against {@link accountProblems}
 *     rather than maintained beside it — see {@link ALL_STEP_PROBLEMS} — because a partition that
 *     silently stopped covering a rule would let somebody walk to the end and be refused there.
 *  2. **Going back never costs an answer.** Every step reads and writes the ONE draft the surface
 *     holds. There is no per-step state to lose, which is what makes back-and-forward free rather
 *     than a thing to be careful about.
 *  3. **A step whose answer is already known shows the answer.** The host's detection reaches this
 *     module as the same {@link FleetPrefillNotes} the fields already carry, so a prefilled step is
 *     one a person confirms rather than one they fill in.
 *
 * Pure throughout: no React, no client, no clock.
 */

import type { HarnessDiscoveryReport } from '@ferretry/protocol';
import type { FleetConfigView, FleetManifestAccountView } from './fleet-api.ts';
import {
  accountNameProblems,
  accountProblems,
  assetPathProblem,
  BLANK_INSTRUCTIONS_CHOICE,
  canonicalAssetPath,
  discoveredHarness,
  draftModels,
  existingAccounts,
  type FleetAccountDraft,
  type FleetAccountMode,
  type FleetLaneDraft,
  type FleetLayerDraft,
  type FleetSettingsDraft,
  type FleetSkillDraft,
  type FleetUnreadableAsset,
  IMPORTED_INSTRUCTIONS_CHOICE,
  instructionsMiddleOf,
  instructionsPathFor,
  laneProblems,
  layerProblems,
  parsedSettingsObject,
  pathsWrittenTwice,
} from './fleet-change-model.ts';
import type { FleetHarnessKind } from './fleet-model.ts';

/** The steps, in the order they are walked. `review` is the recap, not a seventh question. */
export const FLEET_STEP_IDS = [
  'harness',
  'identity',
  'models',
  'instructions',
  'skills',
  'settings',
  'review',
] as const;
export type FleetStepId = (typeof FLEET_STEP_IDS)[number];

export interface FleetStep {
  readonly id: FleetStepId;
  /** The word in the progress indicator. Short enough to fit a phone. */
  readonly title: string;
  /** The one question this step asks, as a person would ask it. */
  readonly question: string;
}

/**
 * Annotated over every step rather than spelled loosely, so a newly added step is a compile error
 * here instead of a screen with no heading.
 */
const STEP_COPY: Readonly<Record<FleetStepId, Omit<FleetStep, 'id'>>> = {
  harness: { title: 'Harness', question: 'Which agent does this account run?' },
  identity: { title: 'Account', question: 'What is this account called, and how does it run?' },
  models: { title: 'Models', question: 'Which models may this account serve?' },
  instructions: { title: 'Instructions', question: 'Which instructions does it read?' },
  skills: { title: 'Skills', question: 'Which skills does it get?' },
  settings: { title: 'Settings', question: 'Anything to change about its settings?' },
  review: { title: 'Review', question: 'Here is what will be added.' },
};

export const FLEET_STEPS: readonly FleetStep[] = FLEET_STEP_IDS.map(id => ({ id, ...STEP_COPY[id] }));

/**
 * One step's copy, TOTAL over the step ids.
 *
 * A lookup into {@link FLEET_STEPS} is an array index and therefore possibly-undefined, which would
 * make every caller carry a fallback for a case the type system already rules out. This reads the
 * annotated record instead, so a step always has a heading.
 */
export const stepCopy = (step: FleetStepId): FleetStep => ({ id: step, ...STEP_COPY[step] });

export const stepIndex = (step: FleetStepId): number => FLEET_STEP_IDS.indexOf(step);

/** The step after this one, or this one when it is the last. Never wraps. */
export const nextStep = (step: FleetStepId): FleetStepId =>
  FLEET_STEP_IDS[Math.min(stepIndex(step) + 1, FLEET_STEP_IDS.length - 1)] ?? step;

/** The step before this one, or this one when it is the first. Never wraps. */
export const previousStep = (step: FleetStepId): FleetStepId =>
  FLEET_STEP_IDS[Math.max(stepIndex(step) - 1, 0)] ?? step;

// ─── the lane, derived rather than asked for ───────────────────────────────────────────────────

/**
 * The two lanes this control offers, and why there is no third.
 *
 * `mode` and `variant` are NOT one field wearing two names, and collapsing them by deleting one
 * would have dropped something real. A **variant** is a named composition slot: the fleet declares
 * it, every account in it inherits that slot's profiles, and it is what makes one provider account
 * able to have two homes with different instructions. A **mode** is the closed
 * `interactive | auto` enum the manifest publishes, which consumers read to decide whether an
 * account may be driven unattended. `VariantSchema.mode` is a variant's DEFAULT mode and
 * `AccountRouteSchema.mode` overrides it, so a fleet can legitimately declare a `review` lane whose
 * accounts run interactively and put one `auto` account in it.
 *
 * What is true is the owner's observation: on an ordinary fleet the two agree, so asking twice is
 * asking a person to restate an answer. So this control asks the question they can answer — is this
 * account driven by a person, or does it run unattended — and DERIVES the lane from it. The lane is
 * still shown, as the wrapper name it produces; it is simply no longer a word somebody has to know.
 * A fleet with lanes of its own keeps them: see {@link otherLanes}.
 *
 * THE SENTENCE BELOW MAY NOT NAME THE LANE. It sits directly under the two cards that replaced the
 * word, and the version that ended "this picks the lane and the wrapper name for each" reintroduced
 * it in the one place a reader was guaranteed to look — which is what the owner meant by "what does
 * lane means?". What a person needs from it is how many accounts ticking both boxes creates.
 *
 * The answer is a SET rather than one value, and that is a widening of the question, not a collapse
 * of the two facts. "Both" is an ordinary answer — most people running an unattended agent want the
 * attended one on the same login — and it used to mean walking the whole sequence twice and typing
 * every other answer again. One pass, one reviewed change, one account per ticked mode; each of them
 * still derives its own lane through {@link laneForMode}, so a set of modes is still a set of
 * `{ variant, mode }` pairs and never one field pretending to be both.
 */
export const MODE_EXPLANATION =
  'Interactive accounts are the ones you drive. Auto accounts run unattended. Tick both to create one of each — one login, two accounts, each with its own wrapper name.';

/** The fleet's lane for one mode, or the fallback the daemon itself would use. */
export const DEFAULT_LANE = 'default';

/**
 * The lane an account of this mode goes in.
 *
 * Preference order, and each step exists because the one before it can be absent: a fleet that
 * declares a lane named after the mode means that lane; a fleet that declares `default` means
 * `default`; a fleet that declares neither has exactly one thing it could mean, which is whatever it
 * did declare. An empty list is what the daemon defaults to, so the browser agrees with it rather
 * than inventing a second answer.
 */
export const laneForMode = (mode: FleetAccountMode, variants: readonly string[]): string => {
  if (variants.includes(mode)) return mode;
  if (variants.includes(DEFAULT_LANE)) return DEFAULT_LANE;
  return variants[0] ?? DEFAULT_LANE;
};

/**
 * Lanes this fleet declares that no mode would ever derive.
 *
 * The escape hatch, offered ONLY when there is one — a fleet with just `default`, or just
 * `auto`/`interactive`, gets no control at all, which is the whole point of deriving. A fleet whose
 * operator declared a `review` lane would otherwise have no way to put a new account in it from
 * here, and "the UI cannot express what the configuration can" is how a surface becomes the reason
 * somebody edits YAML by hand.
 */
export const otherLanes = (variants: readonly string[]): readonly string[] => {
  const derivable = new Set([DEFAULT_LANE, 'auto', 'interactive']);
  return variants.filter(variant => !derivable.has(variant));
};

/**
 * The two modes, in the order they are offered and the order the accounts they create are listed in.
 *
 * Annotated rather than left to selection order, because the order reaches a person: it is the order
 * the wrapper names appear in on the identity step, in the recap, and in the mutation the daemon
 * derives routes from. A set that reordered itself depending on which box was ticked first would make
 * the same two accounts read as a different change.
 */
export const FLEET_ACCOUNT_MODES: readonly FleetAccountMode[] = ['interactive', 'auto'];

/** The modes this draft currently selects, in {@link FLEET_ACCOUNT_MODES} order. */
export const selectedModes = (draft: FleetAccountDraft): readonly FleetAccountMode[] =>
  draft.lanes.map(lane => lane.mode);

/** The draft carrying exactly these lanes, put back into {@link FLEET_ACCOUNT_MODES} order. */
const withLanes = (draft: FleetAccountDraft, lanes: readonly FleetLaneDraft[]): FleetAccountDraft => ({
  ...draft,
  lanes: FLEET_ACCOUNT_MODES.flatMap(mode => lanes.filter(lane => lane.mode === mode)),
});

/**
 * The draft after choosing a SET of modes, every lane DERIVED afresh.
 *
 * This is the re-laning operation, and it is not the same thing as ticking a box — which is why
 * {@link toggleMode} is a separate function rather than this one called with one more mode. A draft
 * opened against a fleet has to have every lane derived against THAT fleet's variants: a seed that
 * says "auto" while claiming the `default` lane must not survive first contact with a fleet that
 * declares an `auto` one, because the first frame a person sees would then disagree with itself.
 */
export const withModes = (
  draft: FleetAccountDraft,
  modes: readonly FleetAccountMode[],
  variants: readonly string[],
): FleetAccountDraft =>
  withLanes(
    draft,
    [...new Set(modes)].map(mode => ({ mode, variant: laneForMode(mode, variants) })),
  );

/**
 * Add or remove one mode from the selection, leaving every other lane exactly as it is.
 *
 * A lane already held keeps its variant rather than being re-derived, which is what makes the escape
 * hatch survive: somebody who moved the interactive account into this fleet's `review` lane and then
 * ticks "auto" as well must not have that choice quietly rewritten back to the derived one. Removing
 * the last mode is allowed — the step blocks on it, where the boxes are, rather than a control
 * refusing to be untickable for a reason nobody can see.
 */
export const toggleMode = (
  draft: FleetAccountDraft,
  mode: FleetAccountMode,
  variants: readonly string[],
): FleetAccountDraft => {
  const held = draft.lanes.filter(lane => lane.mode !== mode);
  if (held.length !== draft.lanes.length) return withLanes(draft, held);
  return withLanes(draft, [...held, { mode, variant: laneForMode(mode, variants) }]);
};

/**
 * The draft after moving ONE of its accounts into a lane the fleet declares.
 *
 * Per mode, because with two accounts in play a single lane control would have no answer to "which of
 * them". Keyed on the mode rather than on a list index, so a re-tick that reorders nothing still
 * lands on the account the person was looking at.
 */
export const withLaneVariant = (
  draft: FleetAccountDraft,
  mode: FleetAccountMode,
  variant: string,
): FleetAccountDraft => ({
  ...draft,
  lanes: draft.lanes.map(lane => (lane.mode === mode ? { ...lane, variant } : lane)),
});

// ─── models: what the host and this fleet actually name ────────────────────────────────────────

/**
 * One model this account could be offered, and the evidence for it.
 *
 * `verified` is the whole point of the type. A model identifier is a string a provider either
 * recognises or does not, and this browser cannot tell — so it never guesses. An option is
 * `verified` when something on this host NAMED it: the harness's own settings file, or an account
 * this fleet already publishes for the same harness. Anything a person types is `unverified` and
 * says so, because refusing it outright would block somebody running a model we have not heard of,
 * and accepting it silently would let an account claim to serve something no session can start.
 */
export interface FleetModelOption {
  readonly id: string;
  /**
   * What this identifier is called where anything calls it something. Present only when a real
   * source supplied one — a manifest entry's `displayName` — never a prettified id.
   */
  readonly displayName?: string;
  readonly verified: boolean;
  /** Where this option came from, in one sentence a person can check. */
  readonly detail: string;
}

/**
 * The models worth offering for one harness, most-trustworthy first.
 *
 * Two sources, and NEITHER is a table in this file. The first is what the host reported for this
 * harness — the settings file it reads, or Ferretry's own starter model when that file names none,
 * carrying its own sentence either way. The second is every model an account this fleet ALREADY
 * publishes for the same harness declares, with the display name that manifest gave it: those are
 * models somebody on this machine is already serving, which is the strongest evidence available
 * short of asking the provider.
 *
 * A model this module invented would be the one thing the discovery contract refuses to do, so it
 * does not do it either. A harness with nothing detected and no published sibling produces an EMPTY
 * list, and the step says so rather than offering a plausible-looking name.
 */
export const modelOptions = (
  harness: FleetHarnessKind,
  discovery: HarnessDiscoveryReport | null,
  published: readonly FleetManifestAccountView[],
): readonly FleetModelOption[] => {
  const options = new Map<string, FleetModelOption>();
  const found = discoveredHarness(discovery, harness);
  if (found !== undefined) {
    for (const id of found.models.ids) {
      options.set(id, {
        id,
        verified: found.models.origin === 'detected',
        detail:
          found.models.origin === 'detected'
            ? `Detected — read from ${found.models.source}.`
            : `Not detected — ${found.models.source}.`,
      });
    }
  }
  for (const account of published) {
    if (account.kind !== harness) continue;
    for (const model of account.models) {
      // An account that declares a model UNAVAILABLE has said why, for itself. That reason does not
      // transfer to a new account, but neither does the evidence — so it is not offered here, for
      // the same reason the manifest refuses to default to one.
      if (!model.available) continue;
      // The host's own reading wins: it describes THIS harness's configuration, where a sibling
      // account describes somebody's choice for a different account.
      if (options.has(model.id)) continue;
      options.set(model.id, {
        id: model.id,
        ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
        verified: true,
        detail: `Already served by ${account.wrapper} on this fleet.`,
      });
    }
  }
  return [...options.values()];
};

/** Models the draft currently lists, whether or not anything on this host has heard of them. */
export const selectedModels = (draft: FleetAccountDraft): readonly string[] => draftModels(draft.modelsText);

/**
 * A selected model nothing on this host names.
 *
 * Rendered beside the selection as a plain statement rather than a problem: it does not block, it is
 * simply the one fact about that entry a person cannot check from here.
 */
export const unverifiedModels = (draft: FleetAccountDraft, options: readonly FleetModelOption[]): readonly string[] => {
  const verified = new Set(options.filter(option => option.verified).map(option => option.id));
  return selectedModels(draft).filter(model => !verified.has(model));
};

/**
 * Add or remove one model from the selection, keeping the default model true.
 *
 * Removing the default clears it rather than leaving it naming something the account no longer
 * lists — which is the exact inconsistency `accountProblems` would then report as a problem the
 * person did not cause. Adding the FIRST model makes it the default, because an available account
 * must name one and picking the only candidate is not a decision anybody wants to be asked for.
 */
export const toggleModel = (draft: FleetAccountDraft, id: string): FleetAccountDraft => {
  const current = selectedModels(draft);
  const next = current.includes(id) ? current.filter(model => model !== id) : [...current, id];
  return withModels(draft, next);
};

/** The draft carrying exactly these models, with the default kept consistent with them. */
export const withModels = (draft: FleetAccountDraft, models: readonly string[]): FleetAccountDraft => ({
  ...draft,
  modelsText: models.join('\n'),
  defaultModel: models.includes(draft.defaultModel.trim()) ? draft.defaultModel : (models[0] ?? ''),
});

/**
 * Why this typed identifier cannot be added, or `null` when it can.
 *
 * Deliberately thin. A model id is a provider's string and this browser has no grammar for it; the
 * only things it can honestly refuse are nothing at all, something it already has, and whitespace
 * that would produce two entries that look identical.
 */
export const customModelProblem = (value: string, draft: FleetAccountDraft): string | null => {
  const trimmed = value.trim();
  if (trimmed === '') return 'type the model identifier first';
  if (trimmed !== value) return 'a model identifier must not start or end with a space';
  if (selectedModels(draft).includes(trimmed)) return `"${trimmed}" is already listed`;
  return null;
};

// ─── instructions and skills: what the store offers ────────────────────────────────────────────

/**
 * What choosing a document from the fleet's shared store means, said where somebody is standing.
 *
 * The sentence is deliberately about the APPLY rather than about an inode. Linking an account to a
 * shared document is a declaration in the configuration; the plan copies that document into each
 * linked account's home on the next reviewed apply, because a generated account home sits under the
 * state home whose filesystem invariant rejects symlink components, and because Claude rewrites its
 * own `settings.json` at runtime — a shared inode would make one account's `/effort` land in every
 * account linked to it. So one item and many linkers is true, and "everyone changes the moment you
 * save" is not; saying which is what keeps the offer honest.
 */
export const SHARED_DOCUMENT_CONSEQUENCE =
  'One document, shared. Editing it changes every account linked to it, on the next apply.';

/** What an account's own new document means, in the same breath. */
export const OWN_DOCUMENT_CONSEQUENCE =
  'This account’s own copy. Nothing else reads it, and edits here go nowhere else.';

/**
 * Choosing WHICH instructions document this account reads.
 *
 * The options themselves come from {@link instructionsChoices}: the store's existing documents, plus
 * a new one for this account seeded from what this host already has or left empty. Reading the text
 * of an existing document is the surface's job — until it lands, `unseenAssets` blocks staging, so a
 * person cannot apply a change that would overwrite a document this browser has never seen.
 */
export interface FleetInstructionsControl {
  readonly choices: readonly { readonly value: string; readonly label: string; readonly detail: string }[];
  readonly value: string;
  readonly onChoose: (value: string) => void;
  /** True while a chosen document's current text is still being read from the daemon. */
  readonly loading: boolean;
}

/**
 * WHERE THE ANSWER TO A STEP COMES FROM. Three answers, and all of them end the same way.
 *
 * One union for every step that asks it, because it is one question: the account POINTS AT something
 * that exists. `existing` points at an item that is already there; `new` creates one under a chosen
 * name and points at that; `import` — offered only where this host has something to copy — puts the
 * host's real file into the store under a chosen name and then points at that. Import and new differ
 * only in where the first draft of the text comes from, which is why they are two answers to one
 * question rather than two flows.
 *
 * It lives HERE rather than beside the control that renders it, because which answers exist is a fact
 * about the question. `FleetPickOrAdd` annotates its labels over this union, so an answer added here
 * is a compile error there rather than a card with no label.
 *
 * A POSIX symlink is deliberately not part of this. The pointer IS the link: `config.shared` is a
 * registry of named documents and an account references one by name, so an edit to that document
 * reaches every account pointing at it. What a real symlink would change is only WHEN — immediately
 * rather than on the next apply — which is an optimisation of a mechanism that already works, and
 * not something a person composing an account has to be asked about.
 */
export type FleetPickOrAddSource = 'existing' | 'import' | 'new';

/**
 * ONE SET OF WORDS for those answers, so a person learns this control once.
 *
 * Here rather than beside the control that renders it, because a REFUSAL has to cite the label it is
 * sending somebody to: `instructionsNameProblem` used to say `pick "Use an existing one"` while the
 * card actually read "Use one already in the store", which is a blocker naming a control that is not
 * on the screen. Annotated over the union so a fourth answer is a compile error rather than a card
 * with a blank label.
 *
 * "Use one this fleet already has" rather than "…already in the store", because the account step picks
 * a provider login and there is no store of those — and one label that reads correctly for a document,
 * a skill and a login is the point.
 */
export const PICK_OR_ADD_LABEL: Readonly<Record<FleetPickOrAddSource, string>> = {
  existing: 'Use one this fleet already has',
  import: 'Import this host’s own',
  new: 'Add a new one',
};

/**
 * Which answer the ACCOUNT step opens on: pick one, wherever there is one to pick.
 *
 * ASK FIRST, which is the owner's rule and the opposite of what the free-text box did. A fleet with a
 * login of this harness opens on the list of them; a fleet with none opens on the box, because "pick or
 * add" is not a question when there is exactly one answer.
 *
 * It is only the OPENING value, for the same reason the instructions one is. Once a person has answered,
 * the answer is theirs — see {@link FleetAccountStepperProps.accountSource} for what re-deriving it
 * would do to somebody halfway through typing a name.
 */
export const openingAccountSource = (
  harness: FleetHarnessKind,
  config: FleetConfigView | null,
): FleetPickOrAddSource => (existingAccounts(harness, config).length === 0 ? 'new' : 'existing');

/** The store item the draft points at, when it points at one that is already there. */
const EXISTING_PREFIX = 'asset:';

/**
 * Which of the three a freshly opened draft starts on.
 *
 * The answer itself is HELD, not re-derived, and this is only its opening value. Re-deriving it from
 * the path looked tidier and was wrong: naming a new document `shared` when the store already holds
 * `CLAUDE-shared.md` would have flipped the answer to "use that existing one", hidden the name box,
 * and pointed the account at somebody else's document instead of refusing the collision. An answer a
 * person gave is a fact about them, so it is kept rather than guessed at every render.
 */
export const openingInstructionsSource = (draft: FleetAccountDraft): FleetPickOrAddSource =>
  draft.prefilled.instructionsText === undefined ? 'new' : 'import';

/** The opaque value {@link FleetInstructionsControl.onChoose} takes for each source. */
export const instructionsChoiceFor = (source: FleetPickOrAddSource, firstExisting: string | undefined): string => {
  if (source === 'import') return IMPORTED_INSTRUCTIONS_CHOICE;
  if (source === 'new') return BLANK_INSTRUCTIONS_CHOICE;
  // Choosing "an existing one" with nothing chosen yet lands on the first document rather than on a
  // dead radio: the person asked for the store, so the store is what they get.
  return firstExisting === undefined ? BLANK_INSTRUCTIONS_CHOICE : `${EXISTING_PREFIX}${firstExisting}`;
};

/** The part of the document name this account owns, or the empty string when it owns none yet. */
export const instructionsMiddle = (draft: FleetAccountDraft): string =>
  instructionsMiddleOf(draft.harness, draft.layer.instructions.path.trim()) ?? '';

/**
 * The draft after renaming its own document.
 *
 * Only ever the middle. The directory, the harness prefix and the extension are this scheme's, so a
 * person cannot rename their way out of the store or into another harness's naming — and the path
 * they end up with is one the daemon's own asset grammar will accept.
 */
export const withInstructionsMiddle = (draft: FleetAccountDraft, middle: string): FleetAccountDraft => {
  // A name they typed is theirs, so the derived one must stop overwriting it. Clearing the box is
  // still the way back to the derived default, which is why an empty middle keeps the claim.
  const prefilled = { ...draft.prefilled };
  if (middle.trim() !== '') delete prefilled.instructionsPath;
  return {
    ...draft,
    layer: {
      ...draft.layer,
      instructions: { ...draft.layer.instructions, path: instructionsPathFor(draft.harness, middle) },
    },
    prefilled,
  };
};

/**
 * Why this name cannot be used, or `null` when it can.
 *
 * The collision check is the one that matters. Two accounts naming one document is the whole point
 * of a store — but naming it while CREATING a new document means writing over text somebody else
 * points at, which is a data-loss bug wearing a feature's clothes. So it is refused, and the sentence
 * names the path it collides with rather than saying "already exists".
 */
export const instructionsNameProblem = (
  middle: string,
  harness: FleetHarnessKind,
  existing: readonly string[],
): string | null => {
  const trimmed = middle.trim();
  if (trimmed === '') return 'name this document';
  if (trimmed !== middle) return 'the name must not start or end with a space';
  if (/[/\\]/u.test(trimmed) || trimmed.includes('..')) return 'the name must not contain a path separator or ".."';
  const path = instructionsPathFor(harness, trimmed);
  const problem = assetPathProblem(path, 'that name produces a path that');
  if (problem !== null) return problem;
  if (existing.includes(path)) {
    return `"${path}" is already in the store — pick "${PICK_OR_ADD_LABEL.existing}" to point at it, or choose another name`;
  }
  return null;
};

/**
 * The skills a new account gets, as ONE store directory.
 *
 * A DECLARED GAP, and it is worth saying which. The configuration's `skills` field is a single
 * directory reference, so the smallest thing an account can be given today is a whole directory —
 * "these three skills and not those two" is not expressible, and this step does not pretend it is.
 * The shape below is a LIST for exactly that reason: when `skills` accepts one, per-item selection
 * becomes more entries in `selected` and this step's control gains checkboxes, without the step
 * itself being redesigned.
 */
export interface FleetSkillsSelection {
  /** Store directories this account links, in selection order. At most one, today. */
  readonly selected: readonly string[];
}

/**
 * One skills directory the fleet's store offers, and who already links it.
 *
 * `accounts` is the fact that makes a shared item safe to reason about — it answers "what else
 * changes if I edit this" before somebody edits it — and it is carried as WRAPPER NAMES rather than
 * a count because "linked by claude-studio and claude-work" is what a person acts on. Ids would be
 * the join key and unreadable; the wrapper is the word they typed.
 */
export interface FleetSkillsStoreItem {
  /** The directory's path inside the fleet's asset tree, which is also its identity. */
  readonly path: string;
  /** Wrappers whose account already links it, in fleet order. Empty means nothing links it yet. */
  readonly accounts: readonly string[];
}

/** A listed asset path's top two segments, when it has two. `skills/review/a.md` → `skills/review`. */
const storeDirectoryOf = (path: string): string | undefined => {
  const parts = path.split('/').filter(segment => segment !== '');
  return parts.length >= 3 ? `${parts[0] ?? ''}/${parts[1] ?? ''}` : undefined;
};

/**
 * The skills the store holds, from the two places that know: the configuration, and the tree.
 *
 * The configuration is the authority on which directories are SKILLS — a path is a skills directory
 * because a route's layer says so, never because of what it is called — so those are listed first
 * and carry their linkers. The asset index then contributes directories that sit UNDER one of those
 * declared roots and are not themselves declared: a store item somebody added and nothing links yet,
 * which would otherwise be invisible in the one place it needs to be offered.
 *
 * Nothing is inferred from a name. A tree with a `skills/` directory that no route declares produces
 * no options at all, and the step says the store is empty rather than guessing that it is not.
 */
export const skillsStoreItems = (
  config: FleetConfigView | null,
  listed: readonly string[],
): readonly FleetSkillsStoreItem[] => {
  const linkers = new Map<string, string[]>();
  for (const agent of config?.agents ?? []) {
    for (const route of Object.values(agent.routes)) {
      const skills = route.layer?.skills;
      if (typeof skills !== 'string' || skills.trim() === '') continue;
      const existing = linkers.get(skills.trim());
      if (existing === undefined) linkers.set(skills.trim(), [route.wrapper]);
      else existing.push(route.wrapper);
    }
  }
  const items = new Map<string, FleetSkillsStoreItem>();
  for (const [path, accounts] of linkers) items.set(path, { path, accounts });
  const roots = [...linkers.keys()].map(path => path.split('/')[0] ?? path);
  for (const path of listed) {
    const directory = storeDirectoryOf(path);
    if (directory === undefined || items.has(directory)) continue;
    if (!roots.includes(directory.split('/')[0] ?? directory)) continue;
    items.set(directory, { path: directory, accounts: [] });
  }
  return [...items.values()];
};

/** The selection the draft currently expresses. */
export const skillsSelection = (layer: FleetLayerDraft): FleetSkillsSelection => {
  const directory = layer.skillsDirectory.trim();
  return { selected: directory === '' ? [] : [directory] };
};

/** The layer after selecting these store directories. An empty selection declares no skills at all. */
export const withSkillsSelection = (layer: FleetLayerDraft, selected: readonly string[]): FleetLayerDraft => ({
  ...layer,
  skillsDirectory: selected[0] ?? '',
  // Documents authored inline belong to the directory that was selected. Changing the selection
  // leaves them naming a path outside it, which `layerProblems` would then report — so they go with
  // it rather than becoming a problem the person did not cause.
  skills: selected.length === 0 ? [] : layer.skills,
});

// ─── adding a skill that is not in the store yet ───────────────────────────────────────────────

/**
 * The fixed part of a new skill's path, and the document that makes the directory real.
 *
 * `skills/` is where the fleet's own scaffold puts them and what the field's placeholder has always
 * shown, so a new one lands beside whatever is already there rather than inventing a second
 * convention — the same rule {@link instructionsPathFor} follows for a document. `SKILL.md` is the
 * open standard's own filename, which is what makes a directory a skill rather than a folder of notes.
 */
export const SKILLS_PREFIX = 'skills/';
export const SKILL_DOCUMENT = 'SKILL.md';

/**
 * The skill this draft is AUTHORING, as opposed to the ones it picked out of the store.
 *
 * The distinction is the whole reason this exists. A picked skill is a reference: the store already
 * holds the documents and this change writes none of them. An authored one is a directory that does not
 * exist yet plus the first document in it, so the change carries text — which is why it is the
 * `skills` rows the draft already had rather than a second field. Exactly one row, because the step
 * offers one "add" and per-item selection is a declared limit below.
 */
export const authoredSkill = (layer: FleetLayerDraft): FleetSkillDraft | undefined => layer.skills[0];

/**
 * Why this name cannot become a new skill, or `null` when it can.
 *
 * The store collision is the one that matters, and it is a REDIRECT rather than a refusal of the
 * intent: naming a directory the store already has is almost always somebody meaning to link it, and
 * the control that does that is a tap above. It does not claim to prevent an overwrite — a document
 * added under an existing directory blocks later, in the daemon's own terms, through `unseenAssets`.
 */
export const newSkillProblem = (
  middle: string,
  store: readonly FleetSkillsStoreItem[],
  layer: FleetLayerDraft,
): string | null => {
  const trimmed = middle.trim();
  if (trimmed === '') return 'name the skill first';
  if (trimmed !== middle) return 'a skill name must not start or end with a space';
  if (/[/\\]/u.test(trimmed) || trimmed.includes('..')) return 'the name must not contain a path separator or ".."';
  const path = `${SKILLS_PREFIX}${trimmed}`;
  const problem = assetPathProblem(path, 'that name produces a path that');
  if (problem !== null) return problem;
  if (store.some(item => item.path === path)) {
    return `"${path}" is already in the store — tick it above to link it, or choose another name`;
  }
  return layer.skillsDirectory.trim() === path ? `"${path}" is already listed` : null;
};

/**
 * The layer carrying a NEW skill: the directory selected, and one document seeded inside it.
 *
 * The `id` is passed in because it is a DOM identity a component mints, and this module holds no
 * randomness. The document's path is derived rather than asked for — `skillsProblems` refuses a
 * document outside the directory it belongs to, and a person who has to keep two boxes agreeing is
 * being asked to maintain an invariant the scheme already knows.
 */
export const withNewSkill = (layer: FleetLayerDraft, middle: string, id: string): FleetLayerDraft => {
  const directory = `${SKILLS_PREFIX}${middle.trim()}`;
  return { ...layer, skillsDirectory: directory, skills: [{ id, path: `${directory}/${SKILL_DOCUMENT}`, text: '' }] };
};

/** The layer after editing the authored document's text. Nothing to edit means nothing changes. */
export const withAuthoredSkillText = (layer: FleetLayerDraft, text: string): FleetLayerDraft => {
  const authored = authoredSkill(layer);
  return authored === undefined ? layer : { ...layer, skills: [{ ...authored, text }] };
};

// ─── settings: several apply, and you can see the order ────────────────────────────────────────

/**
 * SETTINGS ARE A STACK, and this step is where a person composes one.
 *
 * What this replaces asked a two-way question — leave the fleet's settings alone, or type one JSON
 * object — which is the one step in the sequence that did not follow the owner's rule. The rule is
 * "pick from what this fleet already has, or add one and have it join the collection", and settings
 * were the field where it mattered most: `settings` has ALWAYS been a stack on the wire, deep-merged
 * left to right, with an entry allowed to be a document reference or an inline object
 * (`packages/protocol/src/lib/fleet-changes.ts`). A single JSON box could express the last entry of
 * that stack and nothing else, so the mechanism the fleet already had was unreachable from a browser.
 *
 * Three answers, and each of them is a real difference in what applying WRITES:
 *
 *  - a document this fleet already has — the change carries a reference and writes no text at all;
 *  - a document written here — the change carries its text, so it lands in the asset tree and the
 *    NEXT account created can pick it, which is the "auto add it to the entity type" half;
 *  - settings typed here with no name — an object in the configuration itself, for the person who
 *    wants two keys and not a file.
 *
 * ORDER IS THE FEATURE, so it is shown rather than implied: the entries are a numbered list a person
 * reorders, and {@link settingsOrigins} says, per key, which entry supplied the value that survives.
 * "These apply in order" is the whole sentence — the word for the mechanism is one the owner called
 * way too complicated, and a composed value whose origin cannot be explained is worse than no
 * composition at all.
 *
 * WHAT THIS STEP DOES NOT CLAIM: the fleet's own composition chain. `compositionSlots` in the fleet
 * package owns the order the fleet applies its shared documents and profiles in, and a browser that
 * restated that order would be a second description of it — disagreeing exactly where it matters
 * most, on an account whose settings are not the ones the screen claims. So this step says what it
 * owns, which is that this account's own entries apply LAST and in the order shown.
 */

/** Where a new settings document lands, per harness. The directory this fleet's own scaffold uses. */
export const SETTINGS_PREFIX: Readonly<Record<FleetHarnessKind, string>> = {
  claude: 'templates/claude/',
  codex: 'templates/codex/',
};

/**
 * The extension and the format name, per harness, and they are ONE fact rather than two.
 *
 * A harness's settings destination decides how every document in its stack is parsed —
 * `settings.json` is read as JSON and `config.toml` as TOML (`packages/fleet/src/lib/assets.ts`) — so
 * the extension a new document gets is not decoration: a `.json` document handed to a Codex account is
 * parsed as TOML and fails the apply. Deriving it is what stops a person having to know that.
 */
export const SETTINGS_DOCUMENT: Readonly<
  Record<FleetHarnessKind, { readonly extension: string; readonly format: string }>
> = {
  claude: { extension: '.json', format: 'JSON' },
  codex: { extension: '.toml', format: 'TOML' },
};

/** A new settings document's path from the part a person named. An empty middle names nothing. */
export const settingsPathFor = (harness: FleetHarnessKind, middle: string): string =>
  middle.trim() === '' ? '' : `${SETTINGS_PREFIX[harness]}${middle.trim()}${SETTINGS_DOCUMENT[harness].extension}`;

/**
 * One settings document this fleet has, and who already applies it.
 *
 * `name` is the name `config.shared.settings` gave it, present only where the registry named it —
 * that registry is what makes a scaffolded fleet's own templates offerable at all, since it applies
 * them through the `base` profile rather than through any account's overlay.
 *
 * `refusal` is how a declared document that cannot be picked FROM A BROWSER says so on its own card
 * instead of vanishing from the list. An operator may legitimately write `~/settings.json` in
 * `config.yaml`; a paired browser may not send one, and a store that quietly dropped it would tell
 * somebody their fleet has no settings documents while its configuration names two.
 */
export interface FleetSettingsStoreItem {
  readonly path: string;
  readonly name?: string;
  /** Wrappers whose account already applies it, in fleet order. Empty means no account names it. */
  readonly accounts: readonly string[];
  readonly refusal?: string;
}

/**
 * The settings documents this fleet has, from the two places that know.
 *
 * The REGISTRY first — `config.shared.settings`, the names this fleet gave its documents — then every
 * document an account's own overlay references, which is how one written by an earlier pass of this
 * very step becomes offerable to the next. Nothing is inferred from a filename: a path is a settings
 * document because the configuration says it is one, never because of what it is called.
 *
 * Every path is canonicalised on the way out. The configuration spells them `./templates/...` and the
 * browser's grammar refuses a `.` segment, so the two spellings are reconciled HERE — once, where the
 * offer is built — rather than at each of the places that compares, offers or sends one.
 */
export const settingsStoreItems = (config: FleetConfigView | null): readonly FleetSettingsStoreItem[] => {
  const named = new Map<string, string>();
  for (const [name, declared] of Object.entries(config?.shared?.settings ?? {})) {
    named.set(canonicalAssetPath(declared), name);
  }
  const linkers = new Map<string, string[]>();
  for (const agent of config?.agents ?? []) {
    for (const route of Object.values(agent.routes)) {
      for (const path of declaredSettingsPaths(route.layer?.settings)) {
        const held = linkers.get(path);
        if (held === undefined) linkers.set(path, [route.wrapper]);
        else held.push(route.wrapper);
      }
    }
  }
  const items = new Map<string, FleetSettingsStoreItem>();
  for (const path of [...named.keys(), ...linkers.keys()]) {
    if (items.has(path)) continue;
    const name = named.get(path);
    const problem = assetPathProblem(path, 'it');
    items.set(path, {
      path,
      ...(name === undefined ? {} : { name }),
      accounts: linkers.get(path) ?? [],
      ...(problem === null ? {} : { refusal: problem }),
    });
  }
  return [...items.values()];
};

/**
 * TWO FACTS ABOUT ONE DOCUMENT that a person needs put side by side, or `null` when they agree.
 *
 * The facts are: what this document is NAMED, and which parser the harness reading it will use. They
 * are independent — `parseSettings` is handed the harness's own destination format and never looks at
 * the extension — so a `config.toml` applied to a Claude account is parsed as JSON and fails the
 * apply. The scaffolded fleet registers exactly one document per harness, and this step offers both,
 * so that is not a hypothetical trap: it is the default one.
 *
 * It is a STATEMENT and not a refusal, and the difference matters. An extension is a claim about
 * contents that can be wrong in either direction — a `.json` file may hold TOML and nobody here has
 * read either — so this says the two facts and leaves the conclusion to the person, rather than
 * refusing a document on the strength of its name.
 */
export const settingsFormatNote = (path: string, harness: FleetHarnessKind): string | null => {
  const { extension, format } = SETTINGS_DOCUMENT[harness];
  if (path.endsWith(extension)) return null;
  // A path with no extension at all gets the same sentence with the first half told honestly: there
  // is no name to quote, and slicing at a dot that is not there would quote its last character.
  const dot = path.lastIndexOf('.');
  const named = dot === -1 || dot < path.lastIndexOf('/') ? 'Named with no extension' : `Named ${path.slice(dot)}`;
  return `${named}, and a ${harness} account reads its settings as ${format}.`;
};

/** Every document path one route's declared `settings` references, canonical, in declared order. */
const declaredSettingsPaths = (declared: unknown): readonly string[] =>
  (Array.isArray(declared) ? (declared as readonly unknown[]) : [declared])
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    .map(entry => canonicalAssetPath(entry.trim()));

/** The one entry a person typed rather than named, when they have typed one. */
export const inlineSettings = (layer: FleetLayerDraft): FleetSettingsDraft | undefined =>
  layer.settings.find(entry => entry.source === 'inline');

/** Documents this change WRITES, as opposed to the ones it references. */
export const authoredSettings = (layer: FleetLayerDraft): readonly FleetSettingsDraft[] =>
  layer.settings.filter(entry => entry.source === 'new');

/** The paths the stack currently applies, whether referenced or authored, in the order they apply. */
export const settingsPaths = (layer: FleetLayerDraft): readonly string[] =>
  layer.settings.filter(entry => entry.source !== 'inline').map(entry => entry.path.trim());

/**
 * Tick a document this fleet has, or untick it.
 *
 * Ticking APPENDS, which is what makes selection order the order that applies: an entry inserted
 * anywhere else would silently change what an earlier pick means. Unticking removes it and leaves
 * every other entry exactly where it was.
 */
export const withStoreSettings = (layer: FleetLayerDraft, path: string, id: string): FleetLayerDraft => {
  const held = layer.settings.filter(entry => !(entry.source !== 'inline' && entry.path.trim() === path));
  if (held.length !== layer.settings.length) return { ...layer, settings: held };
  return { ...layer, settings: [...layer.settings, { id, source: 'store', path, text: '' }] };
};

/**
 * The layer carrying a NEW settings document: appended to the stack, with its text seeded.
 *
 * The seed is the empty document for the harness's own format rather than an empty file, for the same
 * reason the old inline box seeded `{}`: somebody who asked to write a document is looking at the box
 * to type into, and an empty JSON file is not a document the daemon can parse.
 */
export const withNewSettings = (
  layer: FleetLayerDraft,
  harness: FleetHarnessKind,
  middle: string,
  id: string,
): FleetLayerDraft => ({
  ...layer,
  settings: [
    ...layer.settings,
    {
      id,
      source: 'new',
      path: settingsPathFor(harness, middle),
      text: SETTINGS_DOCUMENT[harness].extension === '.json' ? '{}\n' : '',
    },
  ],
});

/**
 * The layer carrying settings typed here with no name. AT MOST ONE, and that is a rule not a limit.
 *
 * Two anonymous entries are indistinguishable in the list a person reorders, and merging one nameless
 * object onto another is a thing nobody needs: whatever the second would say, they can type into the
 * first. A document is how you get two, and a document has a name.
 */
export const withInlineSettings = (layer: FleetLayerDraft, id: string): FleetLayerDraft =>
  inlineSettings(layer) === undefined
    ? { ...layer, settings: [...layer.settings, { id, source: 'inline', path: '', text: '{}' }] }
    : layer;

/** The layer without one entry. The only way back to an account that adds no settings of its own. */
export const withoutSettings = (layer: FleetLayerDraft, id: string): FleetLayerDraft => ({
  ...layer,
  settings: layer.settings.filter(entry => entry.id !== id),
});

/** The layer with one entry moved one place earlier or later. At either end, nothing changes. */
export const withSettingsMoved = (layer: FleetLayerDraft, id: string, delta: -1 | 1): FleetLayerDraft => {
  const index = layer.settings.findIndex(entry => entry.id === id);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= layer.settings.length) return layer;
  const moved = [...layer.settings];
  const [entry] = moved.splice(index, 1);
  if (entry === undefined) return layer;
  moved.splice(target, 0, entry);
  return { ...layer, settings: moved };
};

/** The layer after editing one entry's text. An entry that is not there changes nothing. */
export const withSettingsText = (layer: FleetLayerDraft, id: string, text: string): FleetLayerDraft => ({
  ...layer,
  settings: layer.settings.map(entry => (entry.id === id ? { ...entry, text } : entry)),
});

/**
 * Why this name cannot become a new settings document, or `null` when it can.
 *
 * The store collision is a REDIRECT rather than a refusal of the intent — naming a document the fleet
 * already has is almost always somebody meaning to apply it, and the control that does that is a tap
 * above. The write collision is a genuine refusal: a path this same change already writes with other
 * text would resolve by last-write-wins, and a person reviewing the plan would see both.
 */
export const newSettingsProblem = (
  middle: string,
  harness: FleetHarnessKind,
  store: readonly FleetSettingsStoreItem[],
  layer: FleetLayerDraft,
): string | null => {
  const trimmed = middle.trim();
  if (trimmed === '') return 'name this document';
  if (trimmed !== middle) return 'the name must not start or end with a space';
  if (/[/\\]/u.test(trimmed) || trimmed.includes('..')) return 'the name must not contain a path separator or ".."';
  const path = settingsPathFor(harness, trimmed);
  const problem = assetPathProblem(path, 'that name produces a path that');
  if (problem !== null) return problem;
  if (store.some(item => item.path === path)) {
    return `"${path}" is already in the store — tick it above to apply it, or choose another name`;
  }
  if (settingsPaths(layer).includes(path)) return `"${path}" is already listed`;
  if ([layer.instructions.path.trim(), ...layer.skills.map(skill => skill.path.trim())].includes(path)) {
    return `"${path}" is already written by this change; one path carries one text`;
  }
  return null;
};

/** What one entry is called where a person reads it: the document's path, or that they typed it. */
export const settingsEntryLabel = (entry: FleetSettingsDraft): string =>
  entry.source === 'inline' ? 'typed here' : entry.path.trim() === '' ? 'an unnamed document' : entry.path.trim();

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The text of one entry as the object it expresses, or `undefined` when this screen cannot know it.
 *
 * Three of the four cases are knowable and one is not, and the one that is not is the point of the
 * distinction. An `inline` entry is a JSON object whichever harness reads it, because the daemon
 * serialises it into the harness's own format. A `new` document is text in the HARNESS's format, so a
 * Claude one parses here and a Codex one is TOML that this browser has no parser for. A `store` entry
 * is a document nothing here has read.
 *
 * A `null` harness is the fourth case and it lands with the unknowable ones: a screen that was not
 * told which harness reads a document cannot tell which parser would have read it.
 */
const knownSettingsObject = (
  entry: FleetSettingsDraft,
  harness: FleetHarnessKind | null,
): Readonly<Record<string, unknown>> | undefined => {
  if (entry.source === 'store') return undefined;
  if (entry.source === 'new' && (harness === null || SETTINGS_DOCUMENT[harness].extension !== '.json')) {
    return undefined;
  }
  return parsedSettingsObject(entry.text);
};

/** One key the composed settings set, and the entry whose value survived for it. */
export interface FleetSettingsOrigin {
  /** The key as a person would write it into the file: `permissions.allow`, not `permissions`. */
  readonly key: string;
  /** {@link settingsEntryLabel} for the entry that supplied it. */
  readonly from: string;
}

/**
 * Merge one entry's object into the running origin map, EXACTLY as the daemon's merge would.
 *
 * The rule being followed is `deepMergeSettings`: nested plain objects merge key by key, and every
 * other value — scalar, array, null — replaces what was there wholesale. So an object arriving over a
 * scalar erases that key and contributes its own leaves, and a scalar arriving over an object erases
 * the whole subtree. Getting this approximately right would be worse than not showing it: the one
 * thing a person uses this list for is to find out which document won.
 */
const foldOrigins = (
  origins: Map<string, string>,
  object: Readonly<Record<string, unknown>>,
  from: string,
  prefix: string,
): void => {
  for (const [key, value] of Object.entries(object)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isPlainObject(value)) {
      origins.delete(path);
      foldOrigins(origins, value, from, path);
      continue;
    }
    for (const held of [...origins.keys()]) {
      if (held === path || held.startsWith(`${path}.`)) origins.delete(held);
    }
    origins.set(path, from);
  }
};

/**
 * WHICH ENTRY DECIDED EACH KEY, over the entries whose contents this screen knows.
 *
 * Alphabetical, because the list is read to look one key up rather than to be walked in order — and
 * because the insertion order a merge leaves behind is an implementation detail of the merge.
 */
export const settingsOrigins = (
  layer: FleetLayerDraft,
  harness: FleetHarnessKind | null,
): readonly FleetSettingsOrigin[] => {
  const origins = new Map<string, string>();
  for (const entry of layer.settings) {
    const object = knownSettingsObject(entry, harness);
    if (object !== undefined) foldOrigins(origins, object, settingsEntryLabel(entry), '');
  }
  return [...origins.entries()]
    .map(([key, from]) => ({ key, from }))
    .sort((left, right) => left.key.localeCompare(right.key));
};

/**
 * Entries whose contents this screen has NOT read, in the order they apply.
 *
 * Said out loud beside the key list, because a key list that silently omitted them would read as the
 * whole answer. A document this browser has not read may set anything, and where it sits in the order
 * is the only thing that can honestly be said about it.
 */
export const unreadSettings = (layer: FleetLayerDraft, harness: FleetHarnessKind | null): readonly string[] =>
  layer.settings
    .filter(entry => knownSettingsObject(entry, harness) === undefined)
    .map(entry => settingsEntryLabel(entry));

// ─── which step owns which problem ─────────────────────────────────────────────────────────────

/**
 * The step that can fix each blocker the draft has.
 *
 * A partition, not a filter: every sentence `accountProblems` produces is claimed by exactly one
 * step, and `ALL_STEP_PROBLEMS` proves it. The alternative — each step re-deriving its own rules —
 * is two descriptions of one grammar, and the way they drift is that the last step refuses a change
 * for a reason no earlier step would show.
 */
const ownedProblems: Readonly<
  Record<FleetStepId, (draft: FleetAccountDraft, config: FleetConfigView | null) => readonly string[]>
> = {
  // Nothing about the harness can be wrong: it is a closed choice with a preselected answer.
  harness: () => [],
  identity: (draft, config) => identityProblems(draft, config),
  models: draft => modelProblems(draft),
  instructions: draft => instructionsProblems(draft),
  skills: draft => skillsProblems(draft),
  settings: draft => settingsProblems(draft),
  // The recap owns nothing of its own. It shows everything, because that is what a recap is.
  review: () => [],
};

/**
 * The account's own identity: the name it is known by, and the lanes its modes derived.
 *
 * BOTH halves are the change model's sentences rather than restated here — the name grammar through
 * {@link accountNameProblems} and the lane set through {@link laneProblems}, including the one that
 * refuses an empty selection, which is this step's because this step holds the control. Ticking
 * nothing is the state the multi-select made reachable, and it has to block somewhere a person can
 * see the boxes. This file used to carry its own copy of the name chain; a copy is how the recap comes
 * to refuse a change for a reason no step would say.
 */
const identityProblems = (draft: FleetAccountDraft, config: FleetConfigView | null): readonly string[] => [
  ...accountNameProblems(draft),
  ...laneProblems(draft, config),
];

const modelProblems = (draft: FleetAccountDraft): readonly string[] => {
  const models = selectedModels(draft);
  const defaultModel = draft.defaultModel.trim();
  if (models.length === 0) return ['an available account must list at least one model it can serve'];
  if (defaultModel === '') return ['name the default model this account serves'];
  if (!models.includes(defaultModel)) return [`the default model "${defaultModel}" is not one of the models listed`];
  return [];
};

/**
 * The instructions document, and the one blocker that belongs to a step further back.
 *
 * A path derived from an account with no name yet is not a problem about instructions — it is the
 * missing NAME, which the identity step already says. `layerProblems` knows the distinction; this
 * passes it through rather than restating it.
 */
const instructionsProblems = (draft: FleetAccountDraft): readonly string[] => {
  const pending = draft.name.trim() === '';
  const path = draft.layer.instructions.path.trim();
  if (path === '') {
    return draft.layer.instructions.text !== '' && !pending ? ['name the file the instructions are written to'] : [];
  }
  const problem = assetPathProblem(path, 'the instructions path');
  // A path this change would write twice lands on THIS step rather than on skills or settings, because
  // the instructions document is the one a person is most likely to have retyped into another row by
  // mistake, and the sentence names both paths either way. Claimed by exactly one step: the partition
  // proof fails if two take it, which is why it is `pathsWrittenTwice` here and nowhere else.
  return [...(problem === null ? [] : [problem]), ...pathsWrittenTwice(draft.layer)];
};

const skillsProblems = (draft: FleetAccountDraft): readonly string[] => {
  const layer = draft.layer;
  const problems: string[] = [];
  const directory = layer.skillsDirectory.trim();
  if (directory === '') {
    if (layer.skills.length > 0) problems.push('name the skills directory these documents belong to');
  } else {
    const problem = assetPathProblem(directory, 'the skills directory');
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
    if (directory !== '' && !path.startsWith(`${directory}/`)) {
      problems.push(`"${path}" is not inside the skills directory "${directory}"`);
    }
  }
  return problems;
};

/** Inline settings and the environment table, which is the other thing this step holds. */
const settingsProblems = (draft: FleetAccountDraft): readonly string[] => {
  const owned = new Set([...instructionsProblems(draft), ...skillsProblems(draft)]);
  // Everything `layerProblems` reports that no earlier step claimed is a settings or environment
  // sentence. Derived rather than restated so the JSON and environment grammars have ONE owner.
  return layerProblems(draft.layer, { instructionsPathPending: draft.name.trim() === '' }).filter(
    problem => !owned.has(problem),
  );
};

/** The blockers this one step owns, in the order the draft produced them. */
export const stepProblems = (
  step: FleetStepId,
  draft: FleetAccountDraft,
  config: FleetConfigView | null,
): readonly string[] => ownedProblems[step](draft, config);

/**
 * Every step's problems, unioned.
 *
 * Exported so a test can assert it equals {@link accountProblems} for any draft: that assertion is
 * what makes the partition a partition rather than six lists that happen to look right today.
 */
export const ALL_STEP_PROBLEMS = (draft: FleetAccountDraft, config: FleetConfigView | null): readonly string[] =>
  FLEET_STEP_IDS.flatMap(step => stepProblems(step, draft, config));

/** Whether the whole draft is composable. The recap's own gate, and the surface's. */
export const draftIsComplete = (draft: FleetAccountDraft, config: FleetConfigView | null): boolean =>
  accountProblems(draft, config).length === 0;

/**
 * The step an asset-read blocker belongs on: the one whose field names that path.
 *
 * A `tree` blocker names a directory nobody enumerated and no edit can answer, so it belongs to the
 * recap, where it stops the change without pretending some earlier step could clear it.
 */
export const assetProblemStep = (entry: FleetUnreadableAsset, layer: FleetLayerDraft): FleetStepId => {
  if (entry.scope === 'tree') return 'review';
  if (entry.path === layer.instructions.path.trim()) return 'instructions';
  if (settingsPaths(layer).includes(entry.path)) return 'settings';
  return 'skills';
};

/**
 * Can a person leave this step?
 *
 * Only its own blockers, which is the rule the whole partition exists to serve. The recap is never
 * "advanceable" — there is nothing after it — so it answers for the whole draft instead.
 */
export const mayAdvance = (
  step: FleetStepId,
  draft: FleetAccountDraft,
  config: FleetConfigView | null,
  assetProblems: readonly string[] = [],
): boolean => stepProblems(step, draft, config).length === 0 && assetProblems.length === 0;
