/**
 * The DICTATION DEBUG SHEET — one cleanup call laid open: what was sent, what came back, what the
 * checks did with it, and the words that were kept.
 *
 * It reads a `DictationDebugRecord` the in-memory ring holds (`lib/stt/dictation-debug.ts`); it
 * fetches nothing and keeps nothing of its own. The record can contain dictated text and the
 * conversation that went along with it, so the sheet says where it lives: this tab's memory, gone on
 * reload. A credential can never be in it — the request headers were recorded already redacted — so
 * they are shown exactly as given.
 *
 * Each section collapses and has its own Copy button, so one part can go into a bug report without
 * the rest. The last section is the whole record as raw JSON in monospace, for the person who wants
 * to diff two calls. The sheet is the app's one modal shell (`BottomSheet`), so Escape, the focus
 * trap and the swipe-down all behave like every other sheet.
 */

import type { CleanupTrace, CleanupTraceAttempt } from '@ferretry/protocol';
import { Bug, Check, ChevronDown, ChevronRight, Copy, TriangleAlert, X } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { browserClipboardWriter, type ClipboardWriter } from '../features/onboarding/copy-button.tsx';
import { cn } from '../lib/class-names.ts';
import type { DictationDebugRecord } from '../lib/stt/dictation-debug.ts';
import { BottomSheet } from '../shell/bottom-sheet.tsx';
import { Button } from '../shell/primitives.tsx';
import { DictationTimelineDetails, timelineText } from './dictation-timeline-bar.tsx';

export interface DictationDebugSheetProps {
  readonly record: DictationDebugRecord;
  readonly onClose: () => void;
  /** The clipboard the Copy buttons write to; the browser's by default. */
  readonly copy?: ClipboardWriter;
}

const PRE =
  'mono m-0 max-h-72 overflow-auto scroll-thin whitespace-pre-wrap break-words rounded-control bg-surface-2 p-2 text-meta leading-base text-fg';

const milliseconds = (value: number): string => `${String(Math.round(value))} ms`;

const utc = (epoch: number): string => `${new Date(epoch).toISOString().slice(0, 19).replace('T', ' ')} UTC`;

const attemptLabel = (trace: CleanupTrace, index: number): string =>
  trace.attempts.length === 1
    ? ''
    : `Attempt ${String(index + 1)} — ${trace.attempts[index]?.withContext ? 'with the conversation' : 'without the conversation'}`;

type Row = readonly [label: string, value: string | undefined];

const usageText = (attempt: CleanupTraceAttempt): string | undefined => {
  const usage = attempt.response?.usage;
  if (usage === undefined) return undefined;
  return Object.entries({
    prompt: usage.promptTokens,
    completion: usage.completionTokens,
    total: usage.totalTokens,
    reasoning: usage.reasoningTokens,
  })
    .filter(([, count]) => count !== undefined)
    .map(([name, count]) => `${name} ${String(count)}`)
    .join(' · ');
};

function overviewRows({ trace, at }: DictationDebugRecord): readonly Row[] {
  const rows: Row[] = [
    ['Provider', trace.provider],
    ['Model', trace.model],
    ['Endpoint host', trace.host],
    ['Path', trace.via === 'device' ? 'This browser, with its own key' : 'The daemon'],
    ['Outcome', trace.outcome.replace('_', ' ')],
    ['Started', utc(trace.startedAt ?? at)],
    ['Total time', milliseconds(trace.totalMs)],
    [
      'Failure',
      trace.failure === undefined ? undefined : `${trace.failure.code ?? 'failed'}: ${trace.failure.message}`,
    ],
  ];
  trace.attempts.forEach((attempt, index) => {
    const prefix = trace.attempts.length === 1 ? '' : `Attempt ${String(index + 1)} · `;
    rows.push(
      [`${prefix}HTTP status`, attempt.status === undefined ? undefined : String(attempt.status)],
      [
        `${prefix}First byte`,
        attempt.timings.firstByteMs === undefined ? undefined : milliseconds(attempt.timings.firstByteMs),
      ],
      [`${prefix}Attempt time`, milliseconds(attempt.timings.totalMs)],
      [`${prefix}Finish reason`, attempt.response?.finishReason],
      [`${prefix}Tokens`, usageText(attempt)],
    );
  });
  return rows.filter((row): row is readonly [string, string] => row[1] !== undefined);
}

const textOf = (rows: readonly Row[]): string => rows.map(([label, value]) => `${label}: ${value}`).join('\n');

