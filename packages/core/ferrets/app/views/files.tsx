/**
 * The `files` panel on `ferret.side`: the read-only file browser of ONE ferret, drawn beside its chat. The shell hands a
 * panel its `subject` (the ferret id); every read goes through the half's own client by route key, and the daemon has
 * already masked secret values in what it answers — this panel draws exactly that and offers no way around it.
 */
import { useOptionalRouter } from '@ferretry/app';
import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';
import { useMemo } from 'react';
import type { LiveFerretsClient } from '../lib/client.ts';
import '../features/files/files.css';
import { FilesTab } from '../features/files/files-tab.tsx';
import { addressOpenRequest, markAddressHandled } from '../features/files/address-file.ts';
import { useFileOpenRequest } from '../features/files/open-request.ts';

const NoFerret = () => (
  <div className="kt-fs rounded-md border border-border bg-surface">
    <div className="kt-fs-note" role="status">
      Pick a ferret to browse its files.
    </div>
  </div>
);

/** One daemon's Files panel: built once per client, drawn for whichever ferret the shell names. */
export function createFilesPanel(client: LiveFerretsClient): AppComponent<PanelProps> {
  return function FilesPanel({ subject }: PanelProps) {
    const scope = useMemo(() => (subject === undefined ? null : { client, ferretId: subject }), [subject]);
    // The Instructions list (and any other panel of this ferret) asks Files to open a file through `open-request.ts`.
    const asked = useFileOpenRequest(scope);
    // A page that is not a panel of this ferret (Projects' file finder) names a file in the address (`?file=`): it is
    // opened once, through the same gated read, unless a panel asked for another file since.
    // "Acted on" is per history entry (a fresh navigation to an address visited before still opens its file).
    const entry = useOptionalRouter()?.entryKey ?? '';
    const requestedReference =
      asked ?? addressOpenRequest(entry, globalThis.location?.pathname ?? '', globalThis.location?.search ?? '');
    if (scope === null) return <NoFerret />;
    return (
      <FilesTab
        onRequestedReferenceHandled={() =>
          markAddressHandled(entry, globalThis.location?.pathname ?? '', globalThis.location?.search ?? '')
        }
        requestedReference={requestedReference}
        scope={scope}
      />
    );
  };
}
