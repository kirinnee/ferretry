/**
 * STEP 1: PICK A FOLDER (or a place to clone into). The explorer is the picker; on a phone it opens in a sheet so the
 * folder list gets the whole screen and the step keeps its place underneath.
 */
import { BottomSheet, useLayoutMode } from '@ferretry/app/ui';
import { useId, useState } from 'react';
import type { ProjectsClient } from '../../lib/client.ts';
import { FolderPicker } from '../folder-explorer/folder-picker.tsx';
import { type CreateDraft, projectFolder } from './create-project-model.ts';

export interface FolderStepProps {
  readonly client: ProjectsClient;
  readonly draft: CreateDraft;
  readonly onDraftChange: (draft: CreateDraft) => void;
  readonly onNext: () => void;
}

const SOURCES = [
  {
    source: 'folder',
    label: 'A folder on this machine',
    detail: 'Use a folder that is already here, or make a new one.',
  },
  { source: 'clone', label: 'Clone a repository', detail: 'Download a repository into a folder you pick.' },
] as const;

export function FolderStep({ client, draft, onDraftChange, onNext }: FolderStepProps) {
  const urlId = useId();
  const phone = useLayoutMode() === 'drawer';
  const [sheet, setSheet] = useState(false);
  const chosen = projectFolder(draft);
  const choose = (path: string): void => {
    onDraftChange({ ...draft, folder: path });
    setSheet(false);
  };
  const picker = (
    <FolderPicker
      client={client}
      chooseLabel={draft.source === 'clone' ? 'Clone into this folder' : 'Use this folder'}
      onChoose={choose}
    />
  );

  return (
    <div className="grid gap-md" data-create-step="folder">
      <fieldset className="relative m-0 grid gap-xs border-0 p-0 sm:grid-cols-2">
        <legend className="sr-only">Where the project comes from</legend>
        {SOURCES.map(option => {
          const checked = draft.source === option.source;
          return (
            <label
              key={option.source}
              data-create-source={option.source}
              className={`flex min-h-control cursor-pointer flex-col justify-center gap-0.5 rounded-control border px-control-x py-2 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus ${
                checked
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-border bg-surface-2 text-fg hover:border-accent'
              }`}
            >
              <input
                type="radio"
                name="create-project-source"
                className="sr-only"
                checked={checked}
                onChange={() => onDraftChange({ ...draft, source: option.source })}
              />
              <span className="text-ui font-semibold">{option.label}</span>
              <span className="text-meta leading-tight text-muted">{option.detail}</span>
            </label>
          );
        })}
      </fieldset>

      {draft.source === 'clone' && (
        <label className="grid min-w-0 gap-1 text-ui text-muted" htmlFor={urlId}>
          Repository address
          <input
            id={urlId}
            className="kt-input mono min-h-control w-full"
            value={draft.url}
            placeholder="https://github.com/you/project.git"
            autoComplete="off"
            spellCheck={false}
            onChange={event => onDraftChange({ ...draft, url: event.target.value })}
          />
        </label>
      )}

      {chosen !== null && (
        <p className="m-0 text-meta text-muted" data-create-chosen="">
          {draft.source === 'clone' ? 'Will be cloned to' : 'Chosen'}:{' '}
          <span className="mono break-all text-fg">{chosen}</span>
        </p>
      )}

      {phone ? (
        <>
          <div>
            <button type="button" className="kt-btn min-h-control" onClick={() => setSheet(true)}>
              {draft.folder === null ? 'Choose a folder' : 'Choose a different folder'}
            </button>
          </div>
          <BottomSheet
            id="create-project-folders"
            open={sheet}
            onClose={() => setSheet(false)}
            ariaLabel="Choose a folder"
            closeLabel="Close folder list"
            height="85dvh"
          >
            <div className="grid min-h-0 gap-sm overflow-y-auto p-panel">{picker}</div>
          </BottomSheet>
        </>
      ) : (
        picker
      )}

      <div>
        <button
          type="button"
          className="kt-btn min-h-control"
          data-variant="primary"
          disabled={chosen === null}
          onClick={onNext}
        >
          Next
        </button>
      </div>
    </div>
  );
}