const requestText = (attempt: CleanupTraceAttempt): string =>
  [
    `POST https://${attempt.request.host}${attempt.request.path}`,
    JSON.stringify(attempt.request.headers, null, 2),
    JSON.stringify(attempt.request.params, null, 2),
    ...attempt.request.messages.map(message => `[${message.role}]\n${message.content}`),
  ].join('\n\n');

const responseText = (attempt: CleanupTraceAttempt): string =>
  [
    attempt.failure === undefined ? undefined : `Failure: ${attempt.failure}`,
    attempt.errorBody === undefined ? undefined : `Provider body:\n${attempt.errorBody}`,
    attempt.response?.reasoning === undefined ? undefined : `[reasoning]\n${attempt.response.reasoning}`,
    attempt.response?.content === undefined ? undefined : `[content]\n${attempt.response.content}`,
    attempt.response === undefined ? undefined : `[raw]\n${attempt.response.raw}`,
  ]
    .filter(part => part !== undefined)
    .join('\n\n');

const stepsText = (attempt: CleanupTraceAttempt): string => {
  const response = attempt.response;
  if (response === undefined) return 'No reply reached the checks.';
  return [
    ...response.steps.map(
      step => `${step.step.replaceAll('_', ' ')}${step.detail === undefined ? '' : ` — ${step.detail}`}`,
    ),
    `Verdict: ${response.verdict.replace('_', ' ')}${response.reason === undefined ? '' : ` — ${response.reason}`}`,
  ].join('\n');
};

const perAttempt = (trace: CleanupTrace, render: (attempt: CleanupTraceAttempt) => string): string =>
  trace.attempts
    .map((attempt, index) => [attemptLabel(trace, index), render(attempt)].filter(Boolean).join('\n'))
    .join('\n\n');

type CopyState = 'idle' | 'copied' | 'failed';

/** Copy one section. A refusal is said in words: a silent failure would leave a bug report empty. */
function CopyAction({
  text,
  label,
  write,
}: {
  readonly text: string;
  readonly label: string;
  readonly write: ClipboardWriter;
}) {
  const [state, setState] = useState<CopyState>('idle');
  const run = (): void => {
    void write(text).then(
      () => setState('copied'),
      () => setState('failed'),
    );
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        'min-h-[44px] shrink-0 gap-1 px-2',
        state === 'copied' && 'text-ok',
        state === 'failed' && 'text-warn',
      )}
      aria-label={`Copy ${label}`}
      data-copy-state={state}
      onClick={run}
    >
      {state === 'copied' ? <Check size={14} aria-hidden="true" /> : null}
      {state === 'failed' ? <TriangleAlert size={14} aria-hidden="true" /> : null}
      {state === 'idle' ? <Copy size={14} aria-hidden="true" /> : null}
      <span className="text-ui">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy blocked' : 'Copy'}</span>
    </Button>
  );
}

function Section({
  title,
  copyText,
  write,
  defaultOpen = false,
  children,
}: {
  readonly title: string;
  readonly copyText: string;
  readonly write: ClipboardWriter;
  readonly defaultOpen?: boolean;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section className="border-t border-border-soft" data-debug-section={title}>
      <div className="flex min-w-0 items-center gap-xs">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(current => !current)}
          className="flex min-h-[44px] min-w-0 flex-1 items-center gap-1 text-left text-ui font-semibold text-fg"
        >
          <Chevron size={15} aria-hidden="true" className="shrink-0 text-muted" />
          {title}
        </button>
        <CopyAction text={copyText} label={title.toLowerCase()} write={write} />
      </div>
      <div id={bodyId} hidden={!open} className="grid gap-2 pb-3">
        {open ? children : null}
      </div>
    </section>
  );
}

function Labelled({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-meta font-semibold text-muted">{label}</span>
      {children}
    </div>
  );
}

function AttemptHeading({ trace, index }: { readonly trace: CleanupTrace; readonly index: number }) {
  const label = attemptLabel(trace, index);
  return label === '' ? null : <h3 className="m-0 text-ui font-semibold text-accent">{label}</h3>;
}

