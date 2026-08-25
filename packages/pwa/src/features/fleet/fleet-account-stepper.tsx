/**
 * Adding an account, one decision at a time.
 *
 * This replaces a single screen that asked for ten things at once — two of them named after
 * mechanisms only the configuration schema has a word for — with the sequence the owner sketched:
 * which harness, then next; what it is called and how it runs, then next; and so on to a recap.
 * The draft it edits, the problems it reports and the proposal it produces are all unchanged, so
 * the review-and-apply step behind it is exactly the one that was already there. Nothing is written
 * until that step runs.
 *
 * What the sequence buys, beyond being shorter to look at:
 *
 * - **A step that already knows its answer says so.** The harness step opens on what this host has
 *   installed; the model step opens on what the harness's own settings file names. Confirming is a
 *   tap, and the provenance line beside each says which parts filled themselves in.
 * - **"Next" is blocked by something on this screen.** {@link stepProblems} partitions the whole
 *   problem set by the step that can fix each sentence, so nobody is stopped by a field they cannot
 *   see.
 * - **Going back costs nothing.** Every step reads and writes the one draft the surface holds, so
 *   there is no per-step state that could be lost — which is what makes the back control safe to
 *   use rather than a thing to be careful about.
 *
 * The controls themselves are cards, not dropdowns. A `<select>` of thirty documents is a search
 * problem wearing the wrong control, so where there are few options they are shown, and where there
 * are many a filter appears above them.
 */

