/**
 * ONE PROCESS, OPENED: who it is, what it has printed, and the way to stop it.
 *
 * The header says what the process is (the command in full — the list only shows a line of it — its pid,
 * kind, CPU and memory) and carries Stop when the daemon says it may be offered. The body follows the
 * process's output while the reader is at the bottom; scrolling up stops following and offers "Jump to
 * latest", so a reader looking back at an error is never yanked away from it by the next line.
 *
 * Output that cannot be read says why in the daemon's words, and for a process that writes to the
 * terminal offers the Console, where it can be seen.
 */

import type { SessionProcess } from '@ferretry/protocol';
import { ArrowDown, ChevronDown, ChevronUp, Copy, Search, Square, X } from 'lucide-react';
import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { findMatches, lineText, parseAnsi } from '../../lib/ansi.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import {
  formatMemory,
  PROCESSES_FORBIDDEN_TEXT,
  processElapsedText,
  processTitle,
} from '../../lib/session-processes.ts';
import type { ClipboardWriter } from '../onboarding/copy-button.tsx';
import { AnsiLines, type LineMatch } from './ansi-lines.tsx';
import { KIND_LABEL, KIND_MEANING } from './process-vocabulary.ts';
import { type ProcessOutputReader, useProcessOutput } from './use-session-processes.ts';

/** Within this many pixels of the bottom counts as "at the bottom": a fractional scroll position must not unfollow. */
const AT_BOTTOM_SLACK_PX = 24;

export interface ProcessDetailProps {
  readonly process: SessionProcess;
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  readonly now: number;
  readonly readOutput?: ProcessOutputReader;
  readonly outputPollMs?: number;
  readonly onClose: () => void;
  readonly onStop: (process: SessionProcess) => void;
  readonly onShowConsole: () => void;
  readonly onNotice: (text: string) => void;
  readonly writeClipboard: ClipboardWriter;
  readonly compact: boolean;
}

export function ProcessDetail({
  process,
  connection,
  scope,
  now,
  readOutput,
  outputPollMs,
  onClose,
  onStop,
  onShowConsole,
  onNotice,
  writeClipboard,
  compact,
}: ProcessDetailProps) {
  const title = processTitle(process);
  const facts = [
    `pid ${String(process.pid)}`,
    KIND_LABEL[process.kind],
    process.cpuPercent === undefined ? null : `CPU ${process.cpuPercent.toFixed(0)}%`,
    process.rssBytes === undefined ? null : formatMemory(process.rssBytes),
    processElapsedText(process, now),
  ].filter((fact): fact is string => fact !== null);

  return (
    <section
      aria-label={`Process ${title}`}
      className="fy-proc-detail"
      data-compact={compact ? '' : undefined}
      data-process-detail={process.id}
    >
      <header className="fy-proc-detail__head">
        <div className="fy-proc-detail__heading">
          <p className="fy-proc-detail__command mono" title={process.command}>
            {title}
          </p>
          {process.label !== undefined && process.label !== process.command ? (
            <p className="fy-proc-detail__raw mono text-meta text-muted" title={process.command}>
              {process.command}
            </p>
          ) : null}
          <p className="fy-proc-detail__facts text-meta text-muted">
            {facts.map((fact, index) => (
              <span key={fact}>
                {index === 0 ? '' : ' · '}
                <span title={fact === KIND_LABEL[process.kind] ? KIND_MEANING[process.kind] : undefined}>{fact}</span>
              </span>
            ))}
            {process.commandTruncated ? ' · command cut short' : ''}
          </p>
        </div>
        <div className="fy-proc-detail__actions">
          {process.stoppable ? (
            <button className="kt-btn kt-btn--sm" data-variant="danger" onClick={() => onStop(process)} type="button">
              <Square aria-hidden="true" size={12} /> Stop
            </button>
          ) : null}
          <button aria-label="Close process" className="kt-btn kt-btn--sm" onClick={onClose} type="button">
            <X aria-hidden="true" size={14} /> {compact ? 'Back' : 'Close'}
          </button>
        </div>
      </header>
      {process.output.source === 'none' ? (
        <div className="fy-proc-note-block" data-output-none="">
          <p className="text-ui text-muted">{process.output.reason ?? 'Its output cannot be read from here.'}</p>
          <button className="kt-btn kt-btn--sm" onClick={onShowConsole} type="button">
            Show the Console
          </button>
        </div>
      ) : (
        <ProcessOutputPane
          connection={connection}
          onNotice={onNotice}
          process={process}
          scope={scope}
          writeClipboard={writeClipboard}
          {...(readOutput === undefined ? {} : { readOutput })}
          {...(outputPollMs === undefined ? {} : { outputPollMs })}
        />
      )}
    </section>
  );
}

