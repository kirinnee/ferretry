/**
 * "FOLDER" ON THE WHERE-IT-WORKS FIELD: the folder in use, one-tap recent folders, and Browse… — the same finder project
 * setup uses (path box, New folder, "Use this folder"). A pick only proposes a folder through `onPick`; the page's start
 * and the daemon's fence decide.
 */
import { FolderSearch } from 'lucide-react';
import { useState } from 'react';
import type { ProjectsClient } from '../lib/client.ts';
import { FolderPicker as FolderFinder } from '../features/folder-explorer/folder-picker.tsx';
import { WhereSurface } from './new-ferret-where-surface.tsx';

/** Quick picks shown before the finder: the fastest way back to where the last ferrets worked. */
const RECENT_SHOWN = 4;

const baseName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;

export interface WhereFolderProps {
  readonly client: ProjectsClient;
  readonly id: string;
  readonly value: string;
  readonly recent: readonly string[];
  readonly onPick: (folder: string) => void;
}

export function WhereFolder({ client, id, value, recent, onPick }: WhereFolderProps) {
  const [browsing, setBrowsing] = useState(false);
  const quick = recent.slice(0, RECENT_SHOWN);
  return (
    <div className="grid gap-2" data-new-ferret-where-folder="">
      <div className="flex items-stretch gap-sm">
        <input
          className="kt-input min-w-0 flex-1 truncate font-mono"
          id={id}
          placeholder="Choose a folder"
          readOnly
          title={value}
          value={value}
        />
        <button
          aria-expanded={browsing}
          className="kt-btn !h-auto inline-flex shrink-0 items-center gap-1.5"
          data-where-browse=""
          onClick={() => setBrowsing(open => !open)}
          type="button"
        >
          <FolderSearch aria-hidden="true" size={16} />
          Browse…
        </button>
      </div>
      {quick.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-1.5" data-where-recent="">
          <span className="text-meta text-faint">Recent</span>
          {quick.map(path => (
            <button
              aria-pressed={value === path}
              className="min-h-[36px] max-w-full truncate rounded-control border border-border-strong bg-surface px-2.5 text-meta text-fg hover:border-border aria-pressed:border-fg"
              data-where-recent-folder={path}
              key={path}
              onClick={() => onPick(path)}
              title={path}
              type="button"
            >
              {baseName(path)}
            </button>
          ))}
        </div>
      )}
      <WhereSurface onClose={() => setBrowsing(false)} open={browsing} title="Choose a folder">
        <FolderFinder
          chooseLabel="Use this folder"
          client={client}
          onChoose={path => {
            onPick(path);
            setBrowsing(false);
          }}
          {...(value === '' ? {} : { startAt: value })}
        />
      </WhereSurface>
    </div>
  );
}