export function DictationDebugSheet({ record, onClose, copy }: DictationDebugSheetProps) {
  const write = copy ?? browserClipboardWriter();
  const headingId = useId();
  const { trace } = record;
  const rows = overviewRows(record);

  return (
    <BottomSheet
      id="dictation-debug"
      open
      onClose={onClose}
      labelledBy={headingId}
      closeLabel="Close dictation details"
      panelClassName="kt-details bg-surface"
      maxHeight="min(90dvh, calc(var(--app-h, 100dvh) - var(--gap-xs)))"
      zIndexClass="z-50"
    >
      <div className="mx-auto w-full max-w-3xl shrink-0 px-panel pb-row-y">
        <div className="flex items-center gap-sm">
          <Bug aria-hidden="true" className="shrink-0 text-accent" size={15} />
          <h1
            id={headingId}
            className="m-0 min-w-0 flex-1 font-display text-title font-semibold tracking-display text-fg"
          >
            Dictation details
          </h1>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-[44px] min-w-[44px] justify-center"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </div>
        <p className="m-0 mt-1 text-meta leading-base text-muted" data-debug-notice>
          Held in memory on this device only. Gone on reload.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-panel pb-4">
        <div className="mx-auto w-full max-w-3xl">
          <Section title="Overview" copyText={textOf(rows)} write={write} defaultOpen>
            <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-ui">
              {rows.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted">{label}</dt>
                  <dd className="m-0 min-w-0 break-words text-fg">{value}</dd>
                </div>
              ))}
            </dl>
          </Section>

          {record.timeline === undefined ? null : (
            <Section title="Timeline" copyText={timelineText(record.timeline)} write={write} defaultOpen>
              <DictationTimelineDetails timeline={record.timeline} />
            </Section>
          )}

          <Section title="Request" copyText={perAttempt(trace, requestText)} write={write}>
            {trace.attempts.map((attempt, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the two attempts are positional and never reorder
              <div key={index} className="grid min-w-0 gap-2">
                <AttemptHeading trace={trace} index={index} />
                <Labelled label="Endpoint">
                  <pre className={PRE}>{`POST https://${attempt.request.host}${attempt.request.path}`}</pre>
                </Labelled>
                <Labelled label="Headers (secrets redacted)">
                  <pre className={PRE}>{JSON.stringify(attempt.request.headers, null, 2)}</pre>
                </Labelled>
                <Labelled label="Parameters">
                  <pre className={PRE}>{JSON.stringify(attempt.request.params, null, 2)}</pre>
                </Labelled>
                {attempt.request.messages.map((message, position) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: messages are positional
                  <Labelled key={position} label={`Message ${String(position + 1)} · ${message.role}`}>
                    <pre className={PRE}>{message.content}</pre>
                  </Labelled>
                ))}
              </div>
            ))}
          </Section>

          <Section title="Raw response" copyText={perAttempt(trace, responseText)} write={write}>
            {trace.attempts.map((attempt, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the two attempts are positional and never reorder
              <div key={index} className="grid min-w-0 gap-2">
                <AttemptHeading trace={trace} index={index} />
                {attempt.failure === undefined ? null : <p className="m-0 text-ui text-warn">{attempt.failure}</p>}
                {attempt.errorBody === undefined ? null : (
                  <Labelled label="Provider body">
                    <pre className={PRE}>{attempt.errorBody}</pre>
                  </Labelled>
                )}
                {attempt.response?.reasoning === undefined ? null : (
                  <Labelled label="Reasoning (before stripping)">
                    <pre className={PRE}>{attempt.response.reasoning}</pre>
                  </Labelled>
                )}
                {attempt.response?.content === undefined ? null : (
                  <Labelled label="Message content (before stripping)">
                    <pre className={PRE}>{attempt.response.content}</pre>
                  </Labelled>
                )}
                {attempt.response === undefined ? null : (
                  <Labelled label="Provider JSON">
                    <pre className={PRE}>{attempt.response.raw}</pre>
                  </Labelled>
                )}
              </div>
            ))}
          </Section>

          <Section title="Post-processing" copyText={perAttempt(trace, stepsText)} write={write}>
            {trace.attempts.map((attempt, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the two attempts are positional and never reorder
              <div key={index} className="grid min-w-0 gap-2">
                <AttemptHeading trace={trace} index={index} />
                <pre className={PRE}>{stepsText(attempt)}</pre>
              </div>
            ))}
          </Section>

          <Section title="Final text" copyText={trace.finalText ?? ''} write={write} defaultOpen>
            {trace.finalText === undefined ? (
              <p className="m-0 text-ui text-muted">
                No text was kept: the call failed before a reply could be judged.
              </p>
            ) : (
              <pre className={PRE}>{trace.finalText}</pre>
            )}
          </Section>

          <Section title="Raw JSON" copyText={JSON.stringify(record, null, 2)} write={write}>
            <pre className={PRE} data-debug-json>
              {JSON.stringify(record, null, 2)}
            </pre>
          </Section>
        </div>
      </div>
    </BottomSheet>
  );
}
