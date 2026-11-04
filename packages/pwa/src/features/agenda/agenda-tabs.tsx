/**
 * THE ITEM'S LIVE DOCUMENT AS TABS (&F923; docs/agenda.md § The tabs) — part 7 of the item view. The protocol owns the
 * order (`agendaTabs`): "Where we are now", the main tab, always first and open by default; "The full picture" (or a
 * review's "Reasoning"); then the ferret's own tabs (Overview, Decisions, Risks…).
 *
 *   one tab     no tab row: the part is drawn under that tab's name, exactly as one part was before
 *   phone       ONE switcher button is the part's heading — "Where we are now ▾ · 1 of 3 · 2 changed" — and opens the
 *               app's bottom sheet with the tabs as a radio list (never a horizontal strip that cuts a name off)
 *   wider       a real ARIA tablist that WRAPS onto a second line rather than scroll or cut a name; arrows, Home, End
 *
 * A tab the last edit changed carries a dot and the word "Changed" (never colour alone). Each tab ends with "Next: … ›",
 * so a reader at the bottom of a long tab never scrolls back up to switch. Only the open tab is in the page.
 *
 * The main tab holds, in this order: the ferret's answer to the owner's question, what is decided so far, what is
 * still open, then the main tab's own Markdown (`whereWeAre`) — as long and as rich as the ferret needs.
 */

import { AGENDA_REVIEW_BODY_TAB_NAME, type AgendaViewTab } from '@ferretry/protocol';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, type Ref, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLayoutMode } from '../../hooks/use-layout-mode.ts';
import { PART_TITLES } from '../../lib/agenda-item-sections.ts';
import { nextTab, switcherWords } from '../../lib/agenda-tab-view.ts';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';
import { nextDetailsTab } from '../../shell/sheet-tabs.tsx';
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

export function AgendaTabs({ tabs, open, onOpen, changed, renderProse, mark, partRef }: AgendaTabsProps) {
  const phone = useLayoutMode() === 'drawer';
  const base = useId();
  const part = useRef<HTMLElement | null>(null);
  const [sheet, setSheet] = useState(false);
  const refs = useRef(new Map<string, HTMLButtonElement>());
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
  const nextLink =
    next === undefined ? null : (
      <button className="fy-tabs__next" data-agenda-tab-next={next.id} onClick={goNext} type="button">
        Next: {next.name}
        <ChevronRight aria-hidden="true" size={14} />
      </button>
    );

  if (phone) {
    const host = typeof document === 'undefined' ? null : document.body;
    const words = switcherWords(tabs, current.id, changed);
    const titleId = `${base}-sheet-title`;
    return (
      <section
        aria-label={PART_TITLES.tabs}
        className="fy-card__part fy-tabs"
        data-agenda-part="tabs"
        data-agenda-tab={current.id}
        ref={setPart}
      >
        <h4 className="fy-card__label fy-card__part-title fy-tabs__heading">
          <button
            aria-expanded={sheet}
            aria-haspopup="dialog"
            className="fy-tabs__switch"
            data-agenda-tab-switch=""
            onClick={() => setSheet(true)}
            type="button"
          >
            <span className="fy-tabs__switch-name">{words.name}</span>
            <ChevronDown aria-hidden="true" size={16} />
            <span className="fy-tabs__switch-meta">· {words.meta}</span>
          </button>
        </h4>
        <div className="fy-tabs__panel" data-agenda-tab-panel={current.id}>
          {panel}
        </div>
        {nextLink}
        {host !== null &&
          createPortal(
            <BottomSheet
              closeLabel="Close the tabs"
              id={`${base}-sheet`}
              labelledBy={titleId}
              onClose={() => setSheet(false)}
              open={sheet}
              zIndexClass="z-50"
            >
              <div className="fy-tabs__sheet" data-agenda-tab-sheet="">
                <h2 className="fy-item-menu__title" id={titleId}>
                  Tabs
                </h2>
                <div aria-labelledby={titleId} className="fy-tabs__choices" role="radiogroup">
                  {tabs.map(tab => (
                    <label className="fy-tabs__choice" data-on={tab.id === current.id || undefined} key={tab.id}>
                      <input
                        checked={tab.id === current.id}
                        data-agenda-tab-choice={tab.id}
                        name={`${base}-choice`}
                        onChange={() => {
                          onOpen(tab.id);
                          setSheet(false);
                        }}
                        type="radio"
                        value={tab.id}
                      />
                      <span className="fy-tabs__choice-name">{tab.name}</span>
                      {changed.has(tab.id) ? <ChangedMark /> : null}
                    </label>
                  ))}
                </div>
              </div>
            </BottomSheet>,
            host,
          )}
      </section>
    );
  }

  const order = tabs.map(tab => tab.id);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const to = nextDetailsTab(event.key, current.id, order);
    if (to === null) return;
    event.preventDefault();
    onOpen(to);
    refs.current.get(to)?.focus();
  };
  return (
    <section
      aria-label={PART_TITLES.tabs}
      className="fy-card__part fy-tabs"
      data-agenda-part="tabs"
      data-agenda-tab={current.id}
      ref={setPart}
    >
      <div aria-label="Tabs" className="fy-tabs__list" onKeyDown={onKeyDown} role="tablist">
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
      <div
        aria-labelledby={tabId(current.id)}
        className="fy-tabs__panel"
        data-agenda-tab-panel={current.id}
        id={panelId}
        role="tabpanel"
      >
        {panel}
      </div>
      {nextLink}
    </section>
  );
}
