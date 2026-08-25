/**
 * One account's own layer, as a draft editor.
 *
 * This is a DRAFT editor and nothing else. It holds no client, performs no request and knows nothing
 * about authority: everything it produces is a value the composed surface turns into a proposal the
 * daemon derives, previews and holds. That separation is what keeps "review before anything changes"
 * true — a form that could write would be a form that could write before it was reviewed.
 *
 * The layer is per-ROUTE. Two lanes of one provider account can carry different instructions, skills,
 * settings and environment, and the fields below edit exactly one lane's overlay rather than anything
 * shared. Those are the SCHEMA's words and they stay in this file's types; neither reaches the
 * screen, where one route is one account and what this edits is that account's own documents.
 *
 * **Creating an account is no longer done here.** That flow is `fleet-account-stepper.tsx`, which asks
 * one question at a time; what is left in this file is the form for changing a lane that already
 * exists, where the person came to edit a specific thing and every field being on one screen is the
 * point rather than the problem.
 */

import { FileText, KeyRound, Lock, Plus, Sparkles, Trash2, Wrench } from 'lucide-react';
import { type RefObject, useId, useRef } from 'react';
import { cn } from '../../lib/class-names.ts';
import { FIELD_LABEL } from '../../shell/panel-typography.tsx';
import type { FleetLayerDraft } from './fleet-change-model.ts';
import { FleetSettingsOrder } from './fleet-settings-stack.tsx';

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
          {/* Tone and a rule rather than a THIRD border: a bordered notice inside a bordered section
              inside a bordered panel is the nesting the owner called out, and the soft hairline it used
              is invisible on surface-2 anyway. */}
          <div className="flex min-w-0 items-start gap-2 rounded-control border-l-2 border-l-border-strong bg-surface-2 p-3">
            <Lock size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
            <p className="m-0 text-meta leading-base text-muted">
              This account also declares{' '}
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
        {/* One gap between FIELDS, and each field keeps its own label hugging its own control. The
            spacing used to be a `mt-3` on whichever label happened to come second — the per-child margin
            that doubles the moment a field is inserted between them — and a flat grid over label,
            control and note would have been the opposite error: every part equally far from every other,
            so a label no longer belongs to anything. */}
        <div className="grid gap-3">
          <div>
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
          </div>
          <div>
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
          </div>
        </div>
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
          note="Folded together in this order, over what the harness already wrote. A key cannot be deleted from here."
        />
        {/* THE SAME CONTROL THE NEW-ACCOUNT STEP USES, minus the two halves this form has no facts for.
            An account's settings are a stack, and this form used to show one box — so an account whose
            settings the fleet composed from three documents appeared here as either one editable object
            or, for a plain reference, nothing at all. What it can now do is show the stack, reorder it,
            drop an entry and edit the one typed here.

            The picker and the add-a-document control are NOT here, and that is a fact about this form
            rather than a choice: it is handed a wrapper name, and neither the harness whose format a new
            document would be written in nor this fleet's store reaches it. Guessing the harness from the
            wrapper's prefix is the inference this feature refuses to make everywhere else. */}
        <FleetSettingsOrder layer={layer} onChange={onChange} disabled={disabled} harness={null} name="layer-form" />
        <p className="m-0 mt-2 text-meta leading-base text-muted" data-fleet-settings-picker-elsewhere="">
          Adding a document from this fleet’s store is on the New account screen.
        </p>
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
        {/* NEITHER "layer" NOR "lane" reaches this screen. Both are names the configuration schema
            has for composition slots, and this is the first panel a person opens from the roster —
            the owner's words were "what is a layer? that's way too complicated". The two facts the
            old subtitle carried are both still here: this is applied ON TOP of whatever the fleet
            shares, and it reaches this account and no other. */}
        <h3 id={id('-layer-form-heading')} className="m-0 text-title font-semibold text-fg">
          Edit <code className="font-mono text-title text-accent">{wrapper}</code>
        </h3>
        <p className="m-0 text-meta leading-base text-muted">
          Instructions, skills, settings and environment for this account only. Everything the fleet shares still
          applies underneath, and nothing here reaches another account.
        </p>
      </div>
      {loading ? (
        <p className="m-0 px-panel py-3 text-ui text-faint" data-fleet-layer-loading="">
          Reading the documents this account references…
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
