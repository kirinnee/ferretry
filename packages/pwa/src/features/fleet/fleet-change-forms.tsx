/**
 * The two things a person composes here: a new account, and one account's own layer.
 *
 * These are DRAFT editors and nothing else. They hold no client, perform no request and know nothing
 * about authority: everything they produce is a value the composed surface turns into a proposal the
 * daemon derives, previews and holds. That separation is what keeps "review before anything changes"
 * true — a form that could write would be a form that could write before it was reviewed.
 *
 * The layer is per-ROUTE. Two lanes of one provider account can carry different instructions, skills,
 * settings and environment, and the fields below edit exactly one lane's overlay rather than anything
 * shared.
 */

import {
  ChevronDown,
  FileText,
  FlaskConical,
  KeyRound,
  Lock,
  Plus,
  Sparkles,
  TriangleAlert,
  Trash2,
  Wand2,
  Wrench,
} from 'lucide-react';
import { type RefObject, useId, useRef } from 'react';
import { cn } from '../../lib/class-names.ts';
import {
  derivedWrapper,
  draftModels,
  type FleetAccountDraft,
  type FleetHarnessDetection,
  type FleetInstructionsChoice,
  type FleetLayerDraft,
  type FleetPrefilledField,
  type FleetPrefillNotes,
} from './fleet-change-model.ts';
import { type FleetHarnessKind, fleetHarnessLabel } from './fleet-model.ts';
import { FIELD_LABEL as FLEET_FIELD_LABEL, FleetPath } from './fleet-typography.tsx';

/** One import, so the label scale is the panel's and not this file's. */
const FIELD_LABEL = FLEET_FIELD_LABEL;
const SECTION = 'border-t border-border-soft px-panel py-3 first:border-t-0';

/**
 * What detection put in this box, and where it came from.
 *
 * EVERY prefilled field carries one, because a form that fills itself in is only safe if a person can
 * see which parts it filled: an indistinguishable prefill makes them re-check every field, which is the
 * work this whole change exists to remove. The note disappears the moment they edit the field — at that
 * point the value is theirs and a provenance line about it would be a false claim.
 *
 * `border-strong` rather than `border-soft`: this sits on `surface-2`, where the soft hairline is
 * invisible.
 */
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

/** DOM identity for a row a person just added. Never sent anywhere; never fleet data. */
const rowId = (): string => crypto.randomUUID();

/**
 * A section's heading and its one-line reason.
 *
 * The VISIBLE heading carries the id the section names in `aria-labelledby`. It used to be paired with
 * an `sr-only` copy of the same text, which made a screen reader announce every section heading twice.
 */
function SectionHead({
  icon: Icon,
  id,
  title,
  note,
}: {
  readonly icon: typeof FileText;
  readonly id: string;
  readonly title: string;
  readonly note: string;
}) {
  return (
    <div className="mb-2 flex min-w-0 items-start gap-2">
      <Icon size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
      <div className="min-w-0">
        <h4 id={id} className="m-0 text-ui font-semibold text-fg">
          {title}
        </h4>
        <p className="m-0 text-meta leading-base text-muted">{note}</p>
      </div>
    </div>
  );
}

/**
 * Choosing WHICH instructions document this account reads.
 *
 * Offered only where there is a choice to make. Editing an existing account's layer edits the document
 * that account already declares, so that form keeps the plain path field it always had; a NEW account
 * is the one that has to pick, and picking is what lets one fleet keep several documents instead of one
 * per account.
 */
export interface FleetInstructionsControl {
  readonly choices: readonly FleetInstructionsChoice[];
  readonly value: string;
  readonly onChoose: (value: string) => void;
  /** True while a chosen document's current text is still being read from the daemon. */
  readonly loading: boolean;
}

/**
 * Skills, settings and environment, behind one disclosure or not at all.
 *
 * `folded={false}` renders the children EXACTLY as before, with no wrapper element: the layer form is
 * the screen where these three are the whole point, and putting them behind a fold there would hide the
 * thing a person opened it to do.
 */
