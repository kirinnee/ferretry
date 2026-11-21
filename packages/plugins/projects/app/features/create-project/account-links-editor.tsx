/**
 * CHANGE WHICH GITHUB ACCOUNTS AN EXISTING PROJECT LINKS. The create flow's accounts step is the only other place that
 * writes these, so without this a project registered before an account was connected could never be linked, and PR watch
 * (which reads the link) could never work for it.
 *
 * The write is the whole ordered list (`PUT /v1/projects/:id/accounts`), the first being the project's default, the
 * same call the create flow makes. A link to an account that no longer exists is kept as it is: it is shown by the
 * links list as "account removed", and this editor never drops a choice the person did not touch. It draws such a link
 * as a row of its own, so the person can drop it, and a "Make default" press on any chosen account moves it first: a
 * removed default stays first until the person says otherwise, and adding an account never silently decides it.
 */
import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { ProjectInfo } from '../../../contract/index.ts';
import type { ProjectsClient } from '../../lib/client.ts';
import { reasonOf } from '../../lib/client.ts';
import { setProjectAccounts } from './accounts-api.ts';

export interface AccountLinksEditorProps {
  readonly client: ProjectsClient;
  readonly project: Pick<ProjectInfo, 'id' | 'accounts'>;
  /** The accounts that exist now. */
  readonly existing: readonly { readonly id: string; readonly login: string }[];
  /** The daemon accepted the list; the project record now holds it. */
  readonly onSaved: () => void;
  readonly onCancel: () => void;
}

export function AccountLinksEditor({ client, project, existing, onSaved, onCancel }: AccountLinksEditorProps) {
  const [selected, setSelected] = useState<readonly string[]>(project.accounts ?? []);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const toggle = (id: string, on: boolean): void =>
    setSelected(on ? (selected.includes(id) ? selected : [...selected, id]) : selected.filter(each => each !== id));
  const makeDefault = (id: string): void => setSelected([id, ...selected.filter(each => each !== id)]);
  const live = new Set(existing.map(account => account.id));
  // Links the daemon's accounts no longer include, as the project holds them: shown, never dropped unasked.
  const removed = (project.accounts ?? []).filter(id => !live.has(id));
  const defaultGone =
    selected.length > 1 && selected[0] !== undefined && !live.has(selected[0]) && selected.some(id => live.has(id));
  const save = (): void => {
    if (saving) return;
    setSaving(true);
    setRefused(null);
    void setProjectAccounts(client, project.id, selected).then(onSaved, (cause: unknown) => {
      setSaving(false);
      setRefused(reasonOf(cause));
    });
  };
  return (
    <div className="grid gap-xs" data-project-accounts-editor="">
      {defaultGone && (
        <p
          className="m-0 flex items-start gap-xs text-meta text-warn"
          role="status"
          data-project-accounts-default-gone=""
        >
          <TriangleAlert className="mt-0.5 shrink-0" size={14} aria-hidden="true" />
          The default account was removed. Press “Make default” on the account that should replace it, or untick the
          removed link.
        </p>
      )}
      <ul className="m-0 grid list-none divide-y divide-border-soft p-0">
        {removed.map(id => (
          <li key={id}>
            <label
              className="flex min-h-control cursor-pointer items-center gap-sm py-1 text-ui"
              data-project-accounts-choice={id}
            >
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={selected.includes(id)}
                onChange={event => toggle(id, event.target.checked)}
              />
              <span className="mono min-w-0 truncate text-muted">{id}</span>
              <span className="text-warn">account removed</span>
              {selected[0] === id && selected.length > 1 && <span className="text-meta text-muted">default</span>}
            </label>
          </li>
        ))}
        {existing.map(account => (
          <li key={account.id} className="flex items-center gap-sm">
            <label
              className="flex min-h-control min-w-0 flex-1 cursor-pointer items-center gap-sm py-1 text-ui"
              data-project-accounts-choice={account.id}
            >
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={selected.includes(account.id)}
                onChange={event => toggle(account.id, event.target.checked)}
              />
              <span className="min-w-0 truncate">@{account.login}</span>
              {selected[0] === account.id && selected.length > 1 && (
                <span className="text-meta text-muted">default</span>
              )}
            </label>
            {/* Beside the label, not inside it: a press inside a label would also tick the box. */}
            {selected.includes(account.id) && selected[0] !== account.id && (
              <button
                type="button"
                className="kt-btn kt-btn--sm shrink-0"
                data-variant="ghost"
                data-project-accounts-make-default={account.id}
                onClick={() => makeDefault(account.id)}
              >
                Make default
              </button>
            )}
          </li>
        ))}
      </ul>
      {refused !== null && (
        <p className="m-0 flex items-start gap-xs text-meta text-err" role="alert">
          <TriangleAlert className="mt-0.5 shrink-0" size={14} aria-hidden="true" />
          This daemon refused the link: {refused}
        </p>
      )}
      <div className="flex flex-wrap gap-xs">
        <button
          type="button"
          className="kt-btn kt-btn--sm"
          data-variant="primary"
          data-project-accounts-save=""
          disabled={saving}
          onClick={save}
        >
          Save accounts
        </button>
        <button type="button" className="kt-btn kt-btn--sm" data-variant="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
