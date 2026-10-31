import type { SessionLogSearch } from '@ferretry/protocol';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import {
  CHAT_SEARCH_SETTLE_MS,
  type ChatSearchState,
  type ChatSearchWho,
  currentMatch,
  EMPTY_CHAT_SEARCH,
  matchLabel,
  occurrences,
  rowForOffset,
  stepMatch,
  withResults,
} from '../lib/chat-search.ts';

/** What the chat's search needs from the daemon and from the chat's history. */
export interface ChatSearchPort {
  /** The whole transcript searched (`IFyApiClient.logSearch`). */
  readonly search: (
    query: string,
    options: { readonly who: ChatSearchWho; readonly tools: boolean; readonly signal: AbortSignal },
  ) => Promise<SessionLogSearch>;
  /** Load the chat's history back to `offset` of file `file`; `false` when it cannot. */
  readonly reach: (offset: number, file: string) => Promise<boolean>;
}

/** How many frames a jump waits for the rows it loaded to be drawn. */
const ROW_WAIT_FRAMES = 60;

/** The highlight names the stylesheet paints (`::highlight(...)`). */
const ALL = 'fy-search';
const CURRENT = 'fy-search-current';

/** The CSS Custom Highlight API, where the browser has it. */
const highlights = (): { set(name: string, value: unknown): void; delete(name: string): void } | undefined => {
  const registry = (globalThis.CSS as { highlights?: unknown } | undefined)?.highlights;
  return typeof globalThis.Highlight === 'function' && registry !== undefined
    ? (registry as { set(name: string, value: unknown): void; delete(name: string): void })
    : undefined;
};

/** The transcript's rows that say where they begin, in order. */
const placedRows = (root: HTMLElement): { readonly offset: number; readonly row: HTMLElement }[] =>
  [...root.querySelectorAll<HTMLElement>('[data-transcript-offset]')].map(row => ({
    offset: Number(row.dataset.transcriptOffset),
    row,
  }));

/**
 * Paints every occurrence of `query` in the transcript, and the current row's more strongly — as ranges
 * over the text nodes React already drew, never by changing them, so nothing is re-rendered and no markup
 * is written. A browser without the API still gets the current row marked.
 */
const paint = (root: HTMLElement, query: string, current: HTMLElement | undefined): void => {
  for (const marked of root.querySelectorAll('[data-search-current]')) marked.removeAttribute('data-search-current');
  current?.setAttribute('data-search-current', '');
  const registry = highlights();
  if (registry === undefined) return;
  const all: Range[] = [];
  const near: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    for (const [start, end] of occurrences(node.textContent ?? '', query)) {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      (current?.contains(node) === true ? near : all).push(range);
    }
  }
  registry.set(ALL, new Highlight(...all));
  registry.set(CURRENT, new Highlight(...near));
};

const unpaint = (root: HTMLElement | null): void => {
  for (const marked of root?.querySelectorAll('[data-search-current]') ?? [])
    marked.removeAttribute('data-search-current');
  highlights()?.delete(ALL);
  highlights()?.delete(CURRENT);
};

/**
 * Brings `row` to the middle of the transcript's scroller — or its top, when it is taller than the
 * screen — as the READER's scroll: a wheel event first, so the chat stops following the tail and the
 * next message to arrive does not pull the reader away from the match.
 */
const reveal = (scroller: HTMLElement, row: HTMLElement): void => {
  scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
  const box = scroller.getBoundingClientRect();
  const place = row.getBoundingClientRect();
  const margin = 48;
  const centred = place.top - box.top - (scroller.clientHeight - place.height) / 2;
  const top = place.height > scroller.clientHeight - 2 * margin ? place.top - box.top - margin : centred;
  scroller.scrollTop += top;
  // Said at once rather than when the browser gets round to it: a pin for content that lands first would
  // otherwise put a still-following chat back at its tail.
  scroller.dispatchEvent(new Event('scroll'));
};

export interface ChatSearchProps {
  readonly port: ChatSearchPort;
  /** The element holding the transcript (`.fy-transcript` inside it is the scroller). */
  readonly transcript: RefObject<HTMLElement | null>;
  /** The agent's name, for the "only the agent's messages" filter. */
  readonly agentName: string;
  readonly onClose: () => void;
  /** Bumped to put the caret back in the box (Ctrl/Cmd-F while it is open). */
  readonly focusSignal?: number;
}

/**
 * The chat's search bar: a box, "3 of 27", ↑ and ↓, and who and what to search. It searches the whole
 * conversation, jumps to a match by loading the history back to it, and paints every match in place.
 */
