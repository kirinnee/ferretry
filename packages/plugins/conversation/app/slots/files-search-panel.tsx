/**
 * THE CURRENT-FERRET FILE SEARCH in Ferrets' file browser (`panels['files-search']`, slot `ferrets.files-search`,
 * contract/slots.ts of Ferrets). The browser hands the ferret and a way to open one of its files; this mounts the
 * search over that ferret's file index, as today's Files pane drew it.
 *
 * The board is not read here: with no card source the search holds files only (`NO_BOARD`), so a card result — and
 * the "open the tasks" opener that would follow it — never occurs.
 */

import { isFilesSearchSlotProps } from '@ferretry/core-ferrets/contract';
import type { PanelProps } from '@ferretry/kernel/manifest';
import { type ReactNode, useEffect, useMemo } from 'react';
import { useConversationDaemon } from '../client.ts';
import { SessionSearchControl, SessionSearchProvider, useSessionSearch } from '../search/session-search.tsx';

/** Binds the file opener of the page the search sits in. */
function BindOpeners({ openFile }: { readonly openFile: (path: string) => void }): null {
  const { setOpeners } = useSessionSearch();
  useEffect(() => {
    setOpeners({ openFile, openTasks: () => undefined });
    return () => setOpeners(null);
  }, [openFile, setOpeners]);
  return null;
}

/** The panel: nothing unless the slot's props are the browser's and a daemon is known. */
export function FilesSearchPanel(props: PanelProps): ReactNode {
  const daemon = useConversationDaemon();
  const slot = isFilesSearchSlotProps(props) ? props : null;
  const scope = useMemo(
    () => (slot === null || daemon === undefined ? null : { daemon, ferret: slot.ferret }),
    [daemon, slot?.ferret],
  );
  if (slot === null || scope === null) return null;
  return (
    <SessionSearchProvider scope={scope}>
      <BindOpeners openFile={slot.openFile} />
      <SessionSearchControl />
    </SessionSearchProvider>
  );
}
