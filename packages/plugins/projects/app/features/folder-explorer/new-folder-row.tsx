/**
 * "New folder", inline: a name field and a button in the row above the entries, never a dialog. The daemon's own rule
 * for a name is checked as you type (`newFolderProblem`), and its refusal, if it still refuses, is shown as it worded it.
 * The name stays after a refusal so nothing has to be typed again.
 */
import { Button } from '@ferretry/app/ui';
import { FolderPlus } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { newFolderProblem } from './folders-api.ts';

export interface NewFolderRowProps {
  /** Makes the folder; answers `null` when it was made, else the daemon's sentence. */
  readonly onMake: (name: string) => Promise<string | null>;
  readonly onCancel: () => void;
}

export function NewFolderRow({ onMake, onCancel }: NewFolderRowProps) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => field.current?.focus(), []);
  const problem = newFolderProblem(name) ?? refused;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (name === '' || busy || newFolderProblem(name) !== null) return;
    setBusy(true);
    void onMake(name).then(sentence => {
      setBusy(false);
      setRefused(sentence);
    });
  };

  return (
    <form className="grid gap-1" onSubmit={submit} aria-label="New folder" data-explorer-new-folder="">
      <div className="flex flex-wrap items-center gap-xs">
        <label className="sr-only" htmlFor={id}>
          New folder name
        </label>
        <input
          id={id}
          ref={field}
          className="kt-input min-h-control min-w-0 flex-1"
          value={name}
          placeholder="Folder name"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          aria-invalid={problem !== null}
          onChange={event => {
            setName(event.target.value);
            setRefused(null);
          }}
          onKeyDown={event => {
            if (event.key === 'Escape') onCancel();
          }}
        />
        <Button
          type="submit"
          size="sm"
          disabled={name === ''}
          busy={busy}
          icon={<FolderPlus size={14} aria-hidden="true" />}
        >
          Create
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
      {problem !== null && (
        <p className="m-0 text-meta text-err" role="alert" data-explorer-new-folder-problem="">
          {problem}
        </p>
      )}
    </form>
  );
}