export function ChatSearch({ port, transcript, agentName, onClose, focusSignal = 0 }: ChatSearchProps) {
  const [state, setState] = useState<ChatSearchState>(EMPTY_CHAT_SEARCH);
  const [unreached, setUnreached] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the signal is the trigger
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusSignal]);

  // ---- ASK: once typing settles, and again for a change of who or what; a newer ask aborts an older one.
  useEffect(() => {
    const query = state.query.trim();
    if (query === '') {
      setState(current => ({ ...EMPTY_CHAT_SEARCH, who: current.who, tools: current.tools }));
      return;
    }
    const abort = new AbortController();
    setState(current => ({ ...current, status: 'searching' }));
    const timer = setTimeout(() => {
      port
        .search(query, { who: state.who, tools: state.tools, signal: abort.signal })
        .then(answer => {
          if (!abort.signal.aborted) setState(current => withResults(current, answer));
        })
        .catch((reason: unknown) => {
          if (abort.signal.aborted) return;
          setState(current => ({
            ...current,
            status: 'error',
            matches: [],
            current: null,
            error: reason instanceof Error ? reason.message : String(reason),
          }));
        });
    }, CHAT_SEARCH_SETTLE_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [port, state.query, state.who, state.tools]);

  // ---- JUMP: load the history back to the current match, then bring its row into view and paint.
  const match = currentMatch(state);
  useEffect(() => {
    const root = transcript.current;
    if (root === null) return;
    if (match === undefined || state.file === null) {
      unpaint(root);
      setUnreached(false);
      return;
    }
    let live = true;
    const file = state.file;
    void port
      .reach(match.offset, file)
      .catch(() => false)
      .then(reached => {
        if (!live) return;
        // The pages it loaded are drawn when React commits them, which may be a frame or two later: the row
        // is looked for each frame until the drawn rows reach back to the match, or the wait runs out.
        let frames = 0;
        const look = (): void => {
          if (!live) return;
          const rows = placedRows(root);
          const drawn = reached && (rows[0]?.offset ?? Number.POSITIVE_INFINITY) <= match.offset;
          if (!drawn && reached && frames < ROW_WAIT_FRAMES) {
            frames += 1;
            requestAnimationFrame(look);
            return;
          }
          const row = rowForOffset(rows, match.offset);
          const scroller = root.querySelector<HTMLElement>('.fy-transcript');
          if (row !== undefined && scroller !== null) reveal(scroller, row);
          paint(root, state.query.trim(), row);
          setUnreached(!reached || row === undefined);
        };
        requestAnimationFrame(look);
      });
    return () => {
      live = false;
    };
  }, [match, port, state.file, state.query, transcript]);

  // ---- KEEP PAINTED as rows arrive or re-render, and wipe the paint when the bar closes.
  useEffect(() => {
    const root = transcript.current;
    if (root === null || match === undefined || typeof MutationObserver === 'undefined') return;
    let frame: number | undefined;
    const observer = new MutationObserver(() => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        paint(root, state.query.trim(), root.querySelector<HTMLElement>('[data-search-current]') ?? undefined);
      });
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [match, state.query, transcript]);
  useEffect(() => () => unpaint(transcript.current), [transcript]);

  const step = useCallback((direction: 'older' | 'newer') => setState(current => stepMatch(current, direction)), []);
  const setWho = (who: ChatSearchWho): void => setState(current => ({ ...current, who }));
  const label = matchLabel(state);
  const none = state.current === null;

  return (
    <search aria-label="Search this conversation" className="fy-chat-search">
      <div className="fy-chat-search__row">
        <Search aria-hidden="true" className="fy-chat-search__icon" size={14} />
        <input
          aria-label="Search this conversation"
          className="fy-chat-search__input"
          enterKeyHint="search"
          onChange={event => {
            const query = event.currentTarget.value;
            setState(current => ({ ...current, query }));
          }}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            } else if (event.key === 'Enter') {
              event.preventDefault();
              step(event.shiftKey ? 'newer' : 'older');
            }
          }}
          placeholder="Search this conversation"
          ref={input}
          type="search"
          value={state.query}
        />
        <span aria-live="polite" className="fy-chat-search__count" data-search-status={state.status}>
          {label}
        </span>
        <button
          aria-label="Previous match (older)"
          className="fy-chat-search__button"
          disabled={none}
          onClick={() => step('older')}
          title="Previous match (Enter)"
          type="button"
        >
          <ChevronUp aria-hidden="true" size={16} />
        </button>
        <button
          aria-label="Next match (newer)"
          className="fy-chat-search__button"
          disabled={none}
          onClick={() => step('newer')}
          title="Next match (Shift+Enter)"
          type="button"
        >
          <ChevronDown aria-hidden="true" size={16} />
        </button>
        <button
          aria-label="Close search"
          className="fy-chat-search__button"
          onClick={onClose}
          title="Close (Esc)"
          type="button"
        >
          <X aria-hidden="true" size={16} />
        </button>
      </div>
      <div className="fy-chat-search__filters">
        <fieldset className="fy-chat-search__who">
          <legend className="sr-only">Whose messages</legend>
          {(
            [
              ['all', 'Everyone'],
              ['me', 'Only mine'],
              ['agent', `Only ${agentName === '' ? 'the ferret' : agentName}`],
            ] as const
          ).map(([who, words]) => (
            <button
              aria-pressed={state.who === who}
              className="fy-chat-search__chip"
              key={who}
              onClick={() => setWho(who)}
              type="button"
            >
              {words}
            </button>
          ))}
        </fieldset>
        <label className="fy-chat-search__tools">
          <input
            checked={state.tools}
            onChange={event => {
              const tools = event.currentTarget.checked;
              setState(current => ({ ...current, tools }));
            }}
            type="checkbox"
          />
          Tools &amp; thinking
        </label>
      </div>
      {state.status === 'error' && state.error !== null ? (
        <p className="fy-chat-search__note" role="alert">
          {state.error}
        </p>
      ) : unreached && match !== undefined ? (
        <p className="fy-chat-search__note">
          That match is further back than the chat can load right now. Its words: “{match.snippet}”
        </p>
      ) : null}
    </search>
  );
}