import type { FleetProfileCatalog, HarnessDiscoveryReport } from '@ferretry/protocol';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileText,
  KeyRound,
  Plus,
  Sparkles,
  Trash2,
  TriangleAlert,
  Users,
  Wand2,
  Wrench,
} from 'lucide-react';
import { useId, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import { FIELD_LABEL, PanelPath } from '../../shell/panel-typography.tsx';
import { RouteLink } from '../../shell/route-link.tsx';
import { HARNESS_SHARING } from './accounts-model.ts';
import type { FleetConfigView, FleetManifestAccountView } from './fleet-api.ts';
import { FleetProblems } from './fleet-change-forms.tsx';
import {
  derivedWrapper,
  draftProfiles,
  existingAccounts,
  type FleetAccountDraft,
  type FleetAccountMode,
  type FleetCredentialChoice,
  type FleetHarnessDetection,
  type FleetLayerDraft,
  type FleetPrefilledField,
  type FleetPrefillNotes,
  type FleetProfileDraft,
  type FleetProfileVariableDraft,
  type FleetUnreadableAsset,
  IMPORTED_INSTRUCTIONS_CHOICE,
  INSTRUCTIONS_PREFIX,
  newProfileProblems,
  profileVariableSourceLabel,
  unreadableAssetProblems,
} from './fleet-change-model.ts';
import { FleetCheckChoice, type FleetChoice, FleetChoiceGroup, FleetPickOrAdd } from './fleet-choice-group.tsx';
import { type FleetHarnessKind, fleetHarnessLabel } from './fleet-model.ts';
import { FleetSettingsOrder } from './fleet-settings-stack.tsx';
import {
  assetProblemStep,
  authoredSkill,
  composedProfileEnv,
  CREDENTIAL_CHOICE_COPY,
  customModelProblem,
  describeEnvShape,
  FLEET_ACCOUNT_MODES,
  FLEET_STEPS,
  type FleetInstructionsControl,
  type FleetPickOrAddSource,
  type FleetSettingsStoreItem,
  type FleetSkillsStoreItem,
  type FleetStepId,
  instructionsMiddle,
  instructionsNameProblem,
  laneForMode,
  MODE_EXPLANATION,
  modelOptions,
  newProfileDraft,
  newSettingsProblem,
  newSkillProblem,
  nextStep,
  otherLanes,
  OWN_DOCUMENT_CONSEQUENCE,
  previousStep,
  profileChoices,
  profilesAlreadyBound,
  profileVariablesFor,
  SETTINGS_DOCUMENT,
  SETTINGS_PREFIX,
  SHARED_DOCUMENT_CONSEQUENCE,
  SKILL_DOCUMENT,
  SKILLS_PREFIX,
  selectedModels,
  selectedModes,
  settingsEntryLabel,
  settingsFormatNote,
  settingsPathFor,
  settingsPaths,
  settingsStoreItems,
  skillsSelection,
  stepCopy,
  stepIndex,
  stepProblems,
  toggleMode,
  toggleModel,
  toggleProfile,
  unverifiedModels,
  withAuthoredSkillText,
  withInstructionsMiddle,
  withLaneVariant,
  withModels,
  withNewProfile,
  withNewSettings,
  withNewSkill,
  withProfileVariable,
  withProfileVariableAdded,
  withProfileVariableRemoved,
  withSkillsSelection,
  withStoreSettings,
} from './fleet-stepper-model.ts';

/** Above this many options a list stops being a list a person reads and becomes one they search. */
const FILTER_THRESHOLD = 6;

const SECTION = 'px-panel py-3';

/**
 * What each mode is called where a person reads it, rather than where a schema does.
 *
 * ONE table for all three of its jobs — the tick-card's title, the word that goes inside a sentence,
 * and what choosing it does — because they are one fact about one mode. Annotated over the modes so a
 * third one would be a compile error here rather than a control with a blank label beside it.
 */
const MODE_CARD: Readonly<
  Record<FleetAccountMode, { readonly label: string; readonly word: string; readonly detail: string }>
> = {
  interactive: { label: 'Interactive', word: 'interactive', detail: 'You drive it. Sessions wait for you.' },
  auto: { label: 'Auto', word: 'auto', detail: 'It runs unattended, without waiting for a person.' },
};

/** The provenance line a prefilled field carries, so a filled box is never mistaken for a typed one. */
function PrefillNote({ field, notes }: { readonly field: FleetPrefilledField; readonly notes: FleetPrefillNotes }) {
  const note = notes[field];
  if (note === undefined) return null;
  return (
    <p
      className="m-0 mt-1 flex min-w-0 items-start gap-1.5 text-meta leading-base text-muted"
      data-fleet-prefill={field}
    >
      <Wand2 size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
      <span className="min-w-0 break-words">{note}</span>
    </p>
  );
}

/**
 * Every marker in the strip, in one shape, so the loudest thing on it is where you ARE.
 *
 * Completed steps used to be `kt-btn`, and `kt-btn` carries the theme's `--label-transform` — so the
 * strip read `✓ 1. HARNESS ✓ 2. ACCOUNT ✓ 3. MODELS 4. Instructions`, shouting the past and
 * whispering the present. The fix stays LOCAL to this nav: that one custom property drives several
 * other roles (buttons, badges, tabs, section labels) and turning it off centrally would flatten all
 * of them. So the strip stops borrowing the button role rather than restyling it — a completed step
 * is a `<button>` because it is pressable, a current step is a `<span>` because it is not, and both
 * paint from the same class list.
 *
 * The height is the SAME token `kt-btn--sm` resolved to rather than a number, because that token is
 * pointer-derived — `max(24px, --target-floor)`, so it is a dense 24-30px under a mouse and the full
 * touch floor on a phone. Writing 44px here would have cleared the floor by deleting the density.
 */
const STEP_MARKER =
  'inline-flex min-h-[var(--control-h-sm)] min-w-0 items-center gap-1 rounded-control px-2 py-1 text-meta';

/**
 * Where in the sequence somebody is, and how to get back.
 *
 * An ordered list, because it is one: assistive technology gets the position and the total from the
 * markup rather than from a sentence, and `aria-current="step"` names the one they are on. Earlier
 * steps are buttons and later ones are not — going back is always safe, and skipping forward past a
 * question is the thing the sequence exists to prevent.
 */
function StepperProgress({
  current,
  onJump,
  disabled,
}: {
  readonly current: FleetStepId;
  readonly onJump: (step: FleetStepId) => void;
  readonly disabled: boolean;
}) {
  const at = stepIndex(current);
  return (
    <nav aria-label="Progress" className="border-b border-border-soft bg-surface-2 px-panel py-2">
      <ol className="m-0 flex min-w-0 list-none flex-wrap items-center gap-x-1 gap-y-1 p-0">
        {FLEET_STEPS.map((step, index) => {
          const done = index < at;
          const here = index === at;
          const label = `${String(index + 1)}. ${step.title}`;
          return (
            <li key={step.id} className="min-w-0">
              {done ? (
                <button
                  type="button"
                  className={cn(
                    STEP_MARKER,
                    'text-muted transition-colors hover:text-accent focus-visible:outline-focus focus-visible:outline-offset-focus disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none',
                  )}
                  data-fleet-step-jump={step.id}
                  disabled={disabled}
                  onClick={() => onJump(step.id)}
                >
                  <Check size={12} className="shrink-0" aria-hidden="true" />
                  {label}
                </button>
              ) : (
                <span
                  className={cn(STEP_MARKER, here ? 'bg-accent-soft font-semibold text-accent' : 'text-faint')}
                  data-fleet-step-marker={step.id}
                  {...(here ? { 'aria-current': 'step' as const } : {})}
                >
                  {label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** A card list with a filter that appears only once the list is long enough to need one. */
function FilteredChoices<T extends string>({
  legend,
  options,
  value,
  onChoose,
  disabled,
  name,
}: {
  readonly legend: string;
  readonly options: readonly FleetChoice<T>[];
  readonly value: T;
  readonly onChoose: (value: T) => void;
  readonly disabled: boolean;
  readonly name: string;
}) {
  const uid = useId();
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  // The SELECTED option always survives the filter. A control that hid what it currently holds would
  // show a group with nothing chosen, which is a different and false statement.
  const shown = options.filter(
    option => option.id === value || needle === '' || option.label.toLowerCase().includes(needle),
  );
  return (
    <div className="grid gap-2">
      {options.length > FILTER_THRESHOLD ? (
        <div>
          <label className={FIELD_LABEL} htmlFor={`${uid}-filter`}>
            Filter {String(options.length)} documents
          </label>
          <input
            id={`${uid}-filter`}
            className="kt-input font-mono"
            value={filter}
            disabled={disabled}
            placeholder="instructions/"
            data-fleet-choice-filter={name}
            onChange={event => setFilter(event.target.value)}
          />
        </div>
      ) : null}
      <FleetChoiceGroup
        legend={legend}
        options={shown}
        value={value}
        onChoose={onChoose}
        disabled={disabled}
        name={name}
        columns={1}
      />
      {shown.length === options.length ? null : (
        <p className="m-0 text-meta text-muted" data-fleet-choice-filtered={name}>
          Showing {String(shown.length)} of {String(options.length)}.
        </p>
      )}
    </div>
  );
}

export interface FleetAccountStepperProps {
  readonly draft: FleetAccountDraft;
  /**
   * Which step is on screen, held by the surface rather than by this component.
   *
   * CONTROLLED ON PURPOSE. The position in a sequence is part of what the person is composing, so it
   * belongs beside the draft the surface already holds: a component that owned it privately would
   * lose it to any re-render the surface performs for an unrelated reason, and could not be shown at
   * a chosen step by the gallery that proves each one fits a phone.
   */
  readonly step: FleetStepId;
  readonly onStep: (next: FleetStepId) => void;
  readonly onChange: (next: FleetAccountDraft) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
  readonly disabled: boolean;
  /** The asset listing this flow needs before it can judge a path is still in flight. */
  readonly loading: boolean;
  readonly detection: FleetHarnessDetection;
  readonly instructions: FleetInstructionsControl;
  /** Which of the three answers the instructions step is on, held by the surface beside the draft. */
  readonly instructionsSource: FleetPickOrAddSource;
  readonly onInstructionsSource: (next: FleetPickOrAddSource) => void;
  /**
   * Whether the account step is picking an existing login or adding one, held for the SAME reason.
   *
   * The two answers are indistinguishable in the draft — both produce a name, and the daemon merges on
   * the name whichever way it got there — so it cannot be re-derived. Deriving it would flip the answer
   * to "use that one" the moment somebody typed a name the fleet already has, hiding the box they are
   * typing into mid-keystroke; an answer a person gave is a fact about them, so it is kept.
   */
  readonly accountSource: FleetPickOrAddSource;
  readonly onAccountSource: (next: FleetPickOrAddSource) => void;
  /** Where the accounts page is, as a pathname the router built. Never a literal. */
  readonly accountsHref: string;
  readonly onNavigate?: (to: string) => void;
  /** Lanes this fleet declares. An account can only be added to one that exists. */
  readonly variants: readonly string[];
  readonly config: FleetConfigView | null;
  readonly discovery: HarnessDiscoveryReport | null;
  /** Accounts this fleet already publishes, read for the models they are already serving. */
  readonly published: readonly FleetManifestAccountView[];
  /** Skills directories the fleet's store offers, with who already links each one. */
  readonly skillsStore: readonly FleetSkillsStoreItem[];
  /** Instructions documents already in the store, which an account may point at instead of adding one. */
  readonly storeDocuments: readonly string[];
  /** Documents the daemon could not hand over, routed to the step whose field names each path. */
  readonly assetBlockers: readonly FleetUnreadableAsset[];
  /**
   * The profiles this fleet declares, in shapes. `null` until the read lands.
   *
   * Nullable rather than defaulted to an empty catalog, because the two states say different things: an
   * empty catalog is a fleet with no profiles, and `null` is a browser that has not asked yet. The
   * sign-in step blocks on two rules it cannot judge without one — see `credentialProblems` — and
   * pretending an unread catalog is an empty fleet would refuse a profile that is really there.
   */
  readonly profiles: FleetProfileCatalog | null;
}

export function FleetAccountStepper({
  draft,
  step,
  onStep,
  onChange,
  onSubmit,
  onCancel,
  disabled,
  loading,
  detection,
  instructions,
  instructionsSource,
  onInstructionsSource,
  accountSource,
  onAccountSource,
  accountsHref,
  onNavigate,
  variants,
  config,
  discovery,
  published,
  skillsStore,
  storeDocuments,
  assetBlockers,
  profiles,
}: FleetAccountStepperProps) {
  const uid = useId();
  const id = (name: string): string => `${uid}${name}`;
  const current = stepCopy(step);

  const blockersFor = (which: FleetStepId): readonly string[] =>
    unreadableAssetProblems(assetBlockers.filter(entry => assetProblemStep(entry, draft.layer) === which));
  const problemsHere = [...stepProblems(step, draft, config, profiles), ...blockersFor(step)];
  const everyProblem = FLEET_STEPS.flatMap(entry => [
    ...stepProblems(entry.id, draft, config, profiles),
    ...blockersFor(entry.id),
  ]);
  const last = step === 'review';
  const blocked = last ? everyProblem.length > 0 : problemsHere.length > 0;

  const setLayer = (layer: FleetLayerDraft): void => onChange({ ...draft, layer });

  return (
    <form
      data-fleet-account-stepper={step}
      aria-labelledby={id('-stepper-heading')}
      aria-busy={loading}
      onSubmit={event => {
        event.preventDefault();
        if (last) onSubmit();
        else onStep(nextStep(step));
      }}
    >
      <div className="border-b border-border-soft bg-surface-2 px-panel py-3">
        <h3 id={id('-stepper-heading')} className="m-0 text-title font-semibold text-fg">
          New account
        </h3>
        <p className="m-0 text-meta leading-base text-muted">
          The daemon mints the account id and derives the wrapper and home names. Nothing is written until you review
          and authorize the change.
        </p>
      </div>

      <StepperProgress current={step} onJump={onStep} disabled={disabled} />

      {loading ? (
        <p className="m-0 px-panel py-3 text-ui text-faint" data-fleet-account-loading="">
          Reading what is already in the asset tree…
        </p>
      ) : null}

      <section className={SECTION} aria-labelledby={id('-step-heading')}>
        <h4 id={id('-step-heading')} className="m-0 text-ui font-semibold text-fg" data-fleet-step-question={step}>
          {current.question}
        </h4>
      </section>

      <div className="border-t border-border-soft">
        {step === 'harness' ? (
          <HarnessStep draft={draft} onChange={onChange} disabled={disabled} detection={detection} />
        ) : null}
        {step === 'identity' ? (
          <IdentityStep
            draft={draft}
            onChange={onChange}
            disabled={disabled}
            variants={variants}
            config={config}
            source={accountSource}
            onSource={onAccountSource}
            accountsHref={accountsHref}
            {...(onNavigate === undefined ? {} : { onNavigate })}
          />
        ) : null}
        {step === 'credential' ? (
          <CredentialStep draft={draft} onChange={onChange} disabled={disabled} catalog={profiles} config={config} />
        ) : null}
        {step === 'models' ? (
          <ModelsStep
            draft={draft}
            onChange={onChange}
            disabled={disabled}
            discovery={discovery}
            published={published}
          />
        ) : null}
        {step === 'instructions' ? (
          <InstructionsStep
            draft={draft}
            onChange={onChange}
            disabled={disabled}
            instructions={instructions}
            source={instructionsSource}
            onSource={onInstructionsSource}
            assets={storeDocuments}
          />
        ) : null}
        {step === 'skills' ? (
          <SkillsStep layer={draft.layer} onChange={setLayer} disabled={disabled} store={skillsStore} />
        ) : null}
        {/* THE SETTINGS STORE IS DERIVED HERE rather than handed in like the skills one, and the
            difference is which document each is read out of. A skills item can be a directory sitting
            in the asset TREE that no route declares, so building that list needs the asset listing the
            surface holds. Every settings document this fleet has is named in the CONFIGURATION — by
            `shared.settings`, or by an account's own overlay — which this component already has, so a
            second prop would be a second copy of a derivation with one input. */}
        {step === 'settings' ? (
          <SettingsStep draft={draft} onChange={setLayer} disabled={disabled} store={settingsStoreItems(config)} />
        ) : null}
        {step === 'review' ? <ReviewStep draft={draft} variants={variants} /> : null}
      </div>

      <div className="border-t border-border-soft px-panel py-3">
        <FleetProblems problems={last ? everyProblem : problemsHere} />
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="kt-btn"
            data-variant="ghost"
            data-fleet-step-back=""
            disabled={disabled || step === 'harness'}
            onClick={() => onStep(previousStep(step))}
          >
            <ArrowLeft size={14} aria-hidden="true" />
            Back
          </button>
          <button type="submit" className="kt-btn" data-variant="primary" disabled={disabled || blocked}>
            {last ? 'Preview this change' : 'Next'}
            {last ? null : <ArrowRight size={14} aria-hidden="true" />}
          </button>
          <button type="button" className="kt-btn" data-variant="ghost" disabled={disabled} onClick={onCancel}>
            Discard draft
          </button>
        </div>
      </div>
    </form>
  );
}

// ─── the steps ─────────────────────────────────────────────────────────────────────────────────

function HarnessStep({
  draft,
  onChange,
  disabled,
  detection,
}: {
  readonly draft: FleetAccountDraft;
  readonly onChange: (next: FleetAccountDraft) => void;
  readonly disabled: boolean;
  readonly detection: FleetHarnessDetection;
}) {
  const options: readonly FleetChoice<FleetHarnessKind>[] = (['claude', 'codex'] as const).map(harness => ({
    id: harness,
    label: fleetHarnessLabel(harness),
    detail:
      harness === 'claude'
        ? 'Runs the claude command, reads CLAUDE.md and a settings.json.'
        : 'Runs the codex command, reads AGENTS.md and a config.toml.',
    ...(detection.harness === harness ? { badge: 'detected' } : {}),
  }));
  return (
    <div className={SECTION}>
      {/* WHAT THIS HOST HAS, before the choice below it is read as one. "Nothing installed" gets the
          warning treatment and its own attention rope: it is the state where every prefilled value
          further on describes a harness that cannot run here. */}
      <div
        className={cn(
          'mb-3 flex min-w-0 items-start gap-2 rounded-control p-3',
          detection.noneInstalled && 'bg-warn-bg',
        )}
        data-fleet-harness-detection={detection.noneInstalled ? 'none-installed' : 'detected'}
        {...(detection.noneInstalled ? { role: 'alert' } : {})}
      >
        {detection.noneInstalled ? (
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
        ) : (
          <Wand2 size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
        )}
        <p
          className={cn(
            'm-0 min-w-0 break-words text-meta leading-base',
            detection.noneInstalled ? 'text-warn' : 'text-muted',
          )}
        >
          {detection.detail}
        </p>
      </div>
      <FleetChoiceGroup
        legend="Harness"
        name="harness"
        options={options}
        value={draft.harness}
        disabled={disabled}
        onChoose={harness => onChange({ ...draft, harness })}
      />
    </div>
  );
}

/**
 * Which provider login this signs in as — picked from the ones this fleet has, or a new one.
 *
 * THE FREE-TEXT BOX WAS THE WHOLE GAP. Every other question on this screen was already a set of cards
 * over what exists; this one asked a person to retype the name of a login they already had, and got
 * nothing right that a picker gets right for free:
 *
 * - **It never checked.** The daemon merges a create into an agent with the same name and harness and
 *   refuses a slot that login already holds (`daemon/src/lib/fleet/mutations.ts`), and the browser
 *   compared nothing — so a typed name plus a mode that account already had walked all seven steps to
 *   a refusal knowable here. {@link laneProblems} now says it, and the cards below grey out the mode
 *   that earned it.
 * - **It hid the reason to reuse one.** One provider login serving several accounts is the reason
 *   ticking both modes exists at all, and a box asking for a name says nothing about it.
 * - **It could not say what the harnesses differ on.** {@link HARNESS_SHARING} already words that, and
 *   it is shown exactly where somebody is about to pick an existing Codex login for a second account.
 *
 * The link out is the OTHER half of the owner's rule — "an option to jump to the entity type" — and it
 * is deliberately not the add-new path. The accounts page signs an account in and says what its
 * provider last answered; it cannot mint a provider login, and its own "Add account" control links
 * back to this panel. So adding one is inline, and the link is for managing what is already there.
 */
function IdentityStep({
  draft,
  onChange,
  disabled,
  variants,
  config,
  source,
  onSource,
  accountsHref,
  onNavigate,
}: {
  readonly draft: FleetAccountDraft;
  readonly onChange: (next: FleetAccountDraft) => void;
  readonly disabled: boolean;
  readonly variants: readonly string[];
  readonly config: FleetConfigView | null;
  readonly source: FleetPickOrAddSource;
  readonly onSource: (next: FleetPickOrAddSource) => void;
  readonly accountsHref: string;
  readonly onNavigate?: (to: string) => void;
}) {
  const uid = useId();
  const id = (name: string): string => `${uid}${name}`;
  const spare = otherLanes(variants);
  const existing = existingAccounts(draft.harness, config);
  const held = existing.find(account => account.name === draft.name.trim());
  /**
   * The slot one mode would land in — the one it ALREADY holds where it is ticked, and the derived one
   * where it is not.
   *
   * Both cases are real. A person who moved the interactive account into this fleet's own `review` slot
   * and is now looking at the auto card must be told about `review`'s occupant, not about the slot the
   * mode would have derived; and an unticked card has no lane of its own to read.
   */
  const slotFor = (mode: FleetAccountMode): string =>
    draft.lanes.find(lane => lane.mode === mode)?.variant ?? laneForMode(mode, variants);
  const occupant = (mode: FleetAccountMode): string | undefined =>
    held?.taken.find(entry => entry.variant === slotFor(mode))?.wrapper;

  const nameBox = (
    <div>
      <label className={FIELD_LABEL} htmlFor={id('-account-name')}>
        {existing.length === 0 ? 'Provider account name' : 'Name the new account'}
      </label>
      <input
        id={id('-account-name')}
        className="kt-input font-mono"
        value={draft.name}
        disabled={disabled}
        placeholder="studio"
        onChange={event => onChange({ ...draft, name: event.target.value })}
      />
      {/* A name that is ALREADY a login on this fleet is not refused — the daemon merges into it, and
          that is a useful thing to do. It is simply not what "add a new one" says, so the note says
          which of the two this would actually be rather than letting somebody find out from the recap. */}
      <p className="m-0 mt-1 text-meta leading-base text-muted" data-fleet-account-name-note="">
        {held === undefined
          ? 'The account you sign in as. It becomes part of the wrapper name.'
          : `“${held.name}” is already on this fleet — this would add to that sign-in rather than making a new one.`}
      </p>
    </div>
  );

  const picker = (
    <div className="grid min-w-0 gap-2">
      {/* WHAT ONE SIGN-IN REACHES, per harness, in the words the accounts page already uses. This is
          the one place somebody is about to pick an existing Codex login for a second account, which
          is the case the two sentences exist to warn about. Read rather than reworded: a third set of
          words for a fact the fleet already states is how two screens come to disagree. */}
      <div
        className="flex min-w-0 items-start gap-2 rounded-control bg-surface-2 p-3"
        data-fleet-account-sharing={draft.harness}
      >
        <Users size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
        <p className="m-0 min-w-0 break-words text-meta leading-base text-muted">
          <span className="font-semibold text-fg">{HARNESS_SHARING[draft.harness].headline}</span>{' '}
          {HARNESS_SHARING[draft.harness].detail}
        </p>
      </div>
      <FleetChoiceGroup
        legend="Which one?"
        name="account"
        columns={1}
        value={draft.name.trim()}
        disabled={disabled}
        onChoose={name => onChange({ ...draft, name })}
        options={existing.map(account => ({
          id: account.name,
          label: account.name,
          detail:
            account.taken.length === 0
              ? 'Declared on this fleet with nothing running on it yet.'
              : `Already runs ${account.taken.map(entry => entry.wrapper).join(', ')}.`,
        }))}
      />
    </div>
  );

  return (
    <div className={cn(SECTION, 'grid gap-3')}>
      {existing.length === 0 ? (
        <>
          <p className="m-0 text-meta leading-base text-muted" data-fleet-account-none={draft.harness}>
            This fleet has no {fleetHarnessLabel(draft.harness)} account yet, so this is the first one.
          </p>
          {nameBox}
        </>
      ) : (
        <FleetPickOrAdd
          legend="Which account does this sign in as?"
          name="account"
          value={source}
          disabled={disabled}
          onChoose={onSource}
          answers={[
            {
              id: 'existing',
              detail: `${String(existing.length)} on this fleet. ${HARNESS_SHARING[draft.harness].headline}`,
            },
            { id: 'new', detail: 'A login this fleet does not have yet, named below and created with this account.' },
          ]}
          under={{ existing: picker, new: nameBox }}
        />
      )}

      {/* THE JUMP, and what it costs. A draft lives in this panel, so leaving for the accounts page
          discards it — a link that did not say so would be the one control on the screen that loses
          somebody's answers without warning. */}
      <p className="m-0 text-meta leading-base text-muted">
        <RouteLink
          to={accountsHref}
          {...(onNavigate === undefined ? {} : { onNavigate })}
          className="text-accent underline"
          data-fleet-accounts-link=""
        >
          Accounts
        </RouteLink>{' '}
        is where these are signed in and where what each provider last said is shown. Opening it leaves this draft
        behind.
      </p>

      <div>
        <label className={FIELD_LABEL} htmlFor={id('-display-name')}>
          Display name <span className="font-normal text-muted">(optional)</span>
        </label>
        <input
          id={id('-display-name')}
          className="kt-input"
          value={draft.displayName}
          disabled={disabled}
          placeholder="Studio Claude"
          onChange={event => onChange({ ...draft, displayName: event.target.value })}
        />
      </div>

      {/* ONE control where there used to be two, and now a MULTI-SELECT where there used to be one.
          `lane` and `mode` are still not the same field — the comment on `laneForMode` says what each
          one really is — but "both" is an ordinary answer, and it used to mean walking the whole
          sequence twice and retyping every other answer. Each ticked mode derives its own lane.

          A card whose slot the picked login ALREADY holds says so and is not offered, because the
          daemon would refuse it. Not offered only while it is UNTICKED, though: disabling a ticked one
          would leave somebody unable to untick their way out of a blocker they can read. */}
      <FleetCheckChoice
        legend="How does this account run?"
        name="mode"
        mono={false}
        options={FLEET_ACCOUNT_MODES.map(mode => {
          const wrapper = occupant(mode);
          const selected = selectedModes(draft).includes(mode);
          return {
            id: mode,
            label: MODE_CARD[mode].label,
            detail:
              wrapper === undefined
                ? MODE_CARD[mode].detail
                : `${MODE_CARD[mode].detail} This account already has one: ${wrapper}.`,
            ...(wrapper === undefined ? {} : { badge: 'already added' }),
            ...(wrapper !== undefined && !selected ? { disabled: true } : {}),
          };
        })}
        selected={selectedModes(draft)}
        disabled={disabled}
        onToggle={mode => onChange(toggleMode(draft, mode === 'auto' ? 'auto' : 'interactive', variants))}
        empty="No mode is offered, which should not be possible."
      />
      <p className="m-0 text-meta leading-base text-muted">{MODE_EXPLANATION}</p>

      {/* Offered ONLY because this fleet declares slots no mode would derive, and offered PER
          ACCOUNT: with two of them in play a single control would have no answer to "which one". A
          surface that cannot express what the configuration can is the reason somebody edits YAML by
          hand.

          CARDS, NOT A `<select>`. These were the last two native dropdowns in the sequence, three
          screens from an instructions step that already does this properly, and the owner's
          complaint about dropdowns did not stop applying because this control is conditional.

          "GROUP", NOT "LANE" OR "VARIANT". This is the only place a person meets the fleet's own
          slot names, and they are names somebody on this machine chose — so the cards say where each
          one came from and what it would produce, and no sentence underneath repeats it. A separate
          paragraph explaining that the offered one follows from how the account runs was three more
          lines saying exactly what every card already says on itself. */}
      {spare.length === 0
        ? null
        : draft.lanes.map(lane => (
            <div key={lane.mode} data-fleet-other-lanes={String(spare.length)} data-fleet-lane-mode={lane.mode}>
              <FleetChoiceGroup
                legend={`Which group does the ${MODE_CARD[lane.mode].word} account join?`}
                name={`group-${lane.mode}`}
                columns={1}
                value={lane.variant}
                disabled={disabled}
                onChoose={variant => onChange(withLaneVariant(draft, lane.mode, variant))}
                options={variants.map(variant => ({
                  id: variant,
                  label: variant,
                  detail: `${
                    variant === laneForMode(lane.mode, variants)
                      ? 'Picked from how this account runs.'
                      : 'Declared by this fleet.'
                  } Its wrapper would be ${derivedWrapper(draft, { mode: lane.mode, variant })}.`,
                }))}
              />
            </div>
          ))}
      {/* Every wrapper, before they leave the step. Ticking a second box creates a second account
          with its own wrapper and its own home, and a person who is not shown both finds that out
          from the recap at the earliest and from `fy fleet ls` at the latest.

          It names the MODE and stops there. "· interactive, lane default" spent its second half on a
          word this step exists to have removed, and on a fleet with no slots of its own the variant
          is derived from the mode it sits beside — so it said the same thing twice, in vocabulary
          nobody was taught. Where the fleet DOES declare its own, the cards above carry the name and
          the wrapper it produces. */}
      <div className="grid gap-1" data-fleet-derived-wrappers={String(draft.lanes.length)}>
        <p className="m-0 text-meta text-muted">
          {draft.lanes.length === 1
            ? 'Wrapper the daemon will derive:'
            : 'Wrappers the daemon will derive, one account each:'}
        </p>
        {draft.lanes.map(lane => (
          <p key={lane.mode} className="m-0 flex flex-wrap items-baseline gap-2 text-meta text-muted">
            <span className="min-w-0" data-fleet-derived-wrapper={lane.mode}>
              <PanelPath
                value={derivedWrapper(draft, lane)}
                className="text-meta text-fg"
                label={`Derived wrapper for the ${MODE_CARD[lane.mode].word} account`}
              />
            </span>
            <span>· {MODE_CARD[lane.mode].word}</span>
          </p>
        ))}
      </div>
    </div>
  );
}

/**
 * Whether this account signs in, or a profile authenticates it instead.
 *
 * THE OWNER'S QUESTION, ASKED. "If no login is wanted, then we can opt for no login and use env var
 * profiles" — so the two answers are offered side by side, and the second is a real choice on the screen
 * rather than something a person discovers by finding a YAML document. Everything under it follows the
 * same rule every other step follows: pick from what this fleet already has, stack several, or add one
 * that joins the collection for the next account.
 *
 * ## Values never appear here, in either direction
 *
 * The cards say what each profile SETS — a variable name, and whether the value comes from this daemon's
 * store, from the environment the wrapper runs in, or from the configuration. They never say what any of
 * it holds, because the daemon has no route that answers one: `docs/secrets.md` is the contract and a
 * getter added so this screen could show a value would delete the property it exists for. Writing a new
 * profile is the same discipline read backwards — a credential is named, never typed, so the thing this
 * form puts in the fleet configuration is the NAME of a secret and the value stays in the store.
 *
 * ## Precedence is on the screen, not in a document
 *
 * {@link composedProfileEnv} says, per variable, which slot supplied the value that won and which slots
 * it beat. A composed value whose origin cannot be explained is worse than no composition, and the
 * moment somebody needs the answer is while they are ticking the second profile — not after a round
 * trip. It is a projection of the one precedence chain the fleet package owns; the module comment on
 * that function says exactly which slots a new account has and why the rest are absent.
 */
function CredentialStep({
  draft,
  onChange,
  disabled,
  catalog,
  config,
}: {
  readonly draft: FleetAccountDraft;
  readonly onChange: (next: FleetAccountDraft) => void;
  readonly disabled: boolean;
  readonly catalog: FleetProfileCatalog | null;
  readonly config: FleetConfigView | null;
}) {
  const uid = useId();
  const id = (name: string): string => `${uid}${name}`;
  const offered = profileChoices(catalog);
  const chosen = draftProfiles(draft);
  const authored = draft.newProfile;
  const bound = profilesAlreadyBound(catalog, draft, config);
  const composed = composedProfileEnv(catalog, draft);

  const cards: readonly FleetChoice<string>[] = [
    ...offered.map(profile => {
      const variables = profileVariablesFor(profile, draft.harness);
      const signsIn = profile.authenticates.includes(draft.harness);
      const sets =
        variables.length === 0
          ? 'Sets nothing for this harness.'
          : `Sets ${variables.map(entry => entry.variable).join(', ')}.`;
      const used =
        profile.accounts.length === 0
          ? 'Nothing uses it yet.'
          : `Also used by ${profile.accounts.join(', ')} — editing it reaches them too.`;
      return {
        id: profile.name,
        label: profile.name,
        detail: `${sets} ${used}`,
        ...(signsIn ? { badge: 'no login needed' } : {}),
      };
    }),
    // The profile being WRITTEN is a card too, so the order a person reads is the whole order rather
    // than a list plus a hidden extra — the same reason the skills step offers its authored skill.
    ...(authored === undefined
      ? []
      : [
          {
            id: authored.name.trim() === '' ? '' : authored.name.trim(),
            label: authored.name.trim() === '' ? 'This new profile' : authored.name.trim(),
            detail: 'Written below and declared by this change. The next account you add can pick it.',
            badge: 'new',
          },
        ]),
  ];

  return (
    <div className={cn(SECTION, 'grid gap-3')}>
      <FleetChoiceGroup
        legend="How does this account authenticate?"
        name="credential"
        columns={1}
        value={draft.credential}
        disabled={disabled}
        onChoose={(credential: FleetCredentialChoice) => onChange({ ...draft, credential })}
        options={(['login', 'profile'] as const).map(choice => ({
          id: choice,
          label: CREDENTIAL_CHOICE_COPY[choice].label,
          detail: CREDENTIAL_CHOICE_COPY[choice].detail,
        }))}
      />

      {draft.credential === 'login' ? (
        <p className="m-0 text-meta leading-base text-muted" data-fleet-credential-login="">
          {bound.length === 0
            ? 'Signing in happens on the Accounts screen, once, for this login — every account on it is then usable.'
            : `This login already uses ${bound.join(', ')}, and leaving this answer alone keeps it that way.`}
        </p>
      ) : (
        <>
          {/* WHAT TICKING THESE REACHES. Profiles belong to a provider LOGIN, so a login serving two
              accounts composes one list for both — which is the same property that makes signing in
              once enough for both. Somebody adding a second account to an existing login has to be
              told that before they tick, not after the plan says so. */}
          {bound.length === 0 ? null : (
            <div
              className="flex min-w-0 items-start gap-2 rounded-control bg-surface-2 p-3"
              data-fleet-profiles-bound={String(bound.length)}
            >
              <Users size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
              <p className="m-0 min-w-0 break-words text-meta leading-base text-muted">
                <span className="font-semibold text-fg">
                  “{draft.name.trim()}” already uses {bound.join(', ')}.
                </span>{' '}
                Profiles belong to the login rather than to one account, so what you tick here applies to every account
                on it.
              </p>
            </div>
          )}

          <FleetCheckChoice
            legend="Profiles this fleet already has"
            name="profiles"
            options={cards}
            selected={chosen}
            disabled={disabled}
            empty="This fleet declares no profiles yet. Write the first one below — the next account you add can pick it."
            onToggle={name => onChange(toggleProfile(draft, name))}
          />

          {authored === undefined ? (
            <div>
              <button
                type="button"
                className="kt-btn"
                data-fleet-add-profile=""
                disabled={disabled}
                onClick={() => onChange(withNewProfile(draft, newProfileDraft(draft, catalog, crypto.randomUUID())))}
              >
                <Plus size={14} aria-hidden="true" />
                Add a new profile
              </button>
              <p className="m-0 mt-1 text-meta leading-base text-muted">
                Declared by this change and added to this fleet, so every later account can pick it.
              </p>
            </div>
          ) : (
            <NewProfileForm
              draft={draft}
              profile={authored}
              onChange={onChange}
              disabled={disabled}
              catalog={catalog}
            />
          )}

          {/* WHICH VALUE WINS, before the round trip rather than after it. The vocabulary is the
              daemon's own — "the base profile", "the profile X", "this account" — because a sentence
              explaining where somebody's API key came from is the last place to introduce a second one. */}
          {composed.length === 0 ? null : (
            <div>
              <p className="m-0 mb-1 text-cell font-medium text-fg">These apply in order</p>
              <ul className="m-0 list-none space-y-1 p-0" data-fleet-composed-env={String(composed.length)}>
                {composed.map(row => (
                  <li
                    key={row.variable}
                    className="min-w-0 rounded-control bg-surface-2 px-3 py-2"
                    data-fleet-composed-variable={row.variable}
                  >
                    <p className="m-0 min-w-0 break-words font-mono text-meta text-fg">{row.variable}</p>
                    <p className="m-0 min-w-0 break-words text-meta leading-base text-muted">
                      {describeEnvShape(row.shape)} · set by {row.from}
                      {row.overrode.length === 0 ? '' : `, overriding ${row.overrode.join(' and ')}`}
                    </p>
                  </li>
                ))}
              </ul>
              <p className="m-0 mt-1 text-meta leading-base text-muted" data-fleet-composed-note="">
                A variable set by more than one of these takes the value of the last one. Nothing on this screen can
                show you a value: a credential lives in this daemon’s secret store and reaches only the account’s own
                session.
              </p>
            </div>
          )}
        </>
      )}
      <p className="sr-only" id={id('-credential-help')}>
        A profile authenticates this account instead of a sign-in.
      </p>
    </div>
  );
}

/**
 * Writing a profile, which is the "add a new one" half of the owner's rule.
 *
 * A CREDENTIAL IS NAMED, NEVER TYPED. The secret answer takes the NAME of a secret in this daemon's
 * store — the value is set once with `fy secret set`, on the host, and no screen in this product has a
 * box for it. The plain-value answer exists because a gateway profile is a base URL as well as a key,
 * and it carries the consequence on the control: what is typed there goes into the fleet configuration
 * as text, which is exactly where a credential must not be.
 *
 * The three answers are the three spellings the daemon accepts and nothing else, which is what stops
 * somebody typing `${secret:work_key}` into a value box — a near miss the grammar does not match, that
 * would stay a literal and authenticate the harness with the reference itself.
 */
function NewProfileForm({
  draft,
  profile,
  onChange,
  disabled,
  catalog,
}: {
  readonly draft: FleetAccountDraft;
  readonly profile: FleetProfileDraft;
  readonly onChange: (next: FleetAccountDraft) => void;
  readonly disabled: boolean;
  readonly catalog: FleetProfileCatalog | null;
}) {
  const uid = useId();
  const id = (name: string): string => `${uid}${name}`;
  const set = (next: FleetProfileDraft): void => onChange(withNewProfile(draft, next));
  const problems = newProfileProblems(
    profile,
    (catalog?.profiles ?? []).map(entry => entry.name),
  );
  return (
    <div className="grid min-w-0 gap-3 rounded-control border border-border p-3" data-fleet-new-profile="">
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <label className={FIELD_LABEL} htmlFor={id('-profile-name')}>
            Name this profile
          </label>
          <input
            id={id('-profile-name')}
            className="kt-input font-mono"
            value={profile.name}
            disabled={disabled}
            placeholder="work"
            data-fleet-profile-name=""
            onChange={event => set({ ...profile, name: event.target.value })}
          />
        </div>
        <button
          type="button"
          className="kt-btn"
          data-variant="ghost"
          data-fleet-discard-profile=""
          disabled={disabled}
          onClick={() => onChange(withNewProfile(draft, undefined))}
        >
          Discard
        </button>
      </div>

      <ul className="m-0 list-none space-y-3 p-0" aria-label="Variables this profile sets">
        {profile.variables.map((row, index) => (
          <li key={row.id} className="grid min-w-0 gap-2 border-t border-border-soft pt-3 first:border-t-0 first:pt-0">
            <div className="flex min-w-0 flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1">
                <label className={FIELD_LABEL} htmlFor={id(`-profile-variable-${String(index)}`)}>
                  Variable
                </label>
                <input
                  id={id(`-profile-variable-${String(index)}`)}
                  className="kt-input font-mono"
                  value={row.variable}
                  disabled={disabled}
                  placeholder="ANTHROPIC_API_KEY"
                  data-fleet-profile-variable={String(index)}
                  onChange={event => set(withProfileVariable(profile, row.id, { variable: event.target.value }))}
                />
              </div>
              {profile.variables.length === 1 ? null : (
                <button
                  type="button"
                  className="kt-btn"
                  data-variant="ghost"
                  data-fleet-remove-profile-variable={String(index)}
                  disabled={disabled}
                  onClick={() => set(withProfileVariableRemoved(profile, row.id))}
                >
                  <Trash2 size={14} aria-hidden="true" />
                  Remove
                </button>
              )}
            </div>
            <FleetChoiceGroup
              legend="Where does its value come from?"
              name={`profile-source-${String(index)}`}
              columns={1}
              value={row.from}
              disabled={disabled}
              onChoose={(from: FleetProfileVariableDraft['from']) =>
                set(withProfileVariable(profile, row.id, { from }))
              }
              options={PROFILE_SOURCE_ANSWERS.map(answer => ({
                id: answer,
                label: profileVariableSourceLabel(answer),
                detail: PROFILE_SOURCE_DETAIL[answer],
              }))}
            />
            <div>
              <label className={FIELD_LABEL} htmlFor={id(`-profile-detail-${String(index)}`)}>
                {PROFILE_SOURCE_FIELD[row.from]}
              </label>
              <input
                id={id(`-profile-detail-${String(index)}`)}
                className="kt-input font-mono"
                value={row.detail}
                disabled={disabled}
                placeholder={PROFILE_SOURCE_PLACEHOLDER[row.from]}
                data-fleet-profile-detail={String(index)}
                onChange={event => set(withProfileVariable(profile, row.id, { detail: event.target.value }))}
              />
            </div>
          </li>
        ))}
      </ul>

      <div>
        <button
          type="button"
          className="kt-btn kt-btn--sm"
          data-fleet-add-profile-variable=""
          disabled={disabled}
          onClick={() => set(withProfileVariableAdded(profile, crypto.randomUUID()))}
        >
          <Plus size={14} aria-hidden="true" />
          Add another variable
        </button>
      </div>

      {/* The problems are shown HERE as well as under the step, because this form is the only place
          they can be acted on and a person scrolled into it should not have to find them below. */}
      <FleetProblems problems={problems} />
    </div>
  );
}

/** The three spellings, in the order the form offers them: the credential first, because that is why. */
const PROFILE_SOURCE_ANSWERS: readonly FleetProfileVariableDraft['from'][] = ['secret', 'environment', 'value'];

const PROFILE_SOURCE_DETAIL: Readonly<Record<FleetProfileVariableDraft['from'], string>> = {
  secret:
    'Named here, set once on the host with fy secret set. The value never reaches this browser or the fleet file.',
  environment: 'Read from whatever launches the wrapper. Nothing on this host has to hold it.',
  value: 'Written into the fleet configuration as text and exported by the wrapper. Never a credential.',
};

const PROFILE_SOURCE_FIELD: Readonly<Record<FleetProfileVariableDraft['from'], string>> = {
  secret: 'Secret name',
  environment: 'Variable to read',
  value: 'Value',
};

const PROFILE_SOURCE_PLACEHOLDER: Readonly<Record<FleetProfileVariableDraft['from'], string>> = {
  secret: 'WORK_KEY',
  environment: 'WORK_KEY',
  value: 'https://gateway.example.internal',
};

function ModelsStep({
  draft,
  onChange,
  disabled,
  discovery,
  published,
}: {
  readonly draft: FleetAccountDraft;
  readonly onChange: (next: FleetAccountDraft) => void;
  readonly disabled: boolean;
  readonly discovery: HarnessDiscoveryReport | null;
  readonly published: readonly FleetManifestAccountView[];
}) {
  const uid = useId();
  const id = (name: string): string => `${uid}${name}`;
  const [custom, setCustom] = useState('');
  const options = modelOptions(draft.harness, discovery, published);
  const chosen = selectedModels(draft);
  const unverified = unverifiedModels(draft, options);
  // Anything typed is offered as a card too, so the selection is one list rather than a list plus a
  // hidden extra. It carries the marker that says nothing here could check it.
  const cards: readonly FleetChoice<string>[] = [
    ...options.map(option => ({
      id: option.id,
      label: option.displayName === undefined ? option.id : `${option.id} — ${option.displayName}`,
      detail: option.detail,
      ...(option.verified ? {} : { badge: 'unverified' }),
    })),
    ...chosen
      .filter(model => !options.some(option => option.id === model))
      .map(model => ({
        id: model,
        label: model,
        detail: 'Typed here. Nothing on this host names it, so it could not be checked.',
        badge: 'unverified',
      })),
  ];
  const customProblem = customModelProblem(custom, draft);
  const addCustom = (): void => {
    if (customProblem !== null) return;
    onChange(withModels(draft, [...chosen, custom.trim()]));
    setCustom('');
  };
  return (
    <div className={cn(SECTION, 'grid gap-3')}>
      <FleetCheckChoice
        legend="Models this account may serve"
        name="models"
        options={cards}
        selected={chosen}
        disabled={disabled}
        onToggle={model => onChange(toggleModel(draft, model))}
        empty="Nothing on this host names a model for this harness, and this fleet publishes none for it. Add the identifier your provider uses below."
      />
      <PrefillNote field="models" notes={draft.prefilled} />

      <div>
        <label className={FIELD_LABEL} htmlFor={id('-custom-model')}>
          Add another model
        </label>
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          <input
            id={id('-custom-model')}
            className="kt-input min-w-0 flex-1 font-mono"
            value={custom}
            disabled={disabled}
            placeholder="claude-opus-5"
            data-fleet-custom-model=""
            onChange={event => setCustom(event.target.value)}
          />
          <button
            type="button"
            className="kt-btn"
            data-fleet-add-model=""
            disabled={disabled || customProblem !== null}
            onClick={addCustom}
          >
            <Plus size={14} aria-hidden="true" />
            Add
          </button>
        </div>
        <p className="m-0 mt-1 text-meta text-muted" data-fleet-custom-model-note="">
          {custom.trim() === ''
            ? 'Running something we have not heard of is fine. It is added as unverified — nothing here can check a provider’s model list.'
            : (customProblem ?? `"${custom.trim()}" will be added and marked unverified.`)}
        </p>
      </div>

      {unverified.length === 0 ? null : (
        <p className="m-0 text-meta leading-base text-muted" data-fleet-unverified={String(unverified.length)}>
          Unverified: {unverified.join(', ')}. Nothing on this host names these, so a session using one may fail to
          start.
        </p>
      )}

      {/* THE LAST `<select>` IN THE SEQUENCE, now the same cards as everything above it.
          It was a dropdown of two entries sitting directly beneath the two tick-cards those entries
          came from — the owner's "the model list is pretty bad" survived in the one control on the
          step that still hid its options behind a tap.

          The cards are the TICKED models and nothing else, so this list cannot name something the
          account does not serve, and each says what choosing it does rather than repeating where
          the model was found — that sentence is already on its tick-card a few rows up. With nothing
          ticked there is no choice to offer, so the group is replaced by the sentence that says what
          to do first. */}
      <div>
        {chosen.length === 0 ? (
          <>
            <p className="m-0 mb-1 text-cell font-medium text-fg">Default model</p>
            <p className="m-0 text-meta leading-base text-muted" data-fleet-default-model-empty="">
              Tick a model above and it becomes the default.
            </p>
          </>
        ) : (
          <FleetChoiceGroup
            legend="Default model"
            name="default-model"
            columns={1}
            value={draft.defaultModel}
            disabled={disabled}
            onChoose={defaultModel => onChange({ ...draft, defaultModel })}
            options={chosen.map(model => ({
              id: model,
              label: model,
              detail: `A session that names no model runs on ${model}.`,
            }))}
          />
        )}
        {/* "Served when a caller names none" is on every card now, so the note keeps only the part
            the cards cannot say: why one is already chosen. */}
        <p className="m-0 mt-1 text-meta leading-base text-muted">Picked for you when you choose the first model.</p>
      </div>
    </div>
  );
}

/**
 * Where this account's instructions come from — and all three answers end in the same place.
 *
 * The account POINTS AT a named document in the fleet's store. "Use an existing one" points at what
 * is already there; "Import" copies this host's own `CLAUDE.md` / `AGENTS.md` into the store under a
 * name the person picks and points at that; "Write a new one" makes an empty document under a chosen
 * name and points at that. Import and write-new differ only in what the first draft of the text is,
 * which is why they share one name field rather than being two unrelated flows.
 *
 * The prefix is fixed and the middle is theirs. `CLAUDE-` follows from the harness, so nobody is
 * asked to choose it, and a store somebody can read beats a store full of `CLAUDE (1).md`.
 */
function InstructionsStep({
  draft,
  onChange,
  disabled,
  instructions,
  source,
  onSource,
  assets,
}: {
  readonly draft: FleetAccountDraft;
  readonly onChange: (next: FleetAccountDraft) => void;
  readonly disabled: boolean;
  readonly instructions: FleetInstructionsControl;
  readonly source: FleetPickOrAddSource;
  readonly onSource: (next: FleetPickOrAddSource) => void;
  /** Documents already in the store that an account could point at. */
  readonly assets: readonly string[];
}) {
  const uid = useId();
  const id = (name: string): string => `${uid}${name}`;
  const middle = instructionsMiddle(draft);
  const nameProblem = instructionsNameProblem(middle, draft.harness, assets);
  const importable = instructions.choices.some(choice => choice.value === IMPORTED_INSTRUCTIONS_CHOICE);
  const importDetail =
    instructions.choices.find(choice => choice.value === IMPORTED_INSTRUCTIONS_CHOICE)?.detail ??
    'This host has no instructions document for this harness to copy.';
  const existingCards: readonly FleetChoice<string>[] = assets.map(path => ({
    id: path,
    label: path,
    detail: SHARED_DOCUMENT_CONSEQUENCE,
  }));
  /**
   * ONE name box, shared by both add-new answers.
   *
   * Import and write-new differ only in where the first draft of the text comes from, so they are the
   * same naming question — which is why this is a value handed to two slots rather than two controls.
   */
  const nameBox = (
    <div>
      <label className={FIELD_LABEL} htmlFor={id('-middle')}>
        Name this document
      </label>
      {/* The prefix is rendered as part of the control rather than typed, so what a person reads
          is the whole filename and what they edit is only the part that is theirs. */}
      <div className="flex min-w-0 items-stretch">
        <span
          className="inline-flex shrink-0 items-center rounded-l-control border border-r-0 border-border bg-surface-3 px-2 font-mono text-meta text-muted"
          data-fleet-instructions-prefix=""
        >
          {INSTRUCTIONS_PREFIX[draft.harness]}
        </span>
        <input
          id={id('-middle')}
          className="kt-input min-w-0 flex-1 rounded-l-none font-mono"
          value={middle}
          disabled={disabled}
          placeholder="auto"
          data-fleet-instructions-middle=""
          onChange={event => onChange(withInstructionsMiddle(draft, event.target.value))}
        />
        <span
          className="inline-flex shrink-0 items-center rounded-r-control border border-l-0 border-border bg-surface-3 px-2 font-mono text-meta text-muted"
          aria-hidden="true"
        >
          .md
        </span>
      </div>
      <p className="m-0 mt-1 break-words text-meta leading-base text-muted" data-fleet-instructions-name-note="">
        {nameProblem ?? `Added to the store as ${draft.layer.instructions.path.trim()}.`}
      </p>
      <PrefillNote field="instructionsPath" notes={draft.prefilled} />
    </div>
  );
  return (
    <div className={cn(SECTION, 'grid gap-3')}>
      <div className="flex min-w-0 items-start gap-2">
        <FileText size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
        <p className="m-0 min-w-0 text-meta leading-base text-muted">
          A document in this fleet’s store, copied into the account’s home as its CLAUDE.md / AGENTS.md. Whichever of
          the three you pick, this account ends up POINTING AT one named document.
        </p>
      </div>

      {/* A DECLARED GAP, said where somebody is standing rather than left to be discovered. This step
          composes ONE document, so every account this pass creates points at it. The default fleet
          gives each lane its own for a real reason — "never stop and ask" is right in exactly one of
          them — and a document per lane is a redesign of this step, not something to imply here. */}
      {draft.lanes.length < 2 ? null : (
        <p className="m-0 text-meta leading-base text-warn" data-fleet-shared-instructions="">
          Both accounts read this one document. A separate document per account is not offered here — add it after, from
          the account’s own editor.
        </p>
      )}

      <FleetPickOrAdd
        legend="Where do its instructions come from?"
        name="instructions"
        value={source}
        disabled={disabled}
        onChoose={onSource}
        answers={[
          {
            id: 'existing',
            detail:
              assets.length === 0
                ? 'Nothing in the store yet — import or write one below.'
                : `${String(assets.length)} to choose from. ${SHARED_DOCUMENT_CONSEQUENCE}`,
            disabled: assets.length === 0,
          },
          {
            id: 'import',
            detail: importDetail,
            disabled: !importable,
            ...(importable ? { badge: 'detected' } : {}),
          },
          { id: 'new', detail: 'An empty document, named below, added to the store.' },
        ]}
        under={{
          existing: (
            <FilteredChoices
              legend="Which document?"
              name="instructions"
              options={existingCards}
              value={draft.layer.instructions.path.trim()}
              disabled={disabled}
              onChoose={path => instructions.onChoose(`asset:${path}`)}
            />
          ),
          import: nameBox,
          new: nameBox,
        }}
      />

      {instructions.loading ? (
        <p className="m-0 text-meta text-faint" data-fleet-instructions-reading="">
          Reading that document’s current text…
        </p>
      ) : null}

      <div>
        <label className={FIELD_LABEL} htmlFor={id('-text')}>
          Contents
        </label>
        <textarea
          id={id('-text')}
          className="kt-input min-h-[9rem] font-mono"
          rows={8}
          value={draft.layer.instructions.text}
          disabled={disabled}
          onChange={event =>
            onChange({
              ...draft,
              layer: { ...draft.layer, instructions: { ...draft.layer.instructions, text: event.target.value } },
            })
          }
        />
        <PrefillNote field="instructionsText" notes={draft.prefilled} />
      </div>
    </div>
  );
}

/**
 * Which skills this account gets — the ones this fleet already has, or one written here.
 *
 * THE MODELS SHAPE, not the instructions one, and that is a decision rather than an accident. This is
 * an OPTIONAL SET: an account with no skills is an ordinary account, and "none" is an answer somebody
 * gives by ticking nothing. Putting it behind a radio group would have needed a fourth answer whose
 * only job is to escape a control that should not have been a radio — so it is tick-cards over what
 * exists plus an inline add beneath them, exactly as the models step does, which is the owner's rule
 * with the same two halves.
 *
 * WHAT THIS REPLACES was half the rule: the cards were here, and the empty case said "add one from the
 * asset tree first" — sending a person out of the sequence to a file browser to do the thing the step
 * is for. A skill written here is added to the store on the same reviewed apply, so the NEXT account
 * created can tick it, which is the "auto add it to the entity type" half.
 */
function SkillsStep({
  layer,
  onChange,
  disabled,
  store,
}: {
  readonly layer: FleetLayerDraft;
  readonly onChange: (next: FleetLayerDraft) => void;
  readonly disabled: boolean;
  readonly store: readonly FleetSkillsStoreItem[];
}) {
  const uid = useId();
  const id = (name: string): string => `${uid}${name}`;
  const [middle, setMiddle] = useState('');
  const selection = skillsSelection(layer);
  const authored = authoredSkill(layer);
  const cards: readonly FleetChoice<string>[] = [
    ...store.map(item => ({
      id: item.path,
      label: item.path,
      detail:
        item.accounts.length === 0
          ? `In the store, linked by nothing yet. ${SHARED_DOCUMENT_CONSEQUENCE}`
          : `Linked by ${item.accounts.join(', ')}. ${SHARED_DOCUMENT_CONSEQUENCE}`,
    })),
    // The skill being WRITTEN is offered as a card too, so the selection is one list rather than a
    // list plus a hidden extra — the same reason the models step offers a typed identifier as a card.
    // Unticking it is also the only way back to an account with no skills at all.
    ...(authored === undefined
      ? []
      : [
          {
            id: layer.skillsDirectory.trim(),
            label: layer.skillsDirectory.trim(),
            detail: `Written below and added to this fleet’s store by this change. ${OWN_DOCUMENT_CONSEQUENCE}`,
            badge: 'new',
          },
        ]),
  ];
  const problem = newSkillProblem(middle, store, layer);
  const add = (): void => {
    if (problem !== null) return;
    onChange(withNewSkill(layer, middle, crypto.randomUUID()));
    setMiddle('');
  };
  return (
    <div className={cn(SECTION, 'grid gap-3')}>
      <div className="flex min-w-0 items-start gap-2">
        <Sparkles size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
        <p className="m-0 min-w-0 text-meta leading-base text-muted">
          Skills come from the fleet’s store. Ticking one links this account to it; every document in it is copied into
          the account’s home on the next apply. Ticking nothing is fine — an account with no skills is an ordinary
          account.
        </p>
      </div>
      <FleetCheckChoice
        legend="Skills this fleet already has"
        name="skills"
        options={cards}
        selected={selection.selected}
        disabled={disabled}
        empty="This fleet’s store has no skills yet. Write the first one below, or leave this account without skills."
        onToggle={path => onChange(withSkillsSelection(layer, selection.selected.includes(path) ? [] : [path]))}
      />

      {/* ADD ONE HERE, which is the half that was missing. The prefix is rendered rather than typed,
          so what a person reads is the whole path and what they edit is only the part that is theirs —
          the same control the instructions step uses for the same reason. */}
      <div>
        <label className={FIELD_LABEL} htmlFor={id('-new-skill')}>
          Add a new skill
        </label>
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          <div className="flex min-w-0 flex-1 items-stretch">
            <span
              className="inline-flex shrink-0 items-center rounded-l-control border border-r-0 border-border bg-surface-3 px-2 font-mono text-meta text-muted"
              data-fleet-skill-prefix=""
            >
              {SKILLS_PREFIX}
            </span>
            <input
              id={id('-new-skill')}
              className="kt-input min-w-0 flex-1 rounded-l-none font-mono"
              value={middle}
              disabled={disabled}
              placeholder="review"
              data-fleet-new-skill=""
              onChange={event => setMiddle(event.target.value)}
            />
          </div>
          <button
            type="button"
            className="kt-btn"
            data-fleet-add-skill=""
            disabled={disabled || problem !== null}
            onClick={add}
          >
            <Plus size={14} aria-hidden="true" />
            Add
          </button>
        </div>
        <p className="m-0 mt-1 break-words text-meta leading-base text-muted" data-fleet-new-skill-note="">
          {middle.trim() === ''
            ? `A new directory in the store with a ${SKILL_DOCUMENT} in it, written by this change. The next account you create can tick it.`
            : (problem ?? `${SKILLS_PREFIX}${middle.trim()}/${SKILL_DOCUMENT} will be added to the store.`)}
        </p>
      </div>

      {authored === undefined ? null : (
        <div data-fleet-authored-skill={authored.path}>
          <label className={FIELD_LABEL} htmlFor={id('-skill-text')}>
            Contents
          </label>
          <textarea
            id={id('-skill-text')}
            className="kt-input min-h-[9rem] font-mono"
            rows={8}
            value={authored.text}
            disabled={disabled}
            onChange={event => onChange(withAuthoredSkillText(layer, event.target.value))}
          />
          <p className="m-0 mt-1 flex min-w-0 flex-wrap items-baseline gap-1 text-meta leading-base text-muted">
            Written to <PanelPath value={authored.path} className="text-meta text-fg" label="New skill document" /> on
            the next apply.
          </p>
        </div>
      )}

      {/* A DECLARED LIMIT OF THIS SCREEN, and it is careful about whose limit it is.
          `layer.skills` became a LIST in #373, so the fleet CAN now select items one at a time — what
          has not caught up is this browser's draft, which still models the selection as one reference.
          Saying "this fleet cannot express it" would be false the moment that landed, and a sentence
          that goes stale into a lie is worse than no sentence. The selection is already a list here,
          so closing it is widening the draft rather than redesigning this step. */}
      <p className="m-0 text-meta leading-base text-muted" data-fleet-skills-limit="">
        One skill at a time, on this screen — ticking a second replaces the first, and adding a new one replaces a
        ticked one. The fleet itself can give an account several; picking more than one here is the next change, not a
        limit of the fleet.
      </p>
    </div>
  );
}

/**
 * Which settings this account applies — the same question every other step asks, finally asked here.
 *
 * THE STEP THAT DID NOT FOLLOW THE RULE. Every other step in this sequence offers what this fleet
 * already has and lets a person add one that joins the collection. This one asked a two-way question
 * — leave the fleet's settings alone, or type one JSON object — which could express exactly one entry
 * of a field that has always been a STACK, deep-merged left to right, whose entries may be document
 * references. So the fleet could compose settings and a browser could not, and the composition it did
 * perform was invisible.
 *
 * SHAPED LIKE SKILLS, NOT LIKE INSTRUCTIONS, for the reason the skills step gives: this is an
 * OPTIONAL SET and "none" is an ordinary answer somebody gives by ticking nothing, so a radio group
 * would need a fourth answer whose only job is to escape a control that should not have been a radio.
 * What it adds over skills is ORDER, because a set has none and a stack is nothing but order — which
 * is why the ticked entries are shown as a numbered list underneath rather than only as ticks.
 *
 * The FORMAT is stated once, up here, rather than guessed per card. A harness's settings destination
 * decides how every document in its stack is parsed, and this browser cannot know what a document in
 * the store contains; what it can do is say plainly which parser will read them.
 */
function SettingsStep({
  draft,
  onChange,
  disabled,
  store,
}: {
  readonly draft: FleetAccountDraft;
  readonly onChange: (next: FleetLayerDraft) => void;
  readonly disabled: boolean;
  readonly store: readonly FleetSettingsStoreItem[];
}) {
  const uid = useId();
  const id = (name: string): string => `${uid}${name}`;
  const layer = draft.layer;
  const harness = draft.harness;
  const [middle, setMiddle] = useState('');
  const applied = settingsPaths(layer);
  const nameProblem = newSettingsProblem(middle, harness, store, layer);
  const cards: readonly FleetChoice<string>[] = store.map(item => ({
    id: item.path,
    label: item.path,
    detail:
      item.refusal ??
      [
        // "Registered as", not "named": `settingsFormatNote` below starts with "Named", and two
        // sentences opening on the same word read as one sentence repeated.
        item.name === undefined ? null : `Registered as “${item.name}”.`,
        // "ALSO applied by", and NOTHING AT ALL when the list is empty. The version here said "no
        // account applies it yet", which is false on every scaffolded host: `fy fleet init` registers
        // these documents AND applies them through the `base` profile, and this list is built from
        // per-account overlays only. Claiming an absence needs the fleet's whole composition chain,
        // which `compositionSlots` owns and no browser may restate — so the offer states presence
        // where it can see it and says nothing where it cannot.
        item.accounts.length === 0 ? null : `Also applied by ${item.accounts.join(', ')}.`,
        settingsFormatNote(item.path, harness),
        SHARED_DOCUMENT_CONSEQUENCE,
      ]
        .filter(part => part !== null)
        .join(' '),
    ...(item.name === undefined ? {} : { badge: item.name }),
    ...(item.refusal === undefined ? {} : { disabled: true }),
  }));
  const addDocument = (): void => {
    if (nameProblem !== null) return;
    onChange(withNewSettings(layer, harness, middle, crypto.randomUUID()));
    setMiddle('');
  };
  const addVariable = (): void =>
    onChange({ ...layer, env: [...layer.env, { id: crypto.randomUUID(), name: '', value: '' }] });
  return (
    <div className={cn(SECTION, 'grid gap-3')}>
      <div className="flex min-w-0 items-start gap-2">
        <Wrench size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
        <p className="m-0 min-w-0 text-meta leading-base text-muted">
          This fleet already composes settings for its accounts, and anything here applies after that. Several can apply
          at once: they are folded together in the order you put them in, and a later one wins where two set the same
          key. A {fleetHarnessLabel(harness)} account reads them as {SETTINGS_DOCUMENT[harness].format}.
        </p>
      </div>

      <FleetCheckChoice
        legend="Settings this fleet already has"
        name="settings"
        options={cards}
        selected={applied}
        disabled={disabled}
        empty="This fleet has named no settings documents. Write one below, or leave this account with whatever the fleet already composes."
        onToggle={path => onChange(withStoreSettings(layer, path, crypto.randomUUID()))}
      />

      {/* ADD ONE HERE, and it joins the collection — the same half the skills step gained, for the
          same reason. The prefix and the extension are rendered rather than typed: the directory is
          this fleet's own scaffold convention, and the extension follows from the harness, because a
          `.json` document handed to a Codex account is parsed as TOML and fails the apply. */}
      <div>
        <label className={FIELD_LABEL} htmlFor={id('-new-settings')}>
          Add a new settings document
        </label>
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          <div className="flex min-w-0 flex-1 items-stretch">
            <span
              className="inline-flex shrink-0 items-center rounded-l-control border border-r-0 border-border bg-surface-3 px-2 font-mono text-meta text-muted"
              data-fleet-settings-prefix=""
            >
              {SETTINGS_PREFIX[harness]}
            </span>
            <input
              id={id('-new-settings')}
              className="kt-input min-w-0 flex-1 rounded-l-none rounded-r-none font-mono"
              value={middle}
              disabled={disabled}
              placeholder="strict"
              data-fleet-new-settings=""
              onChange={event => setMiddle(event.target.value)}
            />
            <span
              className="inline-flex shrink-0 items-center rounded-r-control border border-l-0 border-border bg-surface-3 px-2 font-mono text-meta text-muted"
              aria-hidden="true"
            >
              {SETTINGS_DOCUMENT[harness].extension}
            </span>
          </div>
          <button
            type="button"
            className="kt-btn"
            data-fleet-add-settings=""
            disabled={disabled || nameProblem !== null}
            onClick={addDocument}
          >
            <Plus size={14} aria-hidden="true" />
            Add
          </button>
        </div>
        <p className="m-0 mt-1 break-words text-meta leading-base text-muted" data-fleet-new-settings-note="">
          {middle.trim() === ''
            ? 'A new document in this fleet’s store, written by this change. The next account you create can tick it.'
            : (nameProblem ?? `${settingsPathFor(harness, middle)} will be added to the store.`)}
        </p>
      </div>

      <FleetSettingsOrder layer={layer} onChange={onChange} disabled={disabled} harness={harness} name="stepper" />

      <details className="group rounded-control border border-border-soft" data-fleet-env-fold="">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-ui font-semibold text-fg">
          <KeyRound size={14} className="shrink-0 text-muted" aria-hidden="true" />
          Environment variables
          <span className="ml-auto text-meta font-normal text-muted">{String(layer.env.length)} set</span>
        </summary>
        <div className="border-t border-border-soft px-3 py-2">
          <p className="m-0 mb-2 text-meta leading-base text-muted">
            Set in this account’s wrapper only. Credentials belong in the secret store, not here.
          </p>
          <ul className="m-0 list-none space-y-2 p-0" aria-label="Environment variables">
            {layer.env.map((entry, index) => (
              <li key={entry.id} className="flex min-w-0 flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1">
                  <label className={FIELD_LABEL} htmlFor={id(`-env-name-${String(index)}`)}>
                    Name
                  </label>
                  <input
                    id={id(`-env-name-${String(index)}`)}
                    className="kt-input font-mono"
                    value={entry.name}
                    disabled={disabled}
                    onChange={event =>
                      onChange({
                        ...layer,
                        env: layer.env.map((row, at) => (at === index ? { ...row, name: event.target.value } : row)),
                      })
                    }
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <label className={FIELD_LABEL} htmlFor={id(`-env-value-${String(index)}`)}>
                    Value
                  </label>
                  <input
                    id={id(`-env-value-${String(index)}`)}
                    className="kt-input font-mono"
                    value={entry.value}
                    disabled={disabled}
                    onChange={event =>
                      onChange({
                        ...layer,
                        env: layer.env.map((row, at) => (at === index ? { ...row, value: event.target.value } : row)),
                      })
                    }
                  />
                </div>
              </li>
            ))}
          </ul>
          <button type="button" className="kt-btn kt-btn--sm mt-2" disabled={disabled} onClick={addVariable}>
            <Plus size={14} aria-hidden="true" />
            Add variable
          </button>
        </div>
      </details>
    </div>
  );
}

/** One line of the recap. `value` is rendered as data, not prose, because that is what it is. */
function RecapRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 border-t border-border-soft py-1.5 first:border-t-0">
      <dt className="text-meta text-muted">{label}</dt>
      <dd className="m-0 min-w-0 break-words font-mono text-meta text-fg">{value}</dd>
    </div>
  );
}

/**
 * The recap, which is NOT the review.
 *
 * The review is the daemon's — it derives the change, previews every write and holds it for an
 * authorized apply, and that step is unchanged. This is the last thing a person sees before asking
 * for one: the answers they gave, in the order they gave them, so a wrong turn six steps back is
 * visible before a round trip rather than after it.
 */
function ReviewStep({ draft, variants }: { readonly draft: FleetAccountDraft; readonly variants: readonly string[] }) {
  const models = selectedModels(draft);
  const skills = skillsSelection(draft.layer).selected;
  const profiles = draftProfiles(draft);
  /**
   * Whether the fleet's own slot names are worth recapping at all.
   *
   * The row used to read `claude-auto-atelier · lane auto · home claude-auto-atelier` — the wrapper
   * twice, and between the two copies a word the sequence never taught. The home IS the wrapper
   * name, so printing both said nothing; and on a fleet with no slots of its own the variant is
   * derived from the mode the label already names. Where the fleet DOES declare its own, the person
   * picked one two steps back and a recap that dropped it would be recapping a different change.
   */
  const groups = otherLanes(variants).length > 0;
  return (
    <div className={SECTION}>
      <dl className="m-0" data-fleet-recap="">
        <RecapRow label="Harness" value={fleetHarnessLabel(draft.harness)} />
        <RecapRow label="Account" value={draft.name.trim() === '' ? '—' : draft.name.trim()} />
        <RecapRow
          label="Display name"
          value={draft.displayName.trim() === '' ? draft.name.trim() : draft.displayName.trim()}
        />
        {/* One row PER ACCOUNT, named rather than counted. Ticking both modes creates two accounts
            with two wrapper names and two homes, and a recap that said "2" would be the one place
            left where a person could still be surprised by the second one. */}
        {draft.lanes.length === 0 ? (
          <RecapRow label="Accounts" value="— no mode chosen, so nothing would be created" />
        ) : (
          draft.lanes.map(lane => (
            <RecapRow
              key={lane.mode}
              label={lane.mode === 'auto' ? 'Account (unattended)' : 'Account (driven by a person)'}
              value={`${derivedWrapper(draft, lane)}${groups ? ` · group ${lane.variant}` : ''}`}
            />
          ))
        )}
        {/* The sign-in answer, named rather than implied. An account authenticated by a profile is the
            one thing on this recap somebody might not expect to have chosen, and the order matters as
            much as the set — so the row prints the profiles in the order they apply. */}
        <RecapRow
          label="Sign-in"
          value={
            draft.credential === 'login'
              ? 'the harness’s own, on the Accounts screen'
              : `no login · ${profiles.length === 0 ? 'no profile picked' : profiles.join(' → ')}`
          }
        />
        <RecapRow label="Models" value={models.length === 0 ? '—' : models.join(', ')} />
        <RecapRow label="Default model" value={draft.defaultModel.trim() === '' ? '—' : draft.defaultModel.trim()} />
        <RecapRow
          label="Instructions"
          value={draft.layer.instructions.path.trim() === '' ? '—' : draft.layer.instructions.path.trim()}
        />
        <RecapRow label="Skills" value={skills.length === 0 ? 'none' : skills.join(', ')} />
        {/* NAMED AND IN ORDER, never counted. "2 settings" is the one thing a person cannot check
            against the plan they are about to approve, and the order is the whole mechanism — so the
            row reads as the sequence it sends, with `→` for "and then". */}
        <RecapRow
          label="Settings"
          value={
            draft.layer.settings.length === 0
              ? 'the fleet’s, unchanged'
              : draft.layer.settings.map(entry => settingsEntryLabel(entry)).join(' → ')
          }
        />
      </dl>
    </div>
  );
}
