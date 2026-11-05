/**
 * The command that replaces a key by hand — `fy secret set NAME` — as code with a copy button beside it.
 *
 * A copy and a clone never replace a key the machine already holds, so the way to change one is this command,
 * run by the person on that machine. It carries the key's NAME and nothing else: no value exists here, and the
 * person types the value into their own terminal. The control is the touch-sized one: the command is the only
 * way to take it, and on a phone selecting it by hand is miserable.
 */

import { type ClipboardWriter, CopyButton } from '../onboarding/copy-button.tsx';
import { replaceKeyCommand } from './secret-clone-model.ts';

export function ReplaceKeyCommand({ name, write }: { readonly name: string; readonly write: ClipboardWriter }) {
  const command = replaceKeyCommand(name);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1" data-replace-key-command={name}>
      <code className="min-w-0 flex-1 select-all break-all rounded-control border border-code-border bg-code-bg px-2 py-1 font-mono text-cell text-code-fg">
        {command}
      </code>
      <CopyButton label="Copy command" text={command} touch write={write} />
    </span>
  );
}
