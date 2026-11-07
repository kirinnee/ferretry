/**
 * The `files` panel on `ferret.side`: the read-only file browser of ONE ferret, drawn beside its chat. The shell hands a
 * panel its `subject` (the ferret id); every read goes through the half's own client by route key, and the daemon has
 * already masked secret values in what it answers — this panel draws exactly that and offers no way around it.
 */
import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';
import { useMemo } from 'react';
import type { LiveFerretsClient } from '../lib/client.ts';
import '../features/files/files.css';
import { FilesTab } from '../features/files/files-tab.tsx';

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
    if (scope === null) return <NoFerret />;
    return <FilesTab scope={scope} />;
  };
}
