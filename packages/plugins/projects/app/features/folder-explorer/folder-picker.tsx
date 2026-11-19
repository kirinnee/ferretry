/**
 * THE EXPLORER BOUND TO ONE DAEMON: it reads the listing, makes folders, and remembers the view on this device.
 * Making a folder opens it, so "New folder" then "Use this folder" is two presses.
 */
import { useLayoutMode } from '@ferretry/app/ui';
import { useState } from 'react';
import { type ProjectsClient, reasonOf } from '../../lib/client.ts';
import { FolderExplorer } from './folder-explorer.tsx';
import { resolveView } from './explorer-model.ts';
import { explorerViewPreference } from './explorer-view-preference.ts';
import { makeFolder } from './folders-api.ts';
import { useFolderListing } from './use-folder-listing.ts';

export interface FolderPickerProps {
  readonly client: ProjectsClient;
  /** Where to open; the home folder when omitted. */
  readonly startAt?: string;
  readonly onChoose: (path: string) => void;
  readonly chooseLabel?: string;
}

export function FolderPicker({ client, startAt, onChoose, chooseLabel }: FolderPickerProps) {
  const [path, setPath] = useState<string | undefined>(startAt);
  const [showHidden, setShowHidden] = useState(false);
  const state = useFolderListing(client, path, showHidden);
  const choice = explorerViewPreference.use();
  const phone = useLayoutMode() === 'drawer';

  return (
    <FolderExplorer
      listing={state.listing}
      loading={state.loading}
      error={state.error}
      view={resolveView(choice, phone)}
      onViewChange={explorerViewPreference.write}
      showHidden={showHidden}
      onShowHiddenChange={setShowHidden}
      onOpen={setPath}
      onChoose={onChoose}
      {...(chooseLabel === undefined ? {} : { chooseLabel })}
      onMakeFolder={async name => {
        if (state.listing === null) return 'The folder list has not been read yet.';
        try {
          const made = await makeFolder(client, state.listing.path, name);
          setPath(made.path);
          return null;
        } catch (cause) {
          return reasonOf(cause);
        }
      }}
    />
  );
}
