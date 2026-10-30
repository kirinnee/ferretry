import { afterEach, describe, expect, it } from 'bun:test';
import type { BoardTaskView, ResolvedAgendaItem } from '@ferretry/protocol';
import {
  AskSection,
  AsksList,
  ChildrenList,
  DependencyChips,
  DetailSection,
  HistorySection,
  LaneStepper,
  LinksSection,
  Prose,
  TermsTable,
} from '../../../src/features/board/detail/board-detail-sections.tsx';
import { laneNameOf, laneStepper } from '../../../src/lib/board-detail.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
const text = (root: Element, selector: string): string | undefined =>
  root.querySelector(selector)?.textContent ?? undefined;
import { agendaItem } from '../../support/agenda-inbox.tsx';
import { card, laneSetFor, laptop, workstation } from '../board-support.ts';
import { HELPER, LEAD, names, NOW } from './board-detail-support.tsx';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const show = async (element: Parameters<typeof mount>[0]): Promise<HTMLElement> => {
  view = await mount(element);
  return view.container;
};

const SHA = 'a'.repeat(40);
const pr = (number: number, extra: Record<string, unknown> = {}) => ({
  url: `https://github.com/acme/app/pull/${number}`,
  number,
  repo: 'acme/app',
  state: 'open',
  draft: false,
  checks: 'none',
  mergedAt: null,
  mergeSha: null,
  releasedIn: null,
  polledAt: '2026-08-01T09:30:00.000Z',
  ...extra,
});
const merged = (number: number, releasedIn: unknown = null) =>
  pr(number, { state: 'merged', mergedAt: '2026-08-01T09:40:00.000Z', mergeSha: SHA, releasedIn });
const RELEASE = { version: '4.111.0', tag: 'v4.111.0', at: '2026-08-01T09:50:00.000Z' };
const links = (extra: Record<string, unknown>) => ({ prs: [], branch: null, commits: [], docs: [], ...extra });

describe('DetailSection', () => {
  it('draws a titled disclosure, open by default, with a count only when given one', async () => {
    const root = await show(
      <>
        <DetailSection id="a" title="Open one">
          body a
        </DetailSection>
        <DetailSection count={3} defaultOpen={false} id="b" title="Shut one">
          body b
        </DetailSection>
      </>,
    );
    const a = must(root.querySelector('[data-section="a"]'), 'section a');
    const b = must(root.querySelector('[data-section="b"]'), 'section b');
    expect(a.hasAttribute('open')).toBe(true);
    expect(b.hasAttribute('open')).toBe(false);
    expect(a.querySelector('summary')?.textContent).toBe('Open one');
    expect(a.querySelector('.fy-board-detail__count')).toBeNull();
    expect(b.querySelector('.fy-board-detail__count')?.textContent).toBe('3');
    expect(b.querySelector('.fy-board-detail__body')?.textContent).toBe('body b');
  });
});

describe('LaneStepper', () => {
  it('marks done, current and next lanes, with Closed last', async () => {
    const laneSet = laneSetFor();
    const root = await show(<LaneStepper steps={laneStepper(laneSet, 'review')} />);
    const states = [...root.querySelectorAll('li')].map(
      item => `${item.textContent}:${item.getAttribute('data-state')}`,
    );
    expect(states).toEqual([
      'Todo:done',
      'Plan/Design:done',
      'Implement:done',
      'Review/CI:current',
      'Merged:next',
      'Released:next',
      'Manually tested:next',
      'Closed:next',
    ]);
    expect(root.querySelector('[aria-current="step"]')?.textContent).toBe('Review/CI');
    expect(laneNameOf(laneSet, 'review')).toBe('Review/CI');
  });

  it('says the project has no lanes when there are none', async () => {
    const root = await show(<LaneStepper steps={[]} />);
    expect(root.textContent).toBe('This project has no confirmed lanes.');
  });
});

