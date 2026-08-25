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
  discoveredHarness,
  draftModels,
  existingAccounts,
  type FleetAccountDraft,
  type FleetAccountMode,
  type FleetLaneDraft,
  type FleetLayerDraft,
  type FleetUnreadableAsset,
  IMPORTED_INSTRUCTIONS_CHOICE,
  instructionsMiddleOf,
  instructionsPathFor,
  laneProblems,
  layerProblems,
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
    return `"${path}" is already in the store — pick "Use an existing one" to point at it, or choose another name`;
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

// ─── settings: a choice, not a mechanism ───────────────────────────────────────────────────────

/**
 * The settings question, with the mechanism kept underneath it.
 *
 * Settings in a fleet configuration are a STACK, deep-merged left to right, which is a real and
 * useful thing and the wrong thing to put in front of somebody adding their first account. The two
 * answers below are the two a person has: leave it alone, or set something. Choosing `own` writes
 * one inline object at the end of that stack; choosing `fleet` writes nothing, so every layer the
 * fleet already composes applies untouched. Neither answer can reorder the stack or remove a layer,
 * and the surface says so rather than offering a control that looks like it could.
 */
export type FleetSettingsChoice = 'fleet' | 'own';

/** Which answer the draft currently expresses. An empty box IS "leave the fleet's settings alone". */
export const settingsChoice = (layer: FleetLayerDraft): FleetSettingsChoice =>
  layer.settingsText.trim() === '' ? 'fleet' : 'own';

/**
 * The layer after answering it.
 *
 * Choosing `own` from empty seeds an empty JSON object rather than an empty box: a person who picked
 * "set something here" is looking at the box to type INTO, and `{}` both parses and shows them the
 * shape. Choosing `fleet` clears whatever was there, which is the only way back.
 */
export const withSettingsChoice = (layer: FleetLayerDraft, choice: FleetSettingsChoice): FleetLayerDraft => {
  if (choice === 'fleet') return { ...layer, settingsText: '' };
  return layer.settingsText.trim() === '' ? { ...layer, settingsText: '{}' } : layer;
};

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
  return [...(problem === null ? [] : [problem]), ...writtenTwice(draft.layer)];
};

/**
 * A path this change would write with two different texts.
 *
 * It lands on the instructions step rather than the skills one because the instructions document is
 * the path a person is most likely to have retyped into a skill row by mistake, and the sentence
 * names both. Claimed by ONE step either way: the partition proof would fail if both took it.
 */
const writtenTwice = (layer: FleetLayerDraft): readonly string[] => {
  const written = new Set<string>();
  const twice = new Set<string>();
  for (const path of [layer.instructions.path.trim(), ...layer.skills.map(skill => skill.path.trim())]) {
    if (path === '') continue;
    if (written.has(path)) twice.add(path);
    written.add(path);
  }
  return [...twice].map(path => `"${path}" is written twice by this change; one path carries one text`);
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
