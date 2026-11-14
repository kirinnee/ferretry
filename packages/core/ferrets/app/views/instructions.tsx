/**
 * The `instructions` panel on `ferret.side`: the instruction files (CLAUDE.md, AGENTS.md, …) at the root of the ferret's folder,
 * with search and chips; a row opens the file in the ferret's Files panel. The listing is the Files panel's own
 * (`fsApi.list`), so what is offered is exactly what Files may serve — a file the daemon denies is not listed.
 */
import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';
import {
  ContextFailure,
  ContextFilterBar,
  ContextNote,
  contextEmptyCopy,
  type ContextRead,
  useContextRead,
} from '@ferretry/app/ui';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { fsApi } from '../features/files/files-api.ts';
import { requestFileOpen } from '../features/files/open-request.ts';
import type { FilesScope } from '../features/files/scope.ts';
import {
  type ContextDoc,
  type DocChip,
  docChips,
  docSize,
  DOCS_SEARCH_LABEL,
  instructionDocs,
  NO_DOCS,
  visibleDocs,
} from '../features/instructions/instructions-model.ts';
import type { LiveFerretsClient } from '../lib/client.ts';

/** This machine's own words for a failure: the panel is drawn per daemon and the daemon's name is the shell's. */
const MACHINE = 'This machine';

const ROW =
  'flex min-h-row w-full min-w-0 flex-col items-start gap-0.5 rounded-control bg-transparent px-xs py-xs text-left hover:bg-surface-2';

function DocsList({
  read,
  query,
  onQueryChange,
  chip,
  onChipChange,
  onOpenFile,
}: {
  readonly read: ContextRead<readonly ContextDoc[]>;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly chip: DocChip;
  readonly onChipChange: (chip: DocChip) => void;
  readonly onOpenFile: (path: string) => void;
}): ReactNode {
  const { load, reload } = read;
  if (load.kind === 'failed')
    return (
      <ContextFailure
        machineName={MACHINE}
        onRetry={reload}
        reason={load.reason}
        what="list this folder’s instructions"
      />
    );
  if (load.kind !== 'ready') return <ContextNote>Reading instructions…</ContextNote>;

  const docs = load.value;
  const chips = docChips(docs, query);
  const visible = visibleDocs(docs, query, chip);
  const chipLabel = chips.find(entry => entry.key === chip)?.label ?? 'All';
  const total = visibleDocs(docs, '', chip).length;

  return (
    <div className="flex min-w-0 flex-col gap-sm">
      <ContextFilterBar
        chip={chip}
        chips={chips}
        onChipChange={onChipChange}
        onQueryChange={onQueryChange}
        query={query}
        searchLabel={DOCS_SEARCH_LABEL}
      />
      {visible.length === 0 ? (
        <ContextNote>{contextEmptyCopy(NO_DOCS, total, query, chipLabel)}</ContextNote>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0" data-context-list="docs">
          {visible.map(doc => (
            <li key={doc.path}>
              <button
                aria-label={`Open ${doc.path} in a Files tab`}
                className={ROW}
                data-context-doc={doc.path}
                onClick={() => onOpenFile(doc.path)}
                type="button"
              >
                <span className="max-w-full truncate font-mono text-cell text-fg">{doc.name}</span>
                <span className="text-meta text-muted">
                  {[docSize(doc), 'opens in a Files tab'].filter(part => part !== '').join(' · ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One daemon's Instructions panel: built once per client, drawn for whichever ferret the shell names. */
export function createInstructionsPanel(client: LiveFerretsClient): AppComponent<PanelProps> {
  return function InstructionsPanel({ subject }: PanelProps): ReactNode {
    if (subject === undefined) return <ContextNote>Pick a ferret to see its instructions.</ContextNote>;
    return <FerretInstructions client={client} ferretId={subject} />;
  };
}

function FerretInstructions({ client, ferretId }: { readonly client: LiveFerretsClient; readonly ferretId: string }) {
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState<DocChip>('all');
  const scope: FilesScope = useMemo(() => ({ client, ferretId }), [client, ferretId]);
  const loader = useCallback(
    async (signal: AbortSignal): Promise<readonly ContextDoc[]> =>
      instructionDocs((await fsApi.list(scope, '', signal)).entries),
    [scope],
  );
  const read = useContextRead(loader, true);
  return (
    <DocsList
      chip={chip}
      onChipChange={setChip}
      onOpenFile={path => requestFileOpen(scope, path)}
      onQueryChange={setQuery}
      query={query}
      read={read}
    />
  );
}
