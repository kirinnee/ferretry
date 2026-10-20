/**
 * Something the HARNESS typed into the user channel, as one quiet line in the transcript's chrome tier:
 *
 *   ⚙ Background command finished  direnv exec . task setup   exit 0
 *
 * Claude Code writes a background command finishing, a Monitor's output, a subagent's result or an
 * interrupt as a USER record, because the user channel is the only one it reads back. Drawn as a "You"
 * bubble, each read as the reader saying `<task-notification>…` — so it is a system row instead, like a
 * slash command beside it (`command-row.tsx`): no card, muted, and the outcome in its tone. A failure
 * reads in the error tone; a failure that faded into the background would be a bug.
 *
 * Nothing is dropped: each line opens on click to what it carried — the whole command, a subagent's
 * result, a monitor's event, and the output file's path as TEXT. That path is on the agent's machine,
 * so it is never a link: there is nothing in this app it could open. A block with no task in it opens
 * to its raw text.
 */

import { Bot, ChevronRight, Cog, TriangleAlert } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cn } from '../lib/class-names.ts';
import {
  type BackgroundTaskEvent,
  backgroundTaskTitle,
  type SystemBlockInfo,
  type SystemBlockTone,
  systemBlockTitle,
} from '../lib/system-blocks.ts';
import { CodeBlock } from './code-block.tsx';

type Rhythm = Record<string, string | undefined>;

const MESSAGE_LABELS = new Set(['agent message', 'coordinator message']);

export function HarnessEventRow({ event, rhythm }: { readonly event: SystemBlockInfo; readonly rhythm: Rhythm }) {
  const tasks = event.tasks ?? [];
  return (
    <div
      className="fy-message fy-message-system fy-message-chrome fy-message-harness"
      data-harness-event={event.label}
      data-transcript-kind="system"
      role="note"
      {...rhythm}
    >
      {tasks.length > 0 ? (
        tasks.map((task, index) => (
          // A notification's tasks are positional and never reorder: the record is immutable.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above.
          <TaskLine key={index} task={task} />
        ))
      ) : (
        <EventLine
          body={<CodeBlock code={event.raw} />}
          icon={MESSAGE_LABELS.has(event.label) ? 'message' : 'event'}
          subject={event.summary}
          title={systemBlockTitle(event)}
          tone={event.tone}
        />
      )}
    </div>
  );
}

function TaskLine({ task }: { readonly task: BackgroundTaskEvent }) {
  const failed = task.tone === 'err';
  const body = (
    <>
      {task.kind === 'command' && task.subject !== undefined ? <CodeBlock code={task.subject} lang="bash" /> : null}
      {task.detail === undefined ? null : <CodeBlock code={task.detail} tone={failed ? 'err' : 'default'} />}
      {task.outputFile === undefined ? null : (
        <p className="fy-harness-event-file">
          Output file <code className="mono">{task.outputFile}</code>
        </p>
      )}
    </>
  );
  const expandable = task.detail !== undefined || task.outputFile !== undefined || task.kind === 'command';
  return (
    <EventLine
      body={expandable ? body : undefined}
      chip={task.exitCode === undefined ? undefined : `exit ${task.exitCode}`}
      icon="event"
      mono={task.kind === 'command'}
      subject={task.subject}
      title={backgroundTaskTitle(task)}
      tone={task.tone}
    />
  );
}

function EventLine({
  title,
  subject,
  chip,
  tone,
  icon,
  mono = false,
  body,
}: {
  readonly title: string;
  readonly subject?: string;
  readonly chip?: string;
  readonly tone?: SystemBlockTone;
  readonly icon: 'event' | 'message';
  readonly mono?: boolean;
  readonly body?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const Icon = icon === 'message' ? Bot : Cog;
  const line = (
    <>
      <Icon aria-hidden="true" className="fy-harness-event-icon shrink-0" size={11} />
      <span className="fy-harness-event-title">{title}</span>
      {subject === undefined ? null : (
        <span className={cn('fy-harness-event-subject', mono && 'mono')} title={subject}>
          {subject}
        </span>
      )}
      {chip === undefined ? null : <span className="fy-harness-event-chip">{chip}</span>}
      {tone === 'err' ? <TriangleAlert aria-hidden="true" className="shrink-0 text-err" size={11} /> : null}
      {body === undefined ? null : (
        <ChevronRight
          aria-hidden="true"
          className={cn('fy-harness-event-chevron shrink-0 transition-transform', open && 'rotate-90')}
          size={11}
        />
      )}
    </>
  );
  return (
    <div className="fy-harness-event" data-event-tone={tone}>
      {body === undefined ? (
        <div className="fy-harness-event-line">{line}</div>
      ) : (
        <button
          aria-expanded={open}
          className="fy-harness-event-line fy-harness-event-toggle"
          onClick={() => setOpen(value => !value)}
          type="button"
        >
          {line}
        </button>
      )}
      {open && body !== undefined ? <div className="fy-harness-event-body">{body}</div> : null}
    </div>
  );
}
