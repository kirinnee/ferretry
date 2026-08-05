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

import { FileText, FlaskConical, KeyRound, Lock, Plus, Sparkles, Trash2, Wrench } from 'lucide-react';
import { type RefObject, useId, useRef } from 'react';
import { cn } from '../../lib/class-names.ts';
import { derivedWrapper, draftModels, type FleetAccountDraft, type FleetLayerDraft } from './fleet-change-model.ts';
import { type FleetHarnessKind, fleetHarnessLabel } from './fleet-model.ts';

const FIELD_LABEL = 'kt-label mb-1 block';
const SECTION = 'border-t border-border-soft px-panel py-3 first:border-t-0';

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
      <Icon size={15} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
      <div className="min-w-0">
        <h4 id={id} className="m-0 text-ui font-semibold text-fg">
          {title}
        </h4>
        <p className="m-0 text-meta leading-base text-muted">{note}</p>
      </div>
    </div>
  );
}

export interface FleetLayerFieldsProps {
  readonly layer: FleetLayerDraft;
  readonly onChange: (next: FleetLayerDraft) => void;
  readonly disabled: boolean;
}

/**
 * Instructions, skills, inline settings and environment for ONE account.
 *
 * The paths are relative to the daemon's own asset directory, and that is not a detail: the daemon
 * refuses anything absolute, anything with a traversal segment and anything that passes through a
 * link, so a relative path inside the tree is the whole of what a browser is allowed to name.
 */
export function FleetLayerFields({ layer, onChange, disabled }: FleetLayerFieldsProps) {
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
          <div className="flex min-w-0 items-start gap-2 rounded-control border border-border-soft bg-surface-2 p-3">
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
        <label className={cn(FIELD_LABEL, 'mt-3')} htmlFor={id('-instructions-text')}>
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
      </section>

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
            <li key={skill.id} className="rounded-control border border-border-soft bg-surface-2 p-3">
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
  /** The harness `defaultFleetHarness` picked from positive evidence, when there is any. */
  readonly suggestion: FleetHarnessKind | undefined;
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
  suggestion,
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
                {suggestion === harness ? <span className="text-meta text-muted"> · suggested</span> : null}
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
          <FlaskConical size={13} className="shrink-0" aria-hidden="true" />
          Wrapper the daemon will derive:
          <code className="font-mono text-meta text-fg" data-fleet-derived-wrapper="">
            {derivedWrapper(draft)}
          </code>
        </p>
      </section>

      <section className={SECTION}>
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
        <p className="m-0 mt-1 text-meta text-muted">One per line, or comma separated.</p>
        <label className={cn(FIELD_LABEL, 'mt-3')} htmlFor={id('-account-default-model')}>
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
        <p className="m-0 mt-1 text-meta text-muted">
          An account that claims to be available has to be able to serve something, and name which of it is the default.
        </p>
      </section>

      <FleetLayerFields layer={draft.layer} onChange={layer => onChange({ ...draft, layer })} disabled={disabled} />

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
