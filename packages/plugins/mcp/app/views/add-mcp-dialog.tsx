/** The Add MCP server form in a dialog: Escape and a click outside close it; focus stays inside while it is open. */
import { useDialogFocus } from '@ferretry/app/ui';
import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { FALLBACK_FERRET_NAME } from '../lib/add-model.ts';
import { type FerretRow, type McpClient, readFerret } from '../lib/client.ts';
import { AddMcpForm } from './add-mcp-form.tsx';

export function AddMcpDialog({
  client,
  ferretId,
  name,
  onClose,
}: {
  readonly client: McpClient;
  readonly ferretId: string;
  /** The ferret's display name, when the surface already has it; otherwise it is read from Ferrets. */
  readonly name?: string;
  readonly onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [ferret, setFerret] = useState<FerretRow | null>(null);
  // This ferret's name and runtime come from Ferrets' own route; a refused read leaves the words general, never blocks the form.
  useEffect(() => {
    let live = true;
    readFerret(client, ferretId).then(
      row => live && setFerret(row),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, ferretId]);
  const titleId = useId();
  const { onKeyDown } = useDialogFocus(true, ref, onClose);
  return (
    <div
      className="fixed inset-0 z-[60] flex items-end bg-scrim p-2 sm:items-center sm:justify-center"
      role="presentation"
    >
      <button type="button" aria-label="Close" className="absolute inset-0" onClick={onClose} />
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="relative flex max-h-full w-full max-w-md flex-col gap-md overflow-y-auto rounded-panel border border-border bg-surface p-4"
        onKeyDown={onKeyDown}
        ref={ref}
        role="dialog"
        data-add-mcp-dialog=""
      >
        <header className="flex items-center justify-between gap-sm">
          <h2 className="m-0 text-cell font-semibold" id={titleId}>
            Add MCP server
          </h2>
          <button type="button" aria-label="Close" className="kt-btn h-9 w-9 shrink-0 p-0" onClick={onClose}>
            <X aria-hidden="true" size={15} />
          </button>
        </header>
        <AddMcpForm
          agentName={name ?? ferret?.name ?? FALLBACK_FERRET_NAME}
          client={client}
          ferretId={ferretId}
          host={{ close: onClose }}
          {...(ferret?.runtime === undefined ? {} : { login: ferret.runtime })}
        />
      </div>
    </div>
  );
}
