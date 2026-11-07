/**
 * THE ITEM'S LIVE DOCUMENT AS TABS (&F923; docs/agenda.md § The tabs) — part 7 of the item view. The protocol owns the
 * order (`agendaTabs`): "Where we are now", the main tab, always first and open by default; "The full picture" (or a
 * review's "Reasoning"); then the ferret's own tabs (Overview, Decisions, Risks…).
 *
 *   one tab     no tab row: the part is drawn under that tab's name, exactly as one part was before
 *   phone       the same ARIA tablist on ONE line, scrolling sideways; an end that hides more tabs fades, the next
 *               name cut, so the reader sees there are tabs (&F946: never a dropdown that hides them)
 *   wider       a real ARIA tablist that WRAPS onto a second line rather than scroll or cut a name; arrows, Home, End
 *
 * A tab the last edit changed carries a dot and the word "Changed" (never colour alone). Each tab ends with "Next: … ›",
 * so a reader at the bottom of a long tab never scrolls back up to switch. Only the open tab is in the page.
 *
 * The main tab holds, in this order: the ferret's answer to the owner's question, what is decided so far, what is
 * still open, then the main tab's own Markdown (`whereWeAre`) — as long and as rich as the ferret needs.
 */

import { AGENDA_REVIEW_BODY_TAB_NAME, type AgendaViewTab } from '../../wire/index.ts';
import { ChevronRight } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, type Ref, useId, useLayoutEffect, useRef, useState } from 'react';
import { useLayoutMode } from '../../shell.ts';
import { PART_TITLES } from '../../lib/agenda-item-sections.ts';
import { nextTab } from '../../lib/agenda-tab-view.ts';
import { nextDetailsTab } from '../../shell.ts';
import { PointForm } from './agenda-brief.tsx';
import { AgendaBody } from './agenda-steps.tsx';

type Prose = (text: string) => ReactNode;

/** One titled section inside a part: drawn open, under its own name. */
export function Section({
  name,
  title,
  children,
}: {
  readonly name: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="fy-card__section" data-agenda-section={name}>
      <h4 className="fy-card__label fy-card__section-title">{title}</h4>
      <div className="fy-card__section-body">{children}</div>
    </section>
  );
}

/** The words one tab holds. */
function TabBody({
  tab,
  renderProse,
  mark,
}: {
  readonly tab: AgendaViewTab;
  readonly renderProse: Prose;
  readonly mark: (text: string) => string;
}) {
  if (tab.kind === 'main')
    return (
      <>
        {tab.questionAnswer === undefined ? null : (
          <div className="fy-card__answered" data-agenda-question-answer="">
            <h5 className="fy-card__label">Answer to your question</h5>
            <PointForm renderProse={renderProse} text={mark(tab.questionAnswer)} />
          </div>
        )}
        {tab.decided === undefined ? null : (
          <Section name="decided" title="Decided so far">
            <PointForm renderProse={renderProse} text={tab.decided} />
          </Section>
        )}
        {tab.stillOpen === undefined ? null : (
          <Section name="still-open" title="Still open">
            <PointForm renderProse={renderProse} text={tab.stillOpen} />
          </Section>
        )}
        {tab.whereWeAre === undefined ? null : (
          <div className="fy-card__where" data-agenda-where-now="">
            <AgendaBody renderProse={renderProse} text={tab.whereWeAre} />
          </div>
        )}
      </>
    );
  return (
    <div
      data-agenda-section={
        tab.kind === 'own' ? undefined : tab.name === AGENDA_REVIEW_BODY_TAB_NAME ? 'reasoning' : 'more'
      }
      data-agenda-tab-body={tab.id}
    >
      <AgendaBody renderProse={renderProse} text={tab.body} />
    </div>
  );
}

/** "Changed": a dot, and the word for a screen reader. */
function ChangedMark() {
  return (
    <span className="fy-tabs__changed" data-agenda-tab-changed="">
      <span aria-hidden="true" className="fy-tabs__dot" />
      <span className="sr-only">Changed</span>
    </span>
  );
}

export interface AgendaTabsProps {
  readonly tabs: readonly AgendaViewTab[];
  /** The open tab's id. */
  readonly open: string;
  readonly onOpen: (id: string) => void;
  /** The ids of the tabs the last edit changed. */
  readonly changed: ReadonlySet<string>;
  readonly renderProse: Prose;
  readonly mark: (text: string) => string;
  /** The part itself, so "Answered: see Where we are now" can bring it into view. */
  readonly partRef?: Ref<HTMLElement>;
}

/** The room kept beside the open tab when the row scrolls to it, so the next name still peeks in. */
const PEEK = 24;

/** Which ends of a sideways-scrolling row hide more tabs. */
interface Edges {
  readonly start: boolean;
  readonly end: boolean;
}
const NO_EDGES: Edges = { start: false, end: false };

/**
 * THE TAB ROW: one real ARIA tablist (arrows, Home, End). Wider than a phone it wraps onto a second line; on a phone it
 * stays ONE line and scrolls sideways, an end that hides more tabs fading out with the next name cut, so a reader always
 * sees there are tabs — never a dropdown that hides them (&F946). The open tab is kept in view.
 */