function FleetAdvancedFold({
  folded,
  id,
  children,
}: {
  readonly folded: boolean;
  readonly id: string;
  readonly children: React.ReactNode;
}) {
  if (!folded) return <>{children}</>;
  return (
    <details className="group border-t border-border-soft" data-fleet-advanced="">
      {/* `list-none` removes the native marker so the chevron is the only affordance, and the summary
          keeps the theme's own coarse-pointer target floor rather than a number written here. */}
      <summary
        id={id}
        className="flex cursor-pointer list-none items-center gap-2 px-panel py-3 text-ui font-semibold text-fg"
      >
        <ChevronDown
          size={16}
          className="shrink-0 text-muted transition-transform motion-reduce:transition-none group-open:rotate-180"
          aria-hidden="true"
        />
        More settings
        <span className="ml-auto text-meta font-normal text-muted">skills · settings · environment</span>
      </summary>
      {children}
    </details>
  );
}

export interface FleetLayerFieldsProps {
  readonly layer: FleetLayerDraft;
  readonly onChange: (next: FleetLayerDraft) => void;
  readonly disabled: boolean;
  /** The document picker, when this form is the one that chooses. Absent leaves the path field alone. */
  readonly instructions?: FleetInstructionsControl;
  /** Where each still-detected value came from. Absent means nothing here was prefilled. */
  readonly notes?: FleetPrefillNotes;
  /**
   * Fold skills, settings and environment behind one disclosure.
   *
   * The account form is the long one, and three of its four layer concerns are things almost nobody
   * sets while CREATING an account — they are edited afterwards, from the layer form, against a lane
   * that exists. A disclosure is the conventional answer: everything stays reachable in one tap, and
   * the screen a person meets is the part they actually have to fill in.
   */
  readonly foldAdvanced?: boolean;
}

/**
 * Instructions, skills, inline settings and environment for ONE account.
 *
 * The paths are relative to the daemon's own asset directory, and that is not a detail: the daemon
 * refuses anything absolute, anything with a traversal segment and anything that passes through a
 * link, so a relative path inside the tree is the whole of what a browser is allowed to name.
 */
