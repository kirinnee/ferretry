/**
 * A run of consecutive tool calls, collapsed into ONE slim group line.
 *
 * ASYMMETRIC DENSITY (styles/index.css): tools are background texture, not
 * content. Everything at rest lives in the `.kt-chrome` tier — 11px / 1.35 in
 * `--chrome-fg` — a clear step below the 13–13.75px message text around it. The
 * collapsed state is a SINGLE line with no card, no border, no background and no
 * decorative icon of its own:
 *
 *   collapsed:  4 tools · Bash, Edit ×2, Read                        ✓
 *   running:    Bash · bun test — 34s                                ◌
 *   expanded:   one slim line per call, each openable to input + result
 *
 * Two things deliberately keep their weight:
 *   - a RUNNING tool (the accent spinner) — that is live status, not history;
 *   - an ERROR (the red triangle) — a failure that faded into the background
 *     would be a bug, not a density win.
 *
 * Expansion is opt-in on click and brings back full-size code surfaces: you
 * opened it on purpose, so the body should be comfortable to read.
 */

import {
  Check,
  ChevronRight,
  FilePenLine,
  FilePlus,
  FileText,
  Hourglass,
  ListTodo,
  Search,
  Terminal,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { memo, useState } from 'react';
import { type LiveScheduler, useLiveElapsed } from '../hooks/use-live-counter.ts';
import { cn } from '../lib/class-names.ts';
import { formatElapsedSeconds, instantMs, wholeSecondsSince } from '../lib/live-counter.ts';
import type { ToolCall } from '../lib/session-screens.ts';
import {
  type AskedQuestion,
  type ExtractedTool,
  extractToolSummary,
  langFromPath,
  parseExecOutput,
  readAskedQuestions,
  resultText,
  type ToolKind,
  toolColorVar,
} from '../lib/tool-extract.ts';
import { CodeBlock } from './code-block.tsx';
import { QuestionCard } from './question-card.tsx';
import { Spinner } from './spinner.tsx';
import { type NamedTranscriptImage, TranscriptImages, toolImageAlt } from './transcript-images.tsx';

const iconFor = (kind: ToolKind) => {
  switch (kind) {
    case 'bash':
      return Terminal;
    case 'read':
      return FileText;
    case 'write':
      return FilePlus;
    case 'edit':
    case 'patch':
      return FilePenLine;
    case 'search':
      return Search;
    case 'plan':
      return ListTodo;
    case 'wait':
      return Hourglass;
    default:
      return Wrench;
  }
};

/** "Bash, Edit ×2, Read" from the run's verbs, order-preserving. */
export const summarizeToolRun = (calls: readonly ToolCall[]): string => {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const call of calls) {
    const verb = call.orphanResult ? 'result' : extractToolSummary(call.use.name, call.use.input).verb;
    if (!counts.has(verb)) order.push(verb);
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  return order.map(verb => ((counts.get(verb) ?? 0) > 1 ? `${verb} ×${counts.get(verb)}` : verb)).join(', ');
};

/** How long a running tool has been going, as a label. Undefined when the call
 *  carries no usable start time — a wrong duration is worse than none. */
export const elapsedLabel = (since: string | undefined, now: number): string | undefined => {
  const start = instantMs(since);
  return start === null ? undefined : formatElapsedSeconds(wholeSecondsSince(start, now));
};

/** The reading of a bare result whose tool use never arrived. */
const ORPHAN_RESULT: ExtractedTool = {
  verb: 'result',
  headline: 'tool result',
  bodyLines: [],
  kind: 'generic',
  isExec: false,
};

function Elapsed({ since, scheduler }: { readonly since?: string; readonly scheduler?: LiveScheduler | undefined }) {
  // Ticks on the call's own seconds (`useLiveElapsed`), so `4s` becomes `5s` exactly five seconds
  // after the tool started, not whenever a shared interval or a store update happens to land. This
  // span is its own element, so its per-second write is not what breaks a reader's selection.
  const seconds = useLiveElapsed(instantMs(since), scheduler === undefined ? {} : { scheduler });
  if (seconds === null) return null;
  return <span className="mono shrink-0 tabular-nums">— {formatElapsedSeconds(seconds)}</span>;
}

export interface ToolGroupProps {
  readonly calls: readonly ToolCall[];
  /** The session is actively working. */
  readonly live: boolean;
  /** This is the final block in the transcript. */
  readonly isLast: boolean;
  /** Injectable so a suite drives the running tool's clock; the browser's own otherwise. */
  readonly scheduler?: LiveScheduler;
}

/**
 * A question call keeps its weight: it is content the owner answers, not texture. It is split out of
 * the run so it is never folded into an "N tools" count; the calls around it still collapse.
 */
export const ToolGroup = memo(function ToolGroup({ calls, live, isLast, scheduler }: ToolGroupProps) {
  const segments: { readonly questions?: readonly AskedQuestion[]; readonly calls: ToolCall[] }[] = [];
  for (const call of calls) {
    const questions = call.orphanResult ? null : readAskedQuestions(call.use, call.result);
    const tail = segments[segments.length - 1];
    if (questions !== null) segments.push({ questions, calls: [call] });
    else if (tail !== undefined && tail.questions === undefined) tail.calls.push(call);
    else segments.push({ calls: [call] });
  }
  return (
    <>
      {segments.map((segment, index) =>
        segment.questions === undefined ? (
          <ToolRun
            calls={segment.calls}
            isLast={isLast && index === segments.length - 1}
            key={segment.calls[0]?.key}
            live={live}
            scheduler={scheduler}
          />
        ) : (
          <QuestionCard key={segment.calls[0]?.key} questions={segment.questions} />
        ),
      )}
    </>
  );
});

const ToolRun = memo(function ToolRun({ calls, live, isLast, scheduler }: ToolGroupProps) {
  const [open, setOpen] = useState(false);
  /**
   * WHICH CALLS THE READER OPENED, held by the run rather than by each line. A lone finished call is
   * drawn as a bare line and the same call inside a group as a child of it, so the moment a second
   * call finishes the line moves in the tree — and state kept in the line would close under the
   * reader. Opening a lone line also opens the group it will become part of.
   */
  const [openCalls, setOpenCalls] = useState<ReadonlySet<string>>(() => new Set());
  const toggleCall = (key: string): void => {
    const opening = !openCalls.has(key);
    setOpenCalls(current => {
      const next = new Set(current);
      if (opening) next.add(key);
      else next.delete(key);
      return next;
    });
    if (opening) setOpen(true);
  };

  // The trailing unfinished call of a live session is "running".
  const lastCall = calls[calls.length - 1];
  const running = live && isLast && lastCall !== undefined && !lastCall.result && !lastCall.orphanResult;

  // A running tool is live status, so it never hides inside the collapsed count:
  // it gets its own named line (verb · headline · elapsed) below the history.
  // The finished calls collapse into the group above it — even in a large merged
  // run you can still see exactly which tool is live.
  const history = running ? calls.slice(0, -1) : calls;
  const anyError = history.some(call => call.result?.isError);
  const runningLine = running && lastCall !== undefined ? <RunningLine call={lastCall} scheduler={scheduler} /> : null;

  // A single running tool with nothing finished yet: just the live line.
  if (history.length === 0) return runningLine;

  // A single finished tool renders its own line — one click to the body, with no
  // redundant group wrapper around the common case.
  const first = history[0];
  if (history.length === 1 && first !== undefined) {
    return (
      <>
        <ToolLine call={first} onToggle={toggleCall} open={openCalls.has(first.key)} />
        {runningLine}
      </>
    );
  }

  const StatusIcon = anyError ? TriangleAlert : Check;

  return (
    <>
      <div className="kt-chrome">
        <button
          className="flex w-full items-center gap-1.5 rounded-control px-2 py-px text-left hover:bg-surface-2"
          onClick={() => setOpen(value => !value)}
          type="button"
        >
          <span className="mono shrink-0">{history.length} tools</span>
          <span className="mono min-w-0 flex-1 truncate">· {summarizeToolRun(history)}</span>
          <StatusIcon aria-hidden="true" className={cn('shrink-0', anyError && 'kt-chrome-alert text-err')} size={10} />
          <ChevronRight
            aria-hidden="true"
            className={cn('shrink-0 transition-transform', open && 'rotate-90')}
            size={10}
          />
        </button>

        {open ? (
          <div className="border-l border-border-soft pl-1.5">
            {history.map(call => (
              <ToolLine call={call} key={call.key} onToggle={toggleCall} open={openCalls.has(call.key)} />
            ))}
          </div>
        ) : null}
      </div>
      {runningLine}
    </>
  );
});

/** A dedicated slim status line for the live tool (spinner + elapsed). Still
 *  chrome-sized, but the spinner keeps the accent: this is the one tool state
 *  that is live information rather than a record of the past. */
function RunningLine({ call, scheduler }: { readonly call: ToolCall; readonly scheduler?: LiveScheduler | undefined }) {
  const summary = extractToolSummary(call.use.name, call.use.input);
  return (
    <div className="kt-chrome flex items-center gap-1.5 px-2 py-px">
      <Spinner size={11} />
      <span className="mono shrink-0">{summary.verb}</span>
      <span className="mono min-w-0 flex-1 truncate">· {summary.headline}</span>
      <Elapsed scheduler={scheduler} since={call.ts} />
    </div>
  );
}

function ToolLine({
  call,
  open,
  onToggle,
}: {
  readonly call: ToolCall;
  readonly open: boolean;
  readonly onToggle: (key: string) => void;
}) {
  const summary = call.orphanResult ? ORPHAN_RESULT : extractToolSummary(call.use.name, call.use.input);
  const Icon = iconFor(summary.kind);
  const failed = call.result?.isError === true;
  const raw = call.result ? resultText(call.result) : null;
  const text = raw !== null && summary.isExec ? parseExecOutput(raw).cleanText : raw;
  // A picture a tool returned is the ferret looking, not something shown to the owner: it stays behind
  // the row's chevron and is only mounted — so only fetched — once the row is open.
  const images = (call.result?.images ?? []).map(
    (marker): NamedTranscriptImage => ({
      marker,
      alt: toolImageAlt(call.use.name),
    }),
  );
  const pictureOnly = text === '' && images.length > 0;
  const cleaned = pictureOnly ? null : text;
  const hasBody = summary.bodyLines.length > 0 || (call.result !== undefined && !pictureOnly) || images.length > 0;

  const bodyLang = bodyLanguage(summary);
  const resultLang = langFromPath(summary.filePath);

  return (
    <div className="kt-chrome">
      <button
        className={cn(
          'flex w-full items-center gap-1.5 rounded-control px-1.5 py-px text-left',
          hasBody ? 'cursor-pointer hover:bg-surface-2' : 'cursor-default',
        )}
        onClick={() => hasBody && onToggle(call.key)}
        type="button"
      >
        {/* The per-tool hue is kept but shrunk to 10px and left un-boosted, so it
            reads as a bullet you can scan by colour rather than as an icon
            claiming a row of its own. */}
        <Icon aria-hidden="true" className="shrink-0" size={10} style={{ color: toolColorVar(summary.kind) }} />
        <span className="mono shrink-0">{summary.verb}</span>
        <span className="mono min-w-0 flex-1 truncate" title={summary.headline}>
          {summary.headline}
        </span>
        {failed ? <TriangleAlert aria-hidden="true" className="kt-chrome-alert shrink-0 text-err" size={10} /> : null}
        {!failed && call.result !== undefined ? <Check aria-hidden="true" className="shrink-0" size={10} /> : null}
        {hasBody ? (
          <ChevronRight
            aria-hidden="true"
            className={cn('shrink-0 transition-transform', open && 'rotate-90')}
            size={10}
          />
        ) : null}
      </button>
      {open && hasBody ? (
        <div className="mb-1 ml-1.5 mt-0.5 space-y-1">
          {summary.bodyLines.length > 0 ? <CodeBlock code={summary.bodyLines.join('\n')} lang={bodyLang} /> : null}
          {cleaned !== null ? (
            <div>
              <div className="kt-label px-1 pb-0.5">
                {failed ? 'error' : 'result'} · {cleaned.split('\n').length} lines
              </div>
              <CodeBlock code={cleaned} lang={failed ? undefined : resultLang} tone={failed ? 'err' : 'default'} />
            </div>
          ) : null}
          {images.length > 0 ? <TranscriptImages className="fy-tool-images" images={images} initialLimit={3} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** How the INPUT body reads: a command is bash, an edit or patch is a diff, a
 *  write is the language of the file it wrote. */
export const bodyLanguage = (summary: ExtractedTool): string | undefined => {
  if (summary.kind === 'bash') return 'bash';
  if (summary.kind === 'edit' || summary.kind === 'patch') return 'diff';
  if (summary.kind === 'write') return langFromPath(summary.filePath);
  return undefined;
};
