/**
 * A MARKDOWN TABLE, with a phone's choice of how to read it.
 *
 * On a phone (below 768px, the `.md table` block in styles/index.css) a table's rows stack into
 * labelled cards by default: a 4-5 column table cannot show its header and cells side by side at 390px.
 * The owner likes the cards and also wants the real table one tap away, so each table carries a small
 * Cards / Table switch in its top-right corner:
 *   - CARDS — one outer border, a hairline between records, each value printing its column's name;
 *   - TABLE — the real table in its own horizontally scrolling box (the page never scrolls sideways),
 *     its header row and first column sticky, plus "⤢ Full screen", which opens it in a sheet you can
 *     pan in both directions.
 * The choice is the device's (`TableViewPreferenceStore`), so every table follows it. A desktop has
 * room for the table and never shows the switch: the toolbar is `display: none` from 768px up and the
 * `data-md-table-view` attribute only selects a phone rule.
 */

import { Maximize2 } from 'lucide-react';
import { type ComponentProps, useId, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { TableViewPreferenceStore } from '../lib/table-view-preference.ts';
import { BottomSheet } from '../shell/bottom-sheet.tsx';

const defaultStore = new TableViewPreferenceStore();

export interface MarkdownTableProps extends ComponentProps<'table'> {
  /** Injected so a test owns its storage; the app shares one device-wide store. */
  readonly store?: TableViewPreferenceStore;
}

export function MarkdownTable({ store = defaultStore, ...table }: MarkdownTableProps) {
  const view = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const [full, setFull] = useState(false);
  const sheetId = useId();
  return (
    <div className="md-table" data-md-table-view={view}>
      <fieldset aria-label="Table view" className="md-table-tools">
        <button aria-pressed={view === 'cards'} onClick={() => store.set('cards')} type="button">
          Cards
        </button>
        <button aria-pressed={view === 'table'} onClick={() => store.set('table')} type="button">
          Table
        </button>
        {view === 'table' ? (
          <button
            aria-controls={full ? sheetId : undefined}
            aria-expanded={full}
            data-md-table-full=""
            onClick={() => setFull(true)}
            title="Open the table full screen"
            type="button"
          >
            <Maximize2 aria-hidden="true" size={12} />
            Full screen
          </button>
        ) : null}
      </fieldset>
      <div className="md-table-scroll scroll-thin">
        <table {...table} />
      </div>
      {/* At the document root: a fixed sheet inside the transcript's scroller would be placed against
          whatever transformed box it sits in, not the screen. */}
      {view === 'table'
        ? createPortal(
            <BottomSheet
              ariaLabel="Table, full screen"
              closeLabel="Close the full-screen table"
              height="92dvh"
              maxHeight="92dvh"
              id={sheetId}
              onClose={() => setFull(false)}
              open={full}
              panelClassName="bg-surface"
              zIndexClass="z-50"
            >
              {/* Its own two-way scroller: pan across and down without moving the page behind. */}
              <div
                className="md md-table-pan min-h-0 flex-1 overflow-auto px-panel pb-panel"
                data-md-table-view="table"
              >
                <table {...table} />
              </div>
            </BottomSheet>,
            document.body,
          )
        : null}
    </div>
  );
}