interface ProcessOutputPaneProps {
  readonly process: SessionProcess;
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  readonly readOutput?: ProcessOutputReader;
  readonly outputPollMs?: number;
  readonly writeClipboard: ClipboardWriter;
  readonly onNotice: (text: string) => void;
}

const focusAfterPaint = (ref: RefObject<HTMLElement | null>): void => {
  queueMicrotask(() => ref.current?.focus());
};

function ProcessOutputPane({
  process,
  connection,
  scope,
  readOutput,
  outputPollMs,
  writeClipboard,
  onNotice,
}: ProcessOutputPaneProps) {
  const state = useProcessOutput({
    connection,
    scope,
    processId: process.id,
    sourceKey: process.output.source,
    ...(readOutput === undefined ? {} : { reader: readOutput }),
    ...(outputPollMs === undefined ? {} : { pollMs: outputPollMs }),
  });
  const output = state.status === 'ready' || state.status === 'stale' ? state.output : null;
  const text = output?.text ?? '';
  const lines = useMemo(() => parseAnsi(text), [text]);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const findRef = useRef<HTMLInputElement | null>(null);
  const followRef = useRef(true);
  const [following, setFollowing] = useState(true);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(0);

  const matches = useMemo(() => findMatches(lines, query), [lines, query]);
  const byLine = useMemo(() => {
    const grouped = new Map<number, LineMatch[]>();
    matches.forEach((match, index) => {
      const own = grouped.get(match.line);
      const entry = { start: match.start, end: match.end, index };
      if (own === undefined) grouped.set(match.line, [entry]);
      else own.push(entry);
    });
    return grouped;
  }, [matches]);
  const currentIndex = matches.length === 0 ? 0 : Math.min(current, matches.length - 1);

  // Follow the end while the reader is at it. Runs when new lines arrive, not when a match is chosen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: lines is the trigger; the read is of the element
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body !== null && followRef.current) body.scrollTop = body.scrollHeight;
  }, [lines]);

  const onScroll = useCallback((): void => {
    const body = bodyRef.current;
    if (body === null) return;
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight <= AT_BOTTOM_SLACK_PX;
    followRef.current = atBottom;
    setFollowing(atBottom);
  }, []);

  const jumpToLatest = (): void => {
    const body = bodyRef.current;
    followRef.current = true;
    setFollowing(true);
    if (body !== null) body.scrollTop = body.scrollHeight;
  };

  // Bring the chosen match into view. Only a choice moves the view: an arriving line must not.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new choice, not new text, is the trigger
  useEffect(() => {
    if (!findOpen || matches.length === 0) return;
    const element = bodyRef.current?.querySelector('[data-current-match]');
    if (element === null || element === undefined) return;
    followRef.current = false;
    setFollowing(false);
    (element as HTMLElement).scrollIntoView?.({ block: 'center' });
  }, [currentIndex, query, findOpen]);

  const step = (direction: 1 | -1): void => {
    if (matches.length === 0) return;
    setCurrent((currentIndex + direction + matches.length) % matches.length);
  };

  const openFind = (): void => {
    setFindOpen(true);
    focusAfterPaint(findRef);
  };

  const closeFind = (): void => {
    setFindOpen(false);
    setQuery('');
    setCurrent(0);
    focusAfterPaint(bodyRef);
  };

  const onPaneKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      openFind();
    }
  };

  const onFindKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeFind();
    }
  };

  const copyAll = (): void => {
    writeClipboard(lines.map(lineText).join('\n')).then(
      () => onNotice('Copied'),
      () => onNotice('Copy was blocked — select the text instead'),
    );
  };

  const count =
    query === ''
      ? ''
      : matches.length === 0
        ? 'No matches'
        : `${String(currentIndex + 1)} of ${String(matches.length)}`;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the keydown only claims Ctrl/Cmd+F for the pane's own Find
    <div className="fy-proc-output" onKeyDown={onPaneKeyDown} data-process-output="">
      <div className="fy-proc-toolbar">
        <button
          aria-label="Copy output"
          className="kt-btn kt-btn--sm"
          disabled={text === ''}
          onClick={copyAll}
          type="button"
        >
          <Copy aria-hidden="true" size={14} /> Copy
        </button>
        <button
          aria-expanded={findOpen}
          aria-label="Find in output"
          className="kt-btn kt-btn--sm"
          onClick={() => (findOpen ? closeFind() : openFind())}
          type="button"
        >
          <Search aria-hidden="true" size={14} /> Find
        </button>
        {output?.source === 'transcript' ? (
          <span className="fy-proc-note" data-output-note="transcript">
            Final result from the conversation
          </span>
        ) : null}
        {output?.skipped ? (
          <span className="fy-proc-note" data-output-note="skipped">
            Earlier output not shown
          </span>
        ) : null}
        {state.status === 'stale' ? (
          <span className="fy-proc-note fy-proc-note--warn" role="status">
            Not up to date — {state.reason}
          </span>
        ) : null}
      </div>
      {findOpen ? (
        // biome-ignore lint/a11y/useSemanticElements: role="search" on a div; the <search> element is not in the React types yet
        <div className="fy-proc-find" role="search">
          <input
            aria-label="Find in output"
            className="fy-proc-find__input mono"
            onChange={event => {
              setQuery(event.target.value);
              setCurrent(0);
            }}
            onKeyDown={onFindKeyDown}
            placeholder="Find"
            ref={findRef}
            type="text"
            value={query}
          />
          <span aria-live="polite" className="fy-proc-find__count text-meta text-muted" data-find-count="">
            {count}
          </span>
          <button
            aria-label="Previous match"
            className="kt-btn kt-btn--sm"
            disabled={matches.length === 0}
            onClick={() => step(-1)}
            type="button"
          >
            <ChevronUp aria-hidden="true" size={14} />
          </button>
          <button
            aria-label="Next match"
            className="kt-btn kt-btn--sm"
            disabled={matches.length === 0}
            onClick={() => step(1)}
            type="button"
          >
            <ChevronDown aria-hidden="true" size={14} />
          </button>
          <button aria-label="Close find" className="kt-btn kt-btn--sm" onClick={closeFind} type="button">
            <X aria-hidden="true" size={14} />
          </button>
        </div>
      ) : null}
      <div className="fy-proc-body-wrap">
        <div
          aria-label={`Output of ${processTitle(process)}`}
          className="fy-proc-body mono"
          onScroll={onScroll}
          ref={bodyRef}
          role="log"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable log must be reachable by keyboard to scroll it
          tabIndex={0}
        >
          {state.status === 'loading' ? (
            <p className="fy-proc-empty text-muted">Loading output…</p>
          ) : state.status === 'forbidden' ? (
            <p className="fy-proc-empty text-err" role="alert">
              {PROCESSES_FORBIDDEN_TEXT}
            </p>
          ) : state.status === 'error' ? (
            <p className="fy-proc-empty text-err" role="alert">
              {state.reason}
            </p>
          ) : lines.length === 0 ? (
            <p className="fy-proc-empty text-muted">{output?.complete ? 'It printed nothing.' : 'No output yet.'}</p>
          ) : (
            <AnsiLines currentMatch={currentIndex} lines={lines} matches={byLine} />
          )}
        </div>
        {following ? null : (
          <button
            className="fy-proc-jump kt-btn kt-btn--sm"
            data-variant="primary"
            onClick={jumpToLatest}
            type="button"
          >
            <ArrowDown aria-hidden="true" size={14} /> Jump to latest
          </button>
        )}
      </div>
    </div>
  );
}
