/**
 * THE SESSION'S BROWSER PAGES, GROUPED BY THE AGENT THEY BELONG TO — the list the browser bar's page menu opens.
 *
 * The machine runs one shared browser, and every page in it belongs to the session that opened it
 * (`docs/agent-tools.md`). The daemon stamps each page with its owner (`ownerSessionId`) and what a
 * person calls that agent (`ownerName`), popups included, so a reader groups by owner and says whose
 * browser it is: "Hadi’s browser". Each page is one chip: its name (`app` in `%browser:app`) or its
 * title, an INCOGNITO badge for a throwaway page with its own cookies, and AGENT while an agent is
 * driving it. A row opens that page's own workspace tab — Take over / Hand back are per tab — and its
 * ✕ closes the page; New page opens one for the person. It is the only page list there is: the real
 * engine draws no tab strip of its own, and the list costs the tab no row until the bar's name is tapped.
 *
 * Presentational: the status, the per-page control facts and the open intent come from the host.
 * An unread status says so rather than claiming the browser is empty.
 */

import type { BrowserPageSummary, BrowserStatus } from '@ferretry/protocol';
import { EyeOff, Globe2, Plus, X } from 'lucide-react';
import { remotePageLabel } from '../../lib/remote-browser.ts';
import type { AgentControlDriver } from '../workspace/agent-control-marker.tsx';

/** One owner's pages, in the daemon's own order. */
export interface BrowserPageGroup {
  readonly ownerKey: string;
  /** "Hadi’s browser" — or the session's, when the daemon names no owner. */
  readonly label: string;
  readonly pages: readonly BrowserPageSummary[];
}

/** Whose browser a group is, in the words a person uses. */
export const browserOwnerLabel = (name: string | undefined): string =>
  name === undefined || name === '' ? 'This session’s browser' : `${name}’s browser`;

/**
 * Groups pages by the session that owns them, first-seen order. A page with no owner stamped is the
 * session's own, under `sessionName` — the agent this page is about.
 */
export const groupBrowserPages = (
  pages: readonly BrowserPageSummary[],
  sessionName?: string,
): readonly BrowserPageGroup[] => {
  const groups = new Map<string, { label: string; pages: BrowserPageSummary[] }>();
  for (const page of pages) {
    const ownerKey = page.ownerSessionId ?? '';
    const group = groups.get(ownerKey);
    if (group === undefined)
      groups.set(ownerKey, { label: browserOwnerLabel(page.ownerName ?? sessionName), pages: [page] });
    else group.pages.push(page);
  }
  return [...groups].map(([ownerKey, group]) => ({ ownerKey, label: group.label, pages: group.pages }));
};

/** What a chip calls a page: the name a reference uses, else the page's own title or host. */
export const browserPageLabel = (page: BrowserPageSummary): string => page.name ?? remotePageLabel(page);

/** A chip's hover text: its name and title when it has a name, and always where it is. */
const pageDescription = (page: BrowserPageSummary): string =>
  page.name === undefined
    ? `${remotePageLabel(page)} — ${page.url}`
    : `${page.name}: ${remotePageLabel(page)} — ${page.url}`;

export interface BrowserSurfaceListProps {
  readonly status: BrowserStatus | null;
  /** The page this tab shows, by id; none for a tab that is not one page's. */
  readonly selectedPageId?: string;
  /** What a person calls this session's agent, for pages the daemon names no owner for. */
  readonly sessionName?: string;
  readonly driverFor: (page: BrowserPageSummary) => AgentControlDriver | null;
  readonly takenOver: (page: BrowserPageSummary) => boolean;
  readonly onOpenPage: (page: BrowserPageSummary) => void;
  /** Closes a page. Absent: chips offer no ✕. */
  readonly onClosePage?: (page: BrowserPageSummary) => void;
  /** Opens a new page for the person. Absent: no New page control. */
  readonly onNewPage?: () => void;
}

function PageChip({
  page,
  selected,
  driver,
  held,
  onOpen,
  onClose,
}: {
  readonly page: BrowserPageSummary;
  readonly selected: boolean;
  readonly driver: AgentControlDriver | null;
  readonly held: boolean;
  readonly onOpen: () => void;
  readonly onClose: (() => void) | undefined;
}) {
  const label = browserPageLabel(page);
  return (
    <li className="fy-ws-pages-item" data-current={selected ? 'true' : undefined}>
      <button
        type="button"
        className="fy-ws-page"
        aria-current={selected ? 'page' : undefined}
        data-browser-page={page.id}
        title={pageDescription(page)}
        onClick={onOpen}
      >
        <Globe2 aria-hidden="true" className="fy-ws-page-icon" size={14} />
        <span className="fy-ws-page-name">{label}</span>
        {page.incognito === true && (
          <span
            className="fy-ws-page-badge"
            data-tone="incognito"
            title="Incognito: its own cookies, shared with nothing"
          >
            <EyeOff aria-hidden="true" size={11} />
            Incognito
          </span>
        )}
        {driver !== null && (
          <span className="fy-ws-agent-badge" title={`${driver.name} is typing here`}>
            AGENT
          </span>
        )}
        {held && (
          <span className="fy-ws-page-badge" data-tone="held" title="You have taken this page over">
            You
          </span>
        )}
      </button>
      {onClose !== undefined && (
        <button
          aria-label={`Close ${label}`}
          className="fy-ws-page-close"
          onClick={onClose}
          title={`Close ${label}`}
          type="button"
        >
          <X aria-hidden="true" size={12} />
        </button>
      )}
    </li>
  );
}

export function BrowserSurfaceList({
  status,
  selectedPageId,
  sessionName,
  driverFor,
  takenOver,
  onOpenPage,
  onClosePage,
  onNewPage,
}: BrowserSurfaceListProps) {
  const groups = status === null ? [] : groupBrowserPages(status.pages, sessionName);
  const newPage =
    onNewPage === undefined ? null : (
      <button
        className="fy-ws-pages-new"
        onClick={onNewPage}
        title="Open a new page in this session’s browser"
        type="button"
      >
        <Plus aria-hidden="true" size={14} />
        New page
      </button>
    );
  return (
    <nav aria-label="Browser pages" className="fy-ws-pages" data-browser-pages="">
      {status === null || groups.length === 0 ? (
        <div className="fy-ws-pages-head">
          <p className="fy-ws-pages-note">
            {status === null
              ? 'No page list from this machine yet.'
              : `${browserOwnerLabel(sessionName)} has no pages open${status.state === 'running' ? '' : ' — it is not running'}.`}
          </p>
          {newPage}
        </div>
      ) : (
        groups.map((group, index) => (
          <section aria-label={group.label} className="fy-ws-pages-group" key={group.ownerKey}>
            <div className="fy-ws-pages-head">
              <h3 className="fy-ws-pages-owner">{group.label}</h3>
              {index === 0 ? newPage : null}
            </div>
            <ul className="fy-ws-pages-list">
              {group.pages.map(page => (
                <PageChip
                  driver={driverFor(page)}
                  held={takenOver(page)}
                  key={page.id}
                  onClose={onClosePage === undefined ? undefined : () => onClosePage(page)}
                  onOpen={() => onOpenPage(page)}
                  page={page}
                  selected={page.id === selectedPageId}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </nav>
  );
}
