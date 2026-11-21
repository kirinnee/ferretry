/**
 * CHANGE WHICH GITHUB ACCOUNTS AN EXISTING PROJECT LINKS. The create flow's accounts step is the only other place that
 * writes these, so without this a project registered before an account was connected could never be linked, and PR watch
 * (which reads the link) could never work for it.
 *
 * The write is the whole ordered list (`PUT /v1/projects/:id/accounts`), the first being the project's default, the
 * same call the create flow makes. A link to an account that no longer exists is kept as it is: it is shown by the
 * links list as "account removed", and this editor never drops a choice the person did not touch.
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
      <ul className="m-0 grid list-none divide-y divide-border-soft p-0">
        {existing.map(account => (
          <li key={account.id}>
            <label
              className="flex min-h-control cursor-pointer items-center gap-sm py-1 text-ui"
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
