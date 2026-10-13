/**
 * The fields of a component, for Edit, for New and for "Create new …" inside Build a profile
 * (the prototype's `compForm`). One field set per kind, all of it plain text a person can type on a
 * phone: the instructions themselves, the command that starts an MCP server, skills and models one
 * per line, settings one `key = value` per line.
 */

import { Lock } from 'lucide-react';
import { useId } from 'react';
import { Textarea } from '../../../shell/primitives.tsx';
import {
  type ComponentDraft,
  draftDefault,
  componentDraftModels,
  HARNESS_NAMES,
  type CatalogHarness,
  harnessBound,
} from './component-model.ts';

const BODY_LABEL = {
  instructions: 'Instructions',
  mcp: 'Command',
  skills: 'Skills, one per line',
  settings: 'Settings, one key = value per line',
  hooks: 'Hooks',
  modelSets: 'Models, one per line',
} as const;

export interface ComponentFormProps {
  readonly draft: ComponentDraft;
  readonly onChange: (next: ComponentDraft) => void;
  /** Editing keeps the name and the harness: they are what the profiles that use it point at. */
  readonly editing: boolean;
  /** The form's problem, shown under the name when it is about the name. */
  readonly problem?: string;
}

export function ComponentForm({ draft, onChange, editing, problem }: ComponentFormProps) {
  const id = useId();
  const set = (patch: Partial<ComponentDraft>) => onChange({ ...draft, ...patch });
  const models = componentDraftModels(draft);
  const nameProblem = problem !== undefined && /name|called/u.test(problem) && draft.name !== '' ? problem : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-component-form={draft.kind}>
      <label className="flex min-w-0 flex-col gap-1" htmlFor={`${id}-name`}>
        <span className="text-cell font-medium text-fg">Name</span>
        <input
          id={`${id}-name`}
          className={draft.kind === 'mcp' ? 'kt-input font-mono' : 'kt-input'}
          value={draft.name}
          disabled={editing}
          autoComplete="off"
          aria-invalid={nameProblem !== undefined}
          data-component-field="name"
          onChange={event => set({ name: event.currentTarget.value })}
        />
        {nameProblem === undefined ? null : <span className="text-cell text-err">{nameProblem}</span>}
      </label>

      {harnessBound(draft.kind) && !editing ? (
        <label className="flex min-w-0 flex-col gap-1" htmlFor={`${id}-harness`}>
          <span className="text-cell font-medium text-fg">Tool</span>
          <select
            id={`${id}-harness`}
            className="kt-input"
            value={draft.harness ?? 'claude'}
            data-component-field="harness"
            onChange={event => set({ harness: event.currentTarget.value as CatalogHarness })}
          >
            {(['claude', 'codex'] as const).map(harness => (
              <option key={harness} value={harness}>
                {HARNESS_NAMES[harness]}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {draft.directory ? null : (
        <label className="flex min-w-0 flex-col gap-1" htmlFor={`${id}-body`}>
          <span className="text-cell font-medium text-fg">{BODY_LABEL[draft.kind]}</span>
          <Textarea
            id={`${id}-body`}
            className={draft.kind === 'instructions' ? 'min-h-[160px]' : 'min-h-[96px] font-mono'}
            value={draft.body}
            disabled={draft.redacted}
            data-component-field="body"
            onChange={event => set({ body: event.currentTarget.value })}
          />
          {draft.kind === 'settings' ? (
            <span className="text-cell leading-base text-muted">
              Flags and environment go here too, e.g. <span className="font-mono">env.LOG_LEVEL = debug</span>. Secret
              values go in the secret store, not here.
            </span>
          ) : draft.kind === 'mcp' ? (
            <span className="text-cell leading-base text-muted">
              The command that starts the server, or its web address.
            </span>
          ) : null}
        </label>
      )}

      {draft.hiddenKeys.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0" data-component-hidden="">
          {draft.hiddenKeys.map(key => (
            <li key={key} className="flex min-w-0 flex-wrap items-center gap-2 text-cell text-muted">
              <Lock size={12} aria-hidden="true" className="shrink-0" />
              <span className="font-mono text-fg">{key}</span>
              <span>hidden · kept as is</span>
            </li>
          ))}
        </ul>
      ) : null}

      {draft.kind === 'modelSets' && models.length > 0 ? (
        <label className="flex min-w-0 flex-col gap-1" htmlFor={`${id}-default`}>
          <span className="text-cell font-medium text-fg">Default</span>
          <select
            id={`${id}-default`}
            className="kt-input font-mono"
            value={draftDefault(draft)}
            data-component-field="default"
            onChange={event => set({ defaultModel: event.currentTarget.value })}
          >
            {models.map(model => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}
