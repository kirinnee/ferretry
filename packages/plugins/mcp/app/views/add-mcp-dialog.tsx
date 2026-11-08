/** The Add MCP server form in a dialog: Escape and a click outside close it; focus stays inside while it is open. */
import { useDialogFocus } from '@ferretry/app/ui';
import { X } from 'lucide-react';
import { useId, useRef } from 'react';
import type { McpClient } from '../lib/client.ts';
import { AddMcpForm } from './add-mcp-form.tsx';

export function AddMcpDialog({
  client,
  ferretId,
  name,
  onClose,
}: {
  readonly client: McpClient;
  readonly ferretId: string;
  /** The ferret's display name, for the words. */
  readonly name: string;
  readonly onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
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
        <AddMcpForm agentName={name} client={client} ferretId={ferretId} host={{ close: onClose }} />
      </div>
    </div>
  );
}