describe('Prose', () => {
  it('says the empty words for blank text and renders markdown otherwise', async () => {
    const root = await show(
      <>
        <Prose empty="Nothing here." text="   " />
        <Prose empty="unused" text="**bold** words" />
      </>,
    );
    expect(root.querySelector('.fy-board-detail__quiet')?.textContent).toBe('Nothing here.');
    expect(root.textContent).toContain('bold words');
    expect(root.querySelector('strong')?.textContent).toBe('bold');
  });
});

describe('AskSection', () => {
  it('quotes the ask and where it was said, without a clarification list when there are none', async () => {
    const task = card('F1', { ask: { text: 'Ship the board', source: 'chat' } });
    const root = await show(<AskSection names={names} now={NOW} onOpenSession={() => undefined} task={task} />);
    expect(root.querySelector('blockquote')?.textContent).toBe('Ship the board');
    expect(text(root, '[data-kind="ask-origin"]')).toMatch(/^From Denisha, via chat · \d+/u);
    expect(root.querySelector('ul')).toBeNull();
  });

  it('says who and where, and links the chat when the source is a session', async () => {
    const opened: string[] = [];
    const task = card('F1', {
      createdBy: { kind: 'owner' },
      ask: { text: 'Ship the board', source: 'session:mvuc7tsf-0c3d50df' },
    });
    const root = await show(
      <AskSection names={() => 'denisha'} now={NOW} onOpenSession={id => void opened.push(id)} task={task} />,
    );
    expect(text(root, '[data-kind="ask-origin"]')).toMatch(/^The owner, in denisha's chat · \d+/u);
    await interact(() =>
      (must(root.querySelector('[data-kind="ask-origin"] button'), 'the chat link') as HTMLElement).click(),
    );
    expect(opened).toEqual(['mvuc7tsf-0c3d50df']);
  });

  it('leaves the source off when it is the owner speaking and the card has no age', async () => {
    const task = {
      ...card('F1', { createdBy: { kind: 'owner' }, ask: { text: 'Ship the board', source: 'owner (board)' } }),
      createdAt: 'never' as BoardTaskView['createdAt'],
    };
    const root = await show(<AskSection names={names} now={NOW} onOpenSession={() => undefined} task={task} />);
    expect(text(root, '[data-kind="ask-origin"]')).toBe('The owner');
  });

  it('credits each clarification to you or to the ferret by name', async () => {
    const task = card('F1', {
      clarifications: [
        { text: 'Only on phones', source: 'chat', at: '2026-08-01T09:10:00.000Z', by: { kind: 'owner' } },
        {
          text: 'Behind a flag',
          source: 'chat',
          at: '2026-08-01T09:20:00.000Z',
          by: { kind: 'ferret', sessionId: LEAD },
        },
      ],
    });
    const root = await show(<AskSection names={names} now={NOW} onOpenSession={() => undefined} task={task} />);
    const lines = [...root.querySelectorAll('li')].map(item => item.textContent);
    expect(lines).toEqual(['Clarified by you: Only on phones', 'Clarified by a ferret (Denisha): Behind a flag']);
  });
});

describe('TermsTable', () => {
  it('lists each term with its meaning', async () => {
    const task = card('F1', { terms: [{ term: 'Lane', meaning: 'A column of the board.' }] });
    const root = await show(<TermsTable terms={task.terms} />);
    expect(root.querySelector('tbody th')?.textContent).toBe('Lane');
    expect(root.querySelector('tbody td')?.textContent).toBe('A column of the board.');
  });

  it('says so when no term is spelled out', async () => {
    const root = await show(<TermsTable terms={[]} />);
    expect(root.textContent).toBe('No terms spelled out yet.');
  });
});

describe('ChildrenList', () => {
  const child = card('F2', {
    title: 'Sub work',
    parent: { id: 'F1' },
    activity: 'stale',
    lastTouchedAt: '2026-08-01T09:00:00.000Z',
  });

  it('says there are no sub-cards', async () => {
    const root = await show(<ChildrenList lines={[]} now={NOW} onOpen={() => undefined} />);
    expect(root.textContent).toBe('No sub-cards.');
  });

  it('draws each child with its lane, activity and age, and opens it by id', async () => {
    const opened: string[] = [];
    const root = await show(
      <ChildrenList lines={[{ task: child, laneName: 'Implement' }]} now={NOW} onOpen={id => void opened.push(id)} />,
    );
    const item = must(root.querySelector('li'), 'the child');
    expect(item.querySelector('button')?.textContent).toBe('&F2 Sub work');
    expect(item.textContent).toContain('Implement · stale');
    expect(item.textContent).toMatch(/· \d+/u);
    await interact(() => must(item.querySelector('button'), 'open').click());
    expect(opened).toEqual(['F2']);
  });

  it('leaves the age off a child that was never touched', async () => {
    const fresh = { ...child, lastTouchedAt: '' as BoardTaskView['lastTouchedAt'] };
    const root = await show(
      <ChildrenList lines={[{ task: fresh, laneName: 'Todo' }]} now={NOW} onOpen={() => undefined} />,
    );
    expect(root.querySelector('li span')?.textContent?.trim()).toBe('· Todo · stale');
  });
});

describe('DependencyChips', () => {
  it('says nothing waits when there are no dependencies either way', async () => {
    const root = await show(<DependencyChips onOpen={() => undefined} onUndepend={null} task={card('F1')} />);
    expect(root.textContent).toBe('Nothing waits on this, and it waits on nothing.');
  });

  it('draws what it waits for, marks the ones still blocking, and offers to stop waiting', async () => {
    const opened: string[] = [];
    const undepended: string[] = [];
    const task = card('F1', {
      dependsOn: [
        { task: { id: 'F2' }, until: 'shipped' },
        {
          task: { id: 'F3' },
          until: 'released',
          override: { by: 'owner', reason: 'it is fine', at: '2026-08-01T09:00:00.000Z' },
        },
      ],
      blockedBy: [{ id: 'F2' }],
      blocks: [{ id: 'F9' }],
    });
    const root = await show(
      <DependencyChips
        onOpen={id => void opened.push(id)}
        onUndepend={ref => void undepended.push(ref.id)}
        task={task}
      />,
    );
    const dependsOn = must(root.querySelector('[aria-label="Depends on"]'), 'depends on');
    const chips = [...dependsOn.querySelectorAll('.fy-board-chip')];
    expect(chips.map(chip => chip.querySelector('.fy-board-chip__open')?.textContent)).toEqual([
      '&F2 · until shipped',
      '&F3 · until released · overridden',
    ]);
    expect(chips[0]?.hasAttribute('data-waiting')).toBe(true);
    expect(chips[1]?.hasAttribute('data-waiting')).toBe(false);
    await interact(() => must(chips[0]?.querySelector<HTMLElement>('.fy-board-chip__open'), 'chip').click());
    await interact(() => must(root.querySelector<HTMLElement>('[aria-label="Stop waiting for &F3"]'), 'x').click());
    const blocks = must(root.querySelector('[aria-label="Blocks"]'), 'blocks');
    await interact(() => must(blocks.querySelector<HTMLElement>('.fy-board-chip__open'), 'blocked chip').click());
    expect(opened).toEqual(['F2', 'F9']);
    expect(undepended).toEqual(['F3']);
  });

  it('draws no stop button when stopping is not offered, and no Depends-on row when it only blocks', async () => {
    const task = card('F1', { blocks: [{ id: 'F9' }] });
    const root = await show(<DependencyChips onOpen={() => undefined} onUndepend={null} task={task} />);
    expect(root.querySelector('[aria-label="Depends on"]')).toBeNull();
    expect(root.querySelector('[aria-label="Blocks"]')).not.toBeNull();
    const waiting = card('F1', { dependsOn: [{ task: { id: 'F2' }, until: 'shipped' }] });
    await view?.render(<DependencyChips onOpen={() => undefined} onUndepend={null} task={waiting} />);
    expect(root.querySelector('.fy-board-chip__x')).toBeNull();
    expect(root.querySelector('[aria-label="Blocks"]')).toBeNull();
  });
});

describe('LinksSection', () => {
  it('says nothing is linked when there is nothing', async () => {
    const root = await show(<LinksSection runningOn={[]} task={card('F1')} />);
    expect(root.textContent).toBe('No PR, branch or doc linked yet.');
  });

  it('describes each PR state, with its checks and release', async () => {
    const task = card('F1', {
      links: links({
        prs: [
          pr(1, { draft: true }),
          pr(2, { checks: 'failing' }),
          pr(3, { checks: 'pending' }),
          pr(4, { checks: 'passing' }),
          pr(5, { state: 'closed' }),
          merged(6, RELEASE),
          pr(7, { state: 'unknown', polledAt: null }),
        ],
      }),
    });
    const root = await show(<LinksSection runningOn={[]} task={task} />);
    const rows = [...root.querySelectorAll('li')].map(item => item.textContent?.replace(/\s+/gu, ' ').trim());
    expect(rows).toEqual([
      'acme/app#1 · Draft',
      'acme/app#2 · Open · CI red',
      'acme/app#3 · Open · CI running',
      'acme/app#4 · Open · CI green',
      'acme/app#5 · Closed',
      'acme/app#6 · Merged · in 4.111.0',
      'acme/app#7 · Not polled yet',
    ]);
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://github.com/acme/app/pull/1');
    expect(root.querySelector('a')?.getAttribute('rel')).toBe('noreferrer');
    expect(root.querySelector('li')?.getAttribute('data-tone')).toBe('quiet');
  });

  it('says where a shipped card is running, per machine', async () => {
    const task = card('F1', {
      links: links({ prs: [merged(6, RELEASE)] }),
      shippedIn: RELEASE,
    });
    const runningOn = [
      { daemonId: laptop.daemonId, machine: 'laptop', version: '4.111.0', has: true },
      { daemonId: workstation.daemonId, machine: 'workstation', version: '4.110.0', has: false },
      { daemonId: 'daemon/phone' as typeof laptop.daemonId, machine: 'phone', version: null, has: false },
    ];
    const root = await show(<LinksSection runningOn={runningOn} task={task} />);
    expect(root.querySelector('[data-kind="shipped"] strong')?.textContent).toBe('4.111.0');
    const lines = [...root.querySelectorAll('[aria-label="Running on"] li')].map(
      item => `${item.textContent}|${item.getAttribute('data-has')}`,
    );
    expect(lines).toEqual([
      'laptop: running 4.111.0|yes',
      'workstation: still on 4.110.0|no',
      'phone: version unknown|no',
    ]);
  });

  it('shows a shipped card with no machines listed, and anchors only web links', async () => {
    const task = card('F1', {
      shippedIn: RELEASE,
      links: links({ branch: 'feat/board', docs: ['https://example.test/docs/design', 'docs/design.md'] }),
    });
    const root = await show(<LinksSection runningOn={[]} task={task} />);
    expect(root.querySelector('[aria-label="Running on"]')).toBeNull();
    expect(root.querySelector('[data-kind="shipped"]')?.textContent).toBe('Shipped in 4.111.0');
    const anchors = [...root.querySelectorAll('a')];
    expect(anchors.map(anchor => anchor.getAttribute('href'))).toEqual(['https://example.test/docs/design']);
    expect(anchors[0]?.textContent).toBe('design');
    expect([...root.querySelectorAll('code')].map(code => code.textContent)).toEqual(['feat/board', 'docs/design.md']);
  });
});

describe('AsksList', () => {
  const resolved = (id: string, extra: Record<string, unknown>) =>
    ({
      ...agendaItem(id),
      resolvedAt: '2026-08-01T10:00:00.000Z',
      resolvedBy: 'human',
      resolvedBySession: null,
      resolvedByName: null,
      ...extra,
    }) as unknown as ResolvedAgendaItem;

  it('says it is reading while the agendas load, and that there are none after', async () => {
    const root = await show(<AsksList asks={{ open: [], resolved: [], reading: true }} names={names} />);
    expect(root.textContent).toBe('Reading the asks…');
    await view?.render(<AsksList asks={{ open: [], resolved: [], reading: false }} names={names} />);
    expect(root.textContent).toBe('No asks have been raised.');
  });

  it('lists open asks by title or by id and ferret, and resolved ones with their note', async () => {
    const asks = {
      open: [
        { ref: { sessionId: LEAD, id: 'A1' }, item: agendaItem('A1', { title: 'Approve it?' }), blocking: true },
        { ref: { sessionId: HELPER, id: 'A2' }, item: null, blocking: false },
      ],
      resolved: [
        resolved('A3', { title: 'Which colour?', disposition: 'answered', resolutionNote: 'blue it is' }),
        resolved('A4', { title: 'Old thing', disposition: 'dismissed', resolutionNote: null }),
      ],
      reading: false,
    };
    const root = await show(<AsksList asks={asks} names={names} />);
    const rows = [...root.querySelectorAll('li')].map(item => `${item.getAttribute('data-state')}|${item.textContent}`);
    expect(rows).toEqual([
      'open|Blocking · Approve it?',
      'open|Open · A2 from mvudnu',
      'resolved|Answered · Which colour? · blue it is',
      'resolved|Dismissed · Old thing',
    ]);
  });
});

describe('HistorySection', () => {
  const at = (minute: number) => `2026-08-01T09:${String(minute).padStart(2, '0')}:00.000Z`;
  const context = { names, laneName: (id: string) => laneNameOf(laneSetFor(), id) };

  it('draws the newest event first with who did it and why', async () => {
    const task = card('F1', {
      history: [
        { seq: 1, at: at(0), actor: { kind: 'ferret', sessionId: LEAD }, type: 'created', laneId: 'todo' },
        {
          seq: 2,
          at: at(30),
          actor: { kind: 'owner' },
          type: 'moved',
          from: 'implement',
          to: 'plan',
          backward: true,
          reason: 'wrong plan',
        },
      ],
    });
    const root = await show(<HistorySection context={context} now={NOW} task={task} />);
    const rows = [...must(root.querySelector('ol'), 'the history').children];
    expect(rows.map(row => row.getAttribute('data-type'))).toEqual(['moved', 'created']);
    expect(rows[0]?.querySelector('strong')?.textContent).toBe('You');
    expect(rows[0]?.textContent).toContain('moved back Implement → Plan/Design');
    expect(rows[0]?.querySelector('.fy-board-detail__detail')?.textContent).toBe('wrong plan');
    expect(rows[1]?.textContent).toContain('Denisha');
    expect(rows[1]?.querySelector('.fy-board-detail__detail')).toBeNull();
  });

  it('folds a run of small changes into one line that opens to the rows', async () => {
    const task = card('F1', {
      history: [
        { seq: 1, at: at(0), actor: { kind: 'ferret', sessionId: LEAD }, type: 'created', laneId: 'todo' },
        { seq: 2, at: at(1), actor: { kind: 'ferret', sessionId: LEAD }, type: 'file-claimed', path: 'a.ts' },
        { seq: 3, at: at(2), actor: { kind: 'ferret', sessionId: LEAD }, type: 'file-claimed', path: 'b.ts' },
        { seq: 4, at: at(3), actor: { kind: 'ferret', sessionId: LEAD }, type: 'file-claimed', path: 'c.ts' },
      ],
    });
    const root = await show(<HistorySection context={context} now={NOW} task={task} />);
    const fold = must(root.querySelector('[data-kind="fold"]'), 'the fold');
    expect(fold.querySelector('summary')?.textContent).toBe('3 small changes');
    expect([...fold.querySelectorAll('li')].map(row => row.textContent)).toEqual([
      expect.stringContaining('claimed c.ts'),
      expect.stringContaining('claimed b.ts'),
      expect.stringContaining('claimed a.ts'),
    ]);
  });
});
