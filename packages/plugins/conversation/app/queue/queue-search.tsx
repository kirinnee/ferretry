// THE QUEUE PAGE'S SEARCH BOX AND ITS "NOTHING MATCHED" STATE (G6).
//
// A native search input, so the keyboard, the screen reader and a phone's keyboard all already know it: Tab reaches it,
// Escape clears it, and a Clear button does the same for a pointer. Filtering is `matchingRows` (queue-view.ts).

import type { ReactNode } from 'react';

export interface QueueSearchProps {
  readonly query: string;
  readonly onChange: (query: string) => void;
}

export function QueueSearch({ query, onChange }: QueueSearchProps) {
  return (
    <div className="fy-queue-search">
      <input
        aria-label="Search messages"
        autoComplete="off"
        className="kt-input fy-queue-search-input"
        data-queue-search=""
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape' && query !== '') {
            event.preventDefault();
            onChange('');
          }
        }}
        placeholder="Search messages and senders"
        spellCheck={false}
        type="search"
        value={query}
      />
      {query === '' ? null : (
        <button className="kt-btn kt-btn--sm" onClick={() => onChange('')} type="button">
          Clear search
        </button>
      )}
    </div>
  );
}

/**
 * The live region the search's "nothing matched" answer is spoken from. It is mounted, empty, with the search box,
 * so the first answer is a change inside a region the screen reader already watches (W3C ARIA22).
 */
export function QueueSearchStatus({ children }: { readonly children: ReactNode }) {
  return (
    <div data-queue-search-status="" role="status">
      {children}
    </div>
  );
}

/** What the page says when the search hides every message: what was asked, and that older ones are not read. */
export function QueueNoMatch({
  query,
  olderUnread,
  onClear,
}: {
  readonly query: string;
  readonly olderUnread: boolean;
  readonly onClear: () => void;
}) {
  return (
    <div className="fy-queue-empty kt-panel" data-queue-no-match="">
      <p className="fy-queue-empty-title">{`No message matched “${query.trim()}”`}</p>
      <p className="fy-queue-empty-hint">
        {olderUnread
          ? 'Search looks at the messages on this page and the older messages already loaded; use Show older messages to load more.'
          : 'Search looks at what a message says and who sent it, on waiting and finished messages alike.'}
      </p>
      <button className="kt-btn" onClick={onClear} type="button">
        Clear search
      </button>
    </div>
  );
}
