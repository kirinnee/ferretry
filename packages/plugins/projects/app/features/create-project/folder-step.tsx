/**
 * STEP 1: PICK A FOLDER (or a place to clone into). The explorer is the picker; the folder that is open when Next is
 * pressed is the chosen one, so there is no separate "Use this folder" button to press first.
 */
import { ChoiceCards, StepPageFrame, type StepProgressProps } from '@ferretry/app';
import { useLayoutMode } from '@ferretry/app/ui';
import { FolderOpen, GitBranch } from 'lucide-react';
import { useCallback, useId, useState } from 'react';
import type { ProjectsClient } from '../../lib/client.ts';
import { FolderPicker } from '../folder-explorer/folder-picker.tsx';
import { type CreateDraft, projectFolder } from './create-project-model.ts';

export interface FolderStepProps {
  readonly client: ProjectsClient;
  readonly draft: CreateDraft;
  readonly progress: StepProgressProps;
  readonly onDraftChange: (draft: CreateDraft) => void;
  readonly onNext: () => void;
}

const SOURCES = [
  {
    id: 'folder',
    title: 'A folder on this machine',
    line: 'Use a folder that is already here, or make a new one.',
    icon: <FolderOpen size={18} aria-hidden="true" />,
  },
  {
    id: 'clone',
    title: 'Clone a repository',
    line: 'Download a repository into a folder you pick.',
    icon: <GitBranch size={18} aria-hidden="true" />,
  },
] as const;

export function FolderStep({ client, draft, progress, onDraftChange, onNext }: FolderStepProps) {
  const urlId = useId();
  // On a phone the cards drop their second line, so the folder list gets the room.
  const phone = useLayoutMode() === 'drawer';
  // The folder open in the explorer right now. Coming back from the next page reopens where the person was.
  const [opened, setOpened] = useState<string | null>(draft.folder);
  const onOpened = useCallback((path: string) => setOpened(path), []);
  // While the next folder is read the picker still shows the previous one: Next must not commit that old path.
  const [busy, setBusy] = useState(true);
  const target = opened === null ? null : projectFolder({ ...draft, folder: opened });

  return (
    <StepPageFrame
      title={draft.source === 'clone' ? 'Where should it go?' : 'Which folder?'}
      line={
        draft.source === 'clone'
          ? 'Paste the repository address, then pick the folder to clone it into.'
          : 'Open the folder that holds your project, then press Next.'
      }
      progress={progress}
      next={{
        label: 'Next',
        disabled: target === null || busy,
        onClick: () => {
          if (opened === null || busy) return;
          onDraftChange({ ...draft, folder: opened });
          onNext();
        },
      }}
    >
      <div className="grid max-w-[660px] gap-md" data-create-step="folder">
        <ChoiceCards
          label="Where the project comes from"
          options={phone ? SOURCES.map(({ line: _line, ...rest }) => rest) : SOURCES}
          value={draft.source}
          onChange={id => onDraftChange({ ...draft, source: id === 'clone' ? 'clone' : 'folder' })}
        />

        {draft.source === 'clone' && (
          <label className="grid min-w-0 max-w-xl gap-1 text-ui text-muted" htmlFor={urlId}>
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

        <FolderPicker client={client} startAt={draft.folder ?? undefined} onOpened={onOpened} onBusyChange={setBusy} />

        {target !== null && (
          <p className="m-0 text-meta text-muted" data-create-chosen="">
            {draft.source === 'clone' ? 'Will be cloned to' : 'Chosen'}:{' '}
            <span className="mono break-all text-fg">{target}</span>
          </p>
        )}
      </div>
    </StepPageFrame>
  );
}