function TabRow({
  tabs,
  current,
  changed,
  onOpen,
  tabId,
  panelId,
}: {
  readonly tabs: readonly AgendaViewTab[];
  readonly current: AgendaViewTab;
  readonly changed: ReadonlySet<string>;
  readonly onOpen: (id: string) => void;
  readonly tabId: (id: string) => string;
  readonly panelId: string;
}) {
  const phone = useLayoutMode() === 'drawer';
  const list = useRef<HTMLDivElement | null>(null);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const [edges, setEdges] = useState<Edges>(NO_EDGES);
  // What the row draws: a rename or a new Changed dot changes its width with the same number of tabs.
  const drawn = tabs.map(tab => `${tab.id}\u0000${tab.name}\u0000${changed.has(tab.id) ? '1' : ''}`).join('\u0001');
  // biome-ignore lint/correctness/useExhaustiveDependencies: what the row draws is the trigger
  useLayoutEffect(() => {
    const row = list.current;
    // A wrapping row hides nothing: no fade survives a phone turning into a wider screen.
    if (!phone || row === null) {
      setEdges(was => (was.start || was.end ? NO_EDGES : was));
      return undefined;
    }
    const measure = (): void => {
      const hidden = row.scrollWidth - row.clientWidth;
      const next = { start: row.scrollLeft > 1, end: hidden - row.scrollLeft > 1 };
      setEdges(was => (was.start === next.start && was.end === next.end ? was : next));
    };
    // The open tab is scrolled into the row — sideways only, so opening an item never moves the page.
    const reveal = (): void => {
      const tab = refs.current.get(current.id);
      if (tab === undefined) return;
      if (tab.offsetLeft < row.scrollLeft) row.scrollLeft = Math.max(0, tab.offsetLeft - PEEK);
      else if (tab.offsetLeft + tab.offsetWidth > row.scrollLeft + row.clientWidth)
        row.scrollLeft = tab.offsetLeft + tab.offsetWidth - row.clientWidth + PEEK;
    };
    const settle = (): void => {
      reveal();
      measure();
    };
    settle();
    row.addEventListener('scroll', measure, { passive: true });
    // The row resizing (a turned phone, a wider sheet) or a tab resizing (a font loading) keeps the open tab in view.
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(settle);
    watch?.observe(row);
    for (const tab of refs.current.values()) watch?.observe(tab);
    return () => {
      row.removeEventListener('scroll', measure);
      watch?.disconnect();
    };
  }, [phone, drawn, current.id]);
  const order = tabs.map(tab => tab.id);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const to = nextDetailsTab(event.key, current.id, order);
    if (to === null) return;
    event.preventDefault();
    onOpen(to);
    refs.current.get(to)?.focus();
  };
  return (
    <div
      className="fy-tabs__row"
      data-agenda-tab-row={phone ? 'scroll' : 'wrap'}
      data-more-end={(phone && edges.end) || undefined}
      data-more-start={(phone && edges.start) || undefined}
    >
      <div aria-label="Tabs" className="fy-tabs__list" onKeyDown={onKeyDown} ref={list} role="tablist">
        {tabs.map(tab => {
          const selected = tab.id === current.id;
          return (
            <button
              aria-controls={selected ? panelId : undefined}
              aria-selected={selected}
              className="fy-tabs__tab"
              data-agenda-tab-button={tab.id}
              id={tabId(tab.id)}
              key={tab.id}
              onClick={() => onOpen(tab.id)}
              ref={element => {
                if (element) refs.current.set(tab.id, element);
                else refs.current.delete(tab.id);
              }}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              {tab.name}
              {changed.has(tab.id) ? <ChangedMark /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function AgendaTabs({ tabs, open, onOpen, changed, renderProse, mark, partRef }: AgendaTabsProps) {
  const base = useId();
  const part = useRef<HTMLElement | null>(null);
  const current = tabs.find(tab => tab.id === open) ?? tabs[0];
  if (current === undefined) return null;
  const setPart = (element: HTMLElement | null): void => {
    part.current = element;
    if (typeof partRef === 'function') partRef(element);
    else if (partRef != null) (partRef as { current: HTMLElement | null }).current = element;
  };
  const tabId = (id: string): string => `${base}-tab-${id}`;
  const panelId = `${base}-panel`;
  const panel = <TabBody mark={mark} renderProse={renderProse} tab={current} />;

  // One tab draws no tab row: the part reads exactly as one part did.
  if (tabs.length === 1)
    return (
      <section
        aria-label={current.name}
        className="fy-card__part"
        data-agenda-part="tabs"
        data-agenda-tab={current.id}
        ref={setPart}
      >
        <h4 className="fy-card__label fy-card__part-title">{current.name}</h4>
        {panel}
      </section>
    );

  const next = nextTab(tabs, current.id);
  const goNext = (): void => {
    if (next === undefined) return;
    onOpen(next.id);
    if (typeof part.current?.scrollIntoView === 'function') part.current.scrollIntoView({ block: 'start' });
  };
  return (
    <section
      aria-label={PART_TITLES.tabs}
      className="fy-card__part fy-tabs"
      data-agenda-part="tabs"
      data-agenda-tab={current.id}
      ref={setPart}
    >
      <TabRow changed={changed} current={current} onOpen={onOpen} panelId={panelId} tabId={tabId} tabs={tabs} />
      <div
        aria-labelledby={tabId(current.id)}
        className="fy-tabs__panel"
        data-agenda-tab-panel={current.id}
        id={panelId}
        role="tabpanel"
      >
        {panel}
      </div>
      {next === undefined ? null : (
        <button className="fy-tabs__next" data-agenda-tab-next={next.id} onClick={goNext} type="button">
          Next: {next.name}
          <ChevronRight aria-hidden="true" size={14} />
        </button>
      )}
    </section>
  );
}
