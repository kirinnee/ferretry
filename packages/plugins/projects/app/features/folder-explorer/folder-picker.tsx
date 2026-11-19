/**
 * THE EXPLORER BOUND TO ONE DAEMON: it reads the listing, makes folders, and remembers the view on this device.
 * Making a folder opens it, so "New folder" then "Use this folder" is two presses.
 */
import { useLayoutMode } from '@ferretry/app/ui';
import { useEffect, useState } from 'react';
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
  /** Draws "Use this folder" under the list. Omitted when the caller's own button takes the open folder (`onOpened`). */
  readonly onChoose?: (path: string) => void;
  /** The folder that is open now, whenever it changes: a stepper's Next uses it. */
  readonly onOpened?: (path: string) => void;
  readonly chooseLabel?: string;
}

export function FolderPicker({ client, startAt, onChoose, onOpened, chooseLabel }: FolderPickerProps) {
  const [path, setPath] = useState<string | undefined>(startAt);
  const [showHidden, setShowHidden] = useState(false);
  const state = useFolderListing(client, path, showHidden);
  const choice = explorerViewPreference.use();
  const phone = useLayoutMode() === 'drawer';
  const openPath = state.listing?.path;
  useEffect(() => {
    if (openPath !== undefined) onOpened?.(openPath);
  }, [openPath, onOpened]);

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
      {...(onChoose === undefined ? {} : { onChoose })}
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
