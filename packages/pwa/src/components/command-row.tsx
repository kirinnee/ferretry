/**
 * A slash command the human ran, as ONE compact row:
 *
 *   /model opus[1m] → Set model to Opus 5.5 (1M context)
 *
 * The command and its arguments are mono, because they are what was typed; what
 * the command printed follows in muted text, because it is the harness talking,
 * not a person. It is never a "You" bubble — nobody said it — and it carries no
 * card of its own, so it sits in the transcript's quiet tier beside a tool run.
 *
 * Output that runs past one line opens on click into the same comfortable code
 * surface a tool result uses. A command that wrote to stderr reads in the error
 * tone with the red triangle, exactly like a failed tool: a failure that faded
 * into the background would be a bug.
 */

import { ChevronRight, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/class-names.ts';
import { commandOutputIsLong, commandOutputSummary, type SlashCommand } from '../lib/slash-commands.ts';
import { CodeBlock } from './code-block.tsx';

export function CommandRow({ command }: { readonly command: SlashCommand }) {
  const [open, setOpen] = useState(false);
  const failed = command.tone === 'err';
  const output = command.output;
  const long = output !== undefined && commandOutputIsLong(output);
  const summary = output === undefined ? undefined : commandOutputSummary(output);

  const line = (
    <>
      {command.name === '' ? null : (
        <span className="fy-command-call mono">
          {command.name}
          {command.args === undefined ? null : <span className="fy-command-args"> {command.args}</span>}
        </span>
      )}
      {command.name !== '' && summary !== undefined ? (
        <span aria-hidden="true" className="fy-command-arrow">
          →
        </span>
      ) : null}
      {summary === undefined ? null : (
        <span className="fy-command-output" title={summary}>
          {summary}
        </span>
      )}
      {failed ? <TriangleAlert aria-hidden="true" className="fy-command-alert shrink-0 text-err" size={11} /> : null}
      {long ? (
        <ChevronRight
          aria-hidden="true"
          className={cn('fy-command-chevron shrink-0 transition-transform', open && 'rotate-90')}
          size={11}
        />
      ) : null}
    </>
  );

  return (
    <div className="fy-command" data-command-tone={command.tone}>
      {long ? (
        <button
          aria-expanded={open}
          className="fy-command-line fy-command-toggle"
          onClick={() => setOpen(value => !value)}
          type="button"
        >
          {line}
        </button>
      ) : (
        <div className="fy-command-line">{line}</div>
      )}
      {open && long && output !== undefined ? (
        <div className="fy-command-body">
          <CodeBlock code={output} tone={failed ? 'err' : 'default'} />
        </div>
      ) : null}
    </div>
  );
}