export function FleetLayerFields({
  layer,
  onChange,
  disabled,
  instructions: picker,
  notes = {},
  foldAdvanced = false,
}: FleetLayerFieldsProps) {
  /**
   * Removing a row unmounts the button that was clicked, so the browser drops focus to `<body>` and a
   * keyboard reader loses the form entirely. Each list keeps a ref to its own "Add" control — the one
   * element in that list that every removal leaves standing — and hands focus there. It is also what a
   * person reaches for next: the reason to delete a row is usually to add a different one.
   */
  const addSkillRef = useRef<HTMLButtonElement>(null);
  const addVariableRef = useRef<HTMLButtonElement>(null);
  const removed = (next: FleetLayerDraft, anchor: RefObject<HTMLButtonElement | null>): void => {
    onChange(next);
    // After the render that removed the row, not before it.
    queueMicrotask(() => anchor.current?.focus());
  };
  // Instance-scoped ids. Two of these mount together in the harness gallery, and duplicate ids break
  // `<label for>`: clicking one form's label focused the other form's input.
  const uid = useId();
  const id = (name: string): string => `${uid}${name}`;
  const setInstructions = (patch: Partial<{ path: string; text: string }>): void =>
    onChange({ ...layer, instructions: { ...layer.instructions, ...patch } });

  const preserved = Object.keys(layer.preserved);

  return (
    <div data-fleet-layer-fields="">
      {preserved.length === 0 ? null : (
        <section className={SECTION} data-fleet-preserved={String(preserved.length)}>
          {/* Tone and a rule rather than a THIRD border: a bordered notice inside a bordered section
              inside a bordered panel is the nesting the owner called out, and the soft hairline it used
              is invisible on surface-2 anyway. */}
          <div className="flex min-w-0 items-start gap-2 rounded-control border-l-2 border-l-border-strong bg-surface-2 p-3">
            <Lock size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
            <p className="m-0 text-meta leading-base text-muted">
              This lane also declares{' '}
              {preserved.map((field, index) => (
                <span key={field}>
                  {index === 0 ? '' : ', '}
                  <code className="font-mono text-meta text-fg">{field}</code>
                </span>
              ))}
              . Those are not editable here and are carried through this change exactly as they are.
            </p>
          </div>
        </section>
      )}

      <section className={SECTION} aria-labelledby={id('-instructions')}>
        <SectionHead
          icon={FileText}
          id={id('-instructions')}
          title="Instructions"
          note="A text file copied into this account's home as its CLAUDE.md / AGENTS.md."
        />
        {picker === undefined ? null : (
          <div className="mb-3">
            <label className={FIELD_LABEL} htmlFor={id('-instructions-choice')}>
              Document
            </label>
            {/* A plain select. It carries the whole choice — a new document for this account, seeded
                from the host or empty, or one of the documents this fleet already has — in one control
                that a phone renders as its own native picker. No min-height is set here: the theme
                floors every select to the pointer-derived target size under `(pointer: coarse)`, so
                hardcoding a number would only be able to disagree with it. */}
            <select
              id={id('-instructions-choice')}
              className="kt-input"
              value={picker.value}
              disabled={disabled}
              data-fleet-instructions-choice=""
              onChange={event => picker.onChoose(event.target.value)}
            >
              {picker.choices.map(choice => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
            <p className="m-0 mt-1 break-words text-meta leading-base text-muted" data-fleet-instructions-detail="">
              {picker.loading
                ? 'Reading that document’s current text…'
                : (picker.choices.find(choice => choice.value === picker.value)?.detail ?? '')}
            </p>
          </div>
        )}
        {/* One stack, one gap. The spacing used to be a `mt-3` on whichever label happened to come
            second, which is the per-child margin that doubles the moment a field is inserted between them. */}
        <div className="grid gap-3">
          <label className={FIELD_LABEL} htmlFor={id('-instructions-path')}>
            Asset path
          </label>
          <input
            id={id('-instructions-path')}
            className="kt-input font-mono"
            value={layer.instructions.path}
            disabled={disabled}
            placeholder="instructions/claude-studio.md"
            onChange={event => setInstructions({ path: event.target.value })}
          />
          <PrefillNote field="instructionsPath" notes={notes} />
          <label className={FIELD_LABEL} htmlFor={id('-instructions-text')}>
            Contents
          </label>
          <textarea
            id={id('-instructions-text')}
            className="kt-input min-h-[9rem] font-mono"
            rows={8}
            value={layer.instructions.text}
            disabled={disabled}
            onChange={event => setInstructions({ text: event.target.value })}
          />
          <PrefillNote field="instructionsText" notes={notes} />
        </div>
      </section>

      {/* ONE disclosure, not three. The three sections below are one decision — "I want to set more
          than the basics" — and three separate folds would be three things to notice. */}
      <FleetAdvancedFold folded={foldAdvanced} id={id('-advanced')}>
        <section className={SECTION} aria-labelledby={id('-skills')}>
          <SectionHead
            icon={Sparkles}
            id={id('-skills')}
            title="Skills"
            note="A directory in the asset tree. Every document in it is copied; there is no per-skill selection."
          />
          <label className={FIELD_LABEL} htmlFor={id('-skills-directory')}>
            Skills directory
          </label>
          <input
            id={id('-skills-directory')}
            className="kt-input font-mono"
            value={layer.skillsDirectory}
            disabled={disabled}
            placeholder="skills/studio"
            onChange={event => onChange({ ...layer, skillsDirectory: event.target.value })}
          />
          <ul className="m-0 mt-3 list-none space-y-3 p-0" aria-label="Skill documents">
            {layer.skills.map((skill, index) => (
              <li key={skill.id} className="rounded-control border-l-2 border-l-border-strong bg-surface-2 p-3">
                <div className="flex min-w-0 items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <label className={FIELD_LABEL} htmlFor={id(`-skill-path-${index}`)}>
                      Document {index + 1} path
                    </label>
                    <input
                      id={id(`-skill-path-${index}`)}
                      className="kt-input font-mono"
                      value={skill.path}
                      disabled={disabled}
                      placeholder="skills/studio/review.md"
                      onChange={event =>
                        onChange({
                          ...layer,
                          skills: layer.skills.map((entry, at) =>
                            at === index ? { ...entry, path: event.target.value } : entry,
                          ),
                        })
                      }
                    />
                  </div>
                  <button
                    type="button"
                    className="kt-btn kt-btn--sm"
                    data-variant="danger"
                    disabled={disabled}
                    aria-label={`Remove skill document ${index + 1}`}
                    onClick={() =>
                      removed({ ...layer, skills: layer.skills.filter((_, at) => at !== index) }, addSkillRef)
                    }
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
                <label className={cn(FIELD_LABEL, 'mt-3')} htmlFor={id(`-skill-text-${index}`)}>
                  Document {index + 1} contents
                </label>
                <textarea
                  id={id(`-skill-text-${index}`)}
                  className="kt-input min-h-[6rem] font-mono"
                  rows={5}
                  value={skill.text}
                  disabled={disabled}
                  onChange={event =>
                    onChange({
                      ...layer,
                      skills: layer.skills.map((entry, at) =>
                        at === index ? { ...entry, text: event.target.value } : entry,
                      ),
                    })
                  }
                />
              </li>
            ))}
          </ul>
          <button
            ref={addSkillRef}
            type="button"
            className="kt-btn kt-btn--sm mt-3"
            disabled={disabled}
            onClick={() => onChange({ ...layer, skills: [...layer.skills, { id: rowId(), path: '', text: '' }] })}
          >
            <Plus size={14} aria-hidden="true" />
            Add skill document
          </button>
        </section>

        <section className={SECTION} aria-labelledby={id('-settings')}>
          <SectionHead
            icon={Wrench}
            id={id('-settings')}
            title="Settings"
            note="Inline JSON, merged over what the harness already wrote. A key cannot be deleted from here."
          />
          <label className={FIELD_LABEL} htmlFor={id('-settings-text')}>
            Settings JSON
          </label>
          <textarea
            id={id('-settings-text')}
            className="kt-input min-h-[6rem] font-mono"
            rows={6}
            value={layer.settingsText}
            disabled={disabled}
            placeholder={'{\n  "model": "opus"\n}'}
            onChange={event => onChange({ ...layer, settingsText: event.target.value })}
          />
        </section>

        <section className={SECTION} aria-labelledby={id('-env')}>
          <SectionHead
            icon={KeyRound}
            id={id('-env')}
            title="Environment"
            note="Set in this account's wrapper only. Credentials belong in the secret store, not here."
          />
          <ul className="m-0 list-none space-y-2 p-0" aria-label="Environment variables">
            {layer.env.map((entry, index) => (
              <li key={entry.id} className="flex min-w-0 flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1">
                  <label className={FIELD_LABEL} htmlFor={id(`-env-name-${index}`)}>
                    Name
                  </label>
                  <input
                    id={id(`-env-name-${index}`)}
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
                  <label className={FIELD_LABEL} htmlFor={id(`-env-value-${index}`)}>
                    Value
                  </label>
                  <input
                    id={id(`-env-value-${index}`)}
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
                <button
                  type="button"
                  className="kt-btn kt-btn--sm"
                  data-variant="danger"
                  disabled={disabled}
                  aria-label={`Remove environment variable ${index + 1}`}
                  onClick={() => removed({ ...layer, env: layer.env.filter((_, at) => at !== index) }, addVariableRef)}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <button
            ref={addVariableRef}
            type="button"
            className="kt-btn kt-btn--sm mt-3"
            disabled={disabled}
            onClick={() => onChange({ ...layer, env: [...layer.env, { id: rowId(), name: '', value: '' }] })}
          >
            <Plus size={14} aria-hidden="true" />
            Add variable
          </button>
        </section>
      </FleetAdvancedFold>
    </div>
  );
}

/** Problems as a list, in the daemon's own words where the daemon has words for them. */
export function FleetProblems({ problems }: { readonly problems: readonly string[] }) {
  if (problems.length === 0) return null;
  return (
    <ul
      className="m-0 mt-3 list-none space-y-1 rounded-control border border-warn-border bg-warn-bg p-3"
      aria-label="Unresolved problems"
      data-fleet-problems={String(problems.length)}
    >
      {problems.map(problem => (
        <li key={problem} className="text-meta leading-base text-warn">
          {problem}
        </li>
      ))}
    </ul>
  );
}

export interface FleetAccountFormProps {
  readonly draft: FleetAccountDraft;
  readonly onChange: (next: FleetAccountDraft) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
  readonly problems: readonly string[];
  readonly disabled: boolean;
  /**
   * The asset listing this form needs before it can judge a path is still in flight.
   *
   * A new account writes asset text, so the form cannot be used until the daemon has said what is already
   * in the tree — and on a relayed connection that is a visible wait. Saying so is the difference between
   * a form that is loading and a form that is broken.
   */
  readonly loading: boolean;
  /**
   * What this host said about its harnesses, and what this form did about it.
   *
   * It replaces a bare "suggested" marker. The marker said a choice had been made and never said on
   * what evidence, so a person could not tell a `PATH` detection from an inference off the published
   * manifest — and in the one state that matters most, neither harness installed at all, it said
   * nothing whatsoever.
   */
  readonly detection: FleetHarnessDetection;
  /** Which instructions document this account uses, chosen rather than typed. */
  readonly instructions: FleetInstructionsControl;
  /** Lanes this fleet declares. An account can only be added to one that exists. */
  readonly variants: readonly string[];
}

const HARNESSES: readonly FleetHarnessKind[] = ['claude', 'codex'];

export function FleetAccountForm({
  draft,
  onChange,
  onSubmit,
  onCancel,
  problems,
  disabled,
  loading,
  detection,
  instructions,
  variants,
}: FleetAccountFormProps) {
  // Instance-scoped, for the same reason as the layer fields below.
  const uid = useId();
  const id = (name: string): string => `${uid}${name}`;
  const models = draftModels(draft.modelsText);
  return (
    <form
      data-fleet-account-form=""
      aria-labelledby={id('-account-form-heading')}
      aria-busy={loading}
      onSubmit={event => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="border-b border-border-soft bg-surface-2 px-panel py-3">
        <h3 id={id('-account-form-heading')} className="m-0 text-title font-semibold text-fg">
          New account
        </h3>
        <p className="m-0 text-meta leading-base text-muted">
          The daemon mints the account id and derives the wrapper and home names. Nothing is written until you review
          and authorize the change.
        </p>
      </div>
      {loading ? (
        <p className="m-0 px-panel py-3 text-ui text-faint" data-fleet-account-loading="">
          Reading what is already in the asset tree…
        </p>
      ) : null}

      {/* WHAT THIS HOST HAS, before anything below it is read as a choice.
          The "nothing installed" case gets the warning treatment and its own attention rope, because
          it is the one state where every prefilled field below is describing a harness that cannot
          run here — and this form would previously have let somebody configure it without a word. */}
      <div
        className={cn(
          'flex min-w-0 items-start gap-2 border-b border-border-soft px-panel py-3',
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

      <section className={SECTION}>
        <fieldset className="m-0 border-0 p-0" aria-label="Harness">
          <span className={FIELD_LABEL}>Harness</span>
          <div className="flex flex-wrap gap-2">
            {/* `!` ON PURPOSE, the same override `shell/fleet-filters.tsx` needs. `.kt-tab` is defined
                after `@tailwind utilities`, so at equal specificity its own transparent border,
                transparent background and muted colour win over the utilities — and the selected
                treatment it ships keys off `aria-selected`/`aria-pressed`, neither of which a `<label>`
                may carry. Without the override the radio group has NO visible selection at all, and the
                sr-only input means the chip is the only affordance a sighted person has. */}
            {HARNESSES.map(harness => (
              <label
                key={harness}
                className={cn(
                  'kt-tab cursor-pointer',
                  draft.harness === harness && '!border-accent !bg-accent-soft !text-accent',
                )}
                data-fleet-harness-choice={harness}
                data-fleet-harness-selected={String(draft.harness === harness)}
              >
                <input
                  type="radio"
                  // Instance-scoped like every other identifier in these forms: two co-existing account
                  // forms would otherwise silently share one radio group.
                  name={id('-harness')}
                  className="sr-only"
                  value={harness}
                  checked={draft.harness === harness}
                  disabled={disabled}
                  onChange={() => onChange({ ...draft, harness })}
                />
                {fleetHarnessLabel(harness)}
                {detection.harness === harness ? <span className="text-meta text-muted"> · detected</span> : null}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className={FIELD_LABEL} htmlFor={id('-account-name')}>
              Provider account name
            </label>
            <input
              id={id('-account-name')}
              className="kt-input font-mono"
              value={draft.name}
              disabled={disabled}
              placeholder="studio"
              onChange={event => onChange({ ...draft, name: event.target.value })}
            />
          </div>
          <div>
            <label className={FIELD_LABEL} htmlFor={id('-account-variant')}>
              Lane
            </label>
            <select
              id={id('-account-variant')}
              className="kt-input"
              value={draft.variant}
              disabled={disabled}
              onChange={event => onChange({ ...draft, variant: event.target.value })}
            >
              {variants.map(variant => (
                <option key={variant} value={variant}>
                  {variant}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={FIELD_LABEL} htmlFor={id('-account-display-name')}>
              Display name
            </label>
            <input
              id={id('-account-display-name')}
              className="kt-input"
              value={draft.displayName}
              disabled={disabled}
              placeholder="Studio Claude"
              onChange={event => onChange({ ...draft, displayName: event.target.value })}
            />
          </div>
          <div>
            <label className={FIELD_LABEL} htmlFor={id('-account-mode')}>
              Mode
            </label>
            <select
              id={id('-account-mode')}
              className="kt-input"
              value={draft.mode}
              disabled={disabled}
              onChange={event => onChange({ ...draft, mode: event.target.value === 'auto' ? 'auto' : 'interactive' })}
            >
              <option value="auto">auto</option>
              <option value="interactive">interactive</option>
            </select>
          </div>
        </div>

        <p className="m-0 mt-3 flex flex-wrap items-baseline gap-2 text-meta text-muted">
          <FlaskConical size={14} className="shrink-0" aria-hidden="true" />
          Wrapper the daemon will derive:
          <span className="min-w-0" data-fleet-derived-wrapper="">
            <FleetPath value={derivedWrapper(draft)} className="text-meta text-fg" label="Derived wrapper" />
          </span>
        </p>
      </section>

      <section className={SECTION}>
        <div className="grid gap-3">
          <label className={FIELD_LABEL} htmlFor={id('-account-models')}>
            Models this account can serve
          </label>
          <textarea
            id={id('-account-models')}
            className="kt-input min-h-[5rem] font-mono"
            rows={4}
            value={draft.modelsText}
            disabled={disabled}
            placeholder={'claude-opus-5\nclaude-sonnet-5'}
            onChange={event => onChange({ ...draft, modelsText: event.target.value })}
          />
          {/* Provenance first, because it is about the value in the box; the field's own help below it. */}
          <PrefillNote field="models" notes={draft.prefilled} />
          <p className="m-0 mt-1 text-meta text-muted">One per line, or comma separated.</p>
          <label className={FIELD_LABEL} htmlFor={id('-account-default-model')}>
            Default model
          </label>
          <select
            id={id('-account-default-model')}
            className="kt-input"
            value={draft.defaultModel}
            disabled={disabled || models.length === 0}
            onChange={event => onChange({ ...draft, defaultModel: event.target.value })}
          >
            <option value="">Choose a model</option>
            {models.map(model => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
          {/* Only when it says something the line above did not: both are usually read out of the same
            settings file, and one fact deserves one sentence. */}
          {draft.prefilled.defaultModel === draft.prefilled.models ? null : (
            <PrefillNote field="defaultModel" notes={draft.prefilled} />
          )}
          <p className="m-0 mt-1 text-meta text-muted">
            An account that claims to be available has to be able to serve something, and name which of it is the
            default.
          </p>
        </div>
      </section>

      <FleetLayerFields
        layer={draft.layer}
        onChange={layer => onChange({ ...draft, layer })}
        disabled={disabled}
        instructions={instructions}
        notes={draft.prefilled}
        foldAdvanced={true}
      />

      <div className="border-t border-border-soft px-panel py-3">
        <FleetProblems problems={problems} />
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="submit" className="kt-btn" data-variant="primary" disabled={disabled || problems.length > 0}>
            Preview this change
          </button>
          <button type="button" className="kt-btn" data-variant="ghost" disabled={disabled} onClick={onCancel}>
            Discard draft
          </button>
        </div>
      </div>
    </form>
  );
}

export interface FleetLayerFormProps {
  readonly wrapper: string;
  readonly layer: FleetLayerDraft;
  readonly onChange: (next: FleetLayerDraft) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
  readonly problems: readonly string[];
  readonly disabled: boolean;
  /** True while the assets this layer references are still being read. */
  readonly loading: boolean;
}

/** One existing account's own layer. Identity, models and availability are not editable here. */
export function FleetLayerForm({
  wrapper,
  layer,
  onChange,
  onSubmit,
  onCancel,
  problems,
  disabled,
  loading,
}: FleetLayerFormProps) {
  const uid = useId();
  const id = (name: string): string => `${uid}${name}`;
  return (
    <form
      data-fleet-layer-form={wrapper}
      aria-labelledby={id('-layer-form-heading')}
      // The same truth the sentence below states, in the attribute assistive technology reads. Both forms
      // carry it, because a person told "reading the assets…" by one and nothing by the other is being
      // told the second one is broken.
      aria-busy={loading}
      onSubmit={event => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="border-b border-border-soft bg-surface-2 px-panel py-3">
        <h3 id={id('-layer-form-heading')} className="m-0 text-title font-semibold text-fg">
          Layer for <code className="font-mono text-title text-accent">{wrapper}</code>
        </h3>
        <p className="m-0 text-meta leading-base text-muted">
          This lane's own overlay, applied after every shared profile and variant. It cannot leak onto another lane of
          the same account.
        </p>
      </div>
      {loading ? (
        <p className="m-0 px-panel py-3 text-ui text-faint" data-fleet-layer-loading="">
          Reading the assets this layer references…
        </p>
      ) : null}
      <FleetLayerFields layer={layer} onChange={onChange} disabled={disabled} />
      <div className="border-t border-border-soft px-panel py-3">
        <FleetProblems problems={problems} />
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="submit" className="kt-btn" data-variant="primary" disabled={disabled || problems.length > 0}>
            Preview this change
          </button>
          <button type="button" className="kt-btn" data-variant="ghost" disabled={disabled} onClick={onCancel}>
            Discard draft
          </button>
        </div>
      </div>
    </form>
  );
}
