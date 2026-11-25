/** The address Claude is given, with a copy button; the one fact the owner carries to Claude's own settings. */
import { browserClipboardWriter, CopyButton } from '@ferretry/app/ui';
import { ADDRESS_HELP } from '../lib/words.ts';

const write = browserClipboardWriter();

export function AddressRow({ mcpUrl }: { readonly mcpUrl: string }) {
  return (
    <li className="flex min-w-0 flex-col gap-1 px-panel py-3" data-connector-url-row="">
      <p className="m-0 text-cell leading-base text-muted">{ADDRESS_HELP}</p>
      <div className="flex min-w-0 items-center gap-2">
        <code
          data-connector-url=""
          className="min-w-0 flex-1 select-all break-all rounded-input border border-border-soft bg-surface-2 px-[max(0.5rem,var(--radius-input))] py-1 text-cell text-fg"
        >
          {mcpUrl}
        </code>
        <CopyButton text={mcpUrl} label="Copy the connector address" write={write} touch />
      </div>
    </li>
  );
}
