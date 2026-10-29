/**
 * WHAT A READER IS DOING IN A MESSAGE SURVIVES THE NEXT MESSAGE ARRIVING.
 *
 * The owner, verbatim: "when click on interactive elements, when new messages come in and stuff it
 * closes or re-renders, which makes it un-usable". A tab picked inside an interactive `html` block,
 * a row expanded, a step counter advanced — all of it lives in an iframe or in React state, and all
 * of it was thrown away whenever the chat re-rendered, because something above it REMOUNTED:
 *
 *   - every row's id was its position in the daemon's sliding 200-event window, so each new event
 *     renamed every row and React rebuilt the whole transcript;
 *   - a tool group's id hashed all its calls, so a run that grew closed the group the reader opened;
 *   - Markdown handed react-markdown fresh component functions on every render, so any re-render of
 *     a message (a rebuilt reference surface, a resolved file path) remounted its blocks and tables.
 *
 * These run in a real DOM (happy-dom), and prove identity — the SAME iframe element, not one that
 * looks the same — because a re-created frame is precisely the reset the reader sees.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Markdown } from '../../src/components/markdown.tsx';
import { PackSessionsProvider } from '../../src/components/pack-call.tsx';
import { transcriptEntriesFromLog } from '../../src/components/session-workspace-model.ts';
import { Transcript } from '../../src/components/transcript.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import type { PackStartCall } from '../../src/lib/pack-calls.ts';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

/** An interactive block with state of its own: a tab strip whose choice lives inside the frame. */
const HTML_BLOCK = [
  '```fy-render',
  'type: html',
  'alt: An agenda with tabs',
  '---',
  '<button id="t2">Day 2</button><script>t2.onclick = () => document.body.dataset.tab = "2"</script>',
  '```',
];

/**
 * EVERY BLOCK ON SCREEN. A block draws only once it is near the viewport, and happy-dom has no layout
 * to say so; this observer reports each element in view the moment it is observed.
 */
class OnScreen {
  constructor(readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void {
    this.callback([{ isIntersecting: true, target } as unknown as IntersectionObserverEntry], this as never);
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
const realObserver = globalThis.IntersectionObserver;

/**
 * LOADS, COUNTED. Each frame the block mounts points itself at the shell once, so a count of `src`
 * assignments is a count of pages started — a re-created frame is a second one. The assignment is
 * kept from reaching happy-dom, whose navigation-disabled frame answers it with two `load`s, which
 * the frame's own guard would rightly read as the page navigating away.
 */
let loads = 0;
const frameSrc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
beforeAll(() => {
  globalThis.IntersectionObserver = OnScreen as unknown as typeof IntersectionObserver;
  Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
    configurable: true,
    get: () => '',
    set: () => {
      loads += 1;
    },
  });
});
afterAll(() => {
  globalThis.IntersectionObserver = realObserver;
  if (frameSrc !== undefined) Object.defineProperty(HTMLIFrameElement.prototype, 'src', frameSrc);
});

const mounted: Mounted[] = [];
const mountTracked = async (...args: Parameters<typeof mount>): Promise<Mounted> => {
  const view = await mount(...args);
  mounted.push(view);
  return view;
};
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
  loads = 0;
});

const htmlFrame = (view: Mounted): Element =>
  must(view.container.querySelector('iframe[data-fy-render-frame="html"]'), 'the interactive frame');

/** One log record per line, continuation lines indented the way the daemon writes them. */
const record = (clock: string, role: 'user' | 'assistant', lines: readonly string[]): string =>
  [`[${clock}] ${role}/message: ${lines[0] ?? ''}`, ...lines.slice(1).map(line => `    ${line}`)].join('\n');

const clockAt = (second: number): string =>
  `10:${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}`;

describe('Markdown keeps what it drew across a re-render', () => {
  test('an interactive html block keeps its frame when its message re-renders five times', async () => {
    // Arrange — the session's reference surface is rebuilt whenever a terminal, page or task changes,
    // which hands every message new opener functions.
    const text = ['Here is the agenda:', '', ...HTML_BLOCK].join('\n');
    const view = await mountTracked(<Markdown enableFyRender onTaskOpen={() => undefined} text={text} />);
    const frame = htmlFrame(view);

    // Act
    for (let round = 0; round < 5; round++)
      await view.render(<Markdown enableFyRender onTaskOpen={() => undefined} text={text} />);

    // Assert — the same element, started once: the page inside it, and its state, were never thrown away.
    expect(htmlFrame(view)).toBe(frame);
    expect(loads).toBe(1);
  });

  test('a table keeps its element when its message re-renders', async () => {
    // Arrange — a table's own state (its full-screen sheet) lives in the component that draws it.
    const text = '| a | b |\n| - | - |\n| 1 | 2 |';
    const view = await mountTracked(<Markdown onTaskOpen={() => undefined} text={text} />);
    const table = must(view.container.querySelector('.md-table'), 'the table');

    // Act
    await view.render(<Markdown onTaskOpen={() => undefined} text={text} />);

    // Assert
    expect(view.container.querySelector('.md-table')).toBe(table);
  });
});

describe('the transcript keeps a settled reply mounted as new messages arrive', () => {
  /** The daemon's view of a long session: the newest `size` records of `total`, as `logs()` returns them. */
  const window = (total: number, size: number): string => {
    const records: string[] = [];
    for (let second = 0; second < total; second++) {
      if (second === 15) records.push(record(clockAt(second), 'assistant', ['Here is the agenda:', '', ...HTML_BLOCK]));
      else records.push(record(clockAt(second), second % 2 === 0 ? 'user' : 'assistant', [`message ${second}`]));
    }
    return records.slice(Math.max(0, total - size)).join('\n');
  };

  test('settled rows keep their ids when the window slides', () => {
    // Arrange — a full window, then the same session after three more events pushed three out.
    const before = transcriptEntriesFromLog(window(20, 12), NOW);
    const after = transcriptEntriesFromLog(window(23, 12), NOW);

    // Assert — every row still on screen is the same row.
    const kept = new Set(after.map(entry => entry.id));
    const survivors = before.slice(3);
    expect(survivors.length).toBeGreaterThan(0);
    for (const entry of survivors) expect(kept.has(entry.id)).toBe(true);
  });

  test('an interactive block keeps its frame through eight new messages in a sliding window', async () => {
    // Arrange
    const entriesAt = (total: number) => transcriptEntriesFromLog(window(total, 10), NOW);
    const view = await mountTracked(<Transcript daemonId="d" entries={entriesAt(16)} sessionId="s" />);
    const frame = htmlFrame(view);

    // Act — messages land one by one; the window drops one from the top for each.
    for (let total = 17; total <= 24; total++)
      await view.render(<Transcript daemonId="d" entries={entriesAt(total)} sessionId="s" />);

    // Assert
    expect(htmlFrame(view)).toBe(frame);
    expect(loads).toBe(1);
  });

  test('a tool group the reader opened stays open as the run grows', async () => {
    // Arrange — a run of two calls, then the same run with a third written after them.
    const call = (clock: string, name: string) => `[${clock}] assistant/tool-call: ${name}({"path":"a.ts"})`;
    const first = [record('10:00:00', 'user', ['go']), call('10:00:01', 'Read'), call('10:00:02', 'Grep')].join('\n');
    const grown = [first, call('10:00:03', 'Edit')].join('\n');
    const view = await mountTracked(
      <Transcript daemonId="d" entries={transcriptEntriesFromLog(first, NOW)} sessionId="s" />,
    );
    const toggle = must(
      view.container.querySelector<HTMLButtonElement>('[data-transcript-kind="tool"] .kt-chrome > button'),
      'the tool group toggle',
    );
    await interact(() => toggle.click());
    const opened = (): number =>
      view.container.querySelectorAll('[data-transcript-kind="tool"] .kt-chrome > div').length;
    expect(opened()).toBe(1);

    // Act
    await view.render(<Transcript daemonId="d" entries={transcriptEntriesFromLog(grown, NOW)} sessionId="s" />);

    // Assert — the same toggle, still open.
    const after = must(
      view.container.querySelector<HTMLButtonElement>('[data-transcript-kind="tool"] .kt-chrome > button'),
      'the tool group toggle',
    );
    expect(after).toBe(toggle);
    expect(opened()).toBe(1);
  });
});

describe('a fold the reader opened stays open when its row is redrawn in a new state', () => {
  test('a lone tool line stays open as the run it starts becomes a group', async () => {
    // Arrange — one finished call and one still running: the finished one is drawn as a bare line.
    const call = (clock: string, name: string) => `[${clock}] assistant/tool-call: ${name}({"path":"a.ts"})`;
    const result = (clock: string) => `[${clock}] tool/tool-result: contents`;
    const running = [
      record('10:00:00', 'user', ['go']),
      call('10:00:01', 'Read'),
      result('10:00:02'),
      call('10:00:03', 'Edit'),
    ].join('\n');
    const finished = [running, result('10:00:04')].join('\n');
    const view = await mountTracked(
      <Transcript busy daemonId="d" entries={transcriptEntriesFromLog(running, NOW)} sessionId="s" />,
    );
    const line = must(
      view.container.querySelector<HTMLButtonElement>('[data-transcript-kind="tool"] .kt-chrome > button'),
      'the line',
    );
    await interact(() => line.click());
    const bodies = (): number => view.container.querySelectorAll('[data-transcript-kind="tool"] .mb-1').length;
    expect(bodies()).toBe(1);

    // Act — the second call finishes: the run is now a group of two.
    await view.render(<Transcript busy daemonId="d" entries={transcriptEntriesFromLog(finished, NOW)} sessionId="s" />);

    // Assert — the group is open and the call the reader opened is still open inside it.
    expect(view.container.querySelector('[data-transcript-kind="tool"] .kt-chrome > button')?.textContent).toContain(
      '2 tools',
    );
    expect(bodies()).toBe(1);

    // Act — the reader folds that call again, from inside the group.
    const lines = view.container.querySelectorAll<HTMLButtonElement>(
      '[data-transcript-kind="tool"] .border-l .kt-chrome > button',
    );
    await interact(() => must(lines[0], 'the call inside the group').click());

    // Assert — it closes; the group stays open around it.
    expect(bodies()).toBe(0);
    expect(lines.length).toBe(2);
  });

  test('a sub-ferret start keeps its brief open as the start finishes', async () => {
    // Arrange
    const pack = (progress: PackStartCall['progress']): TranscriptEntry => ({
      id: 'pack:k1',
      kind: 'tool',
      text: 'started a sub-ferret',
      tools: [
        { key: 'k1', use: { name: 'Bash', input: { command: 'fy new --auto "Review it"' } }, result: { text: '' } },
      ],
      pack: {
        kind: 'new',
        runtime: 'claude',
        model: 'claude-opus-5-5',
        auto: false,
        brief: 'Review the pack.',
        progress,
      },
    });
    const draw = (entry: TranscriptEntry) => (
      <PackSessionsProvider sessions={[]}>
        <TranscriptRow entry={entry} />
      </PackSessionsProvider>
    );
    const view = await mountTracked(draw(pack({ state: 'running' })));
    const fold = must(view.container.querySelector<HTMLDetailsElement>('details.fy-pack-fold'), 'the brief');
    fold.open = true;

    // Act
    await view.render(
      draw(
        pack({
          state: 'done',
          value: {
            outcome: 'started',
            id: 'mv1',
            teammate: 'nadia',
            runtime: 'claude',
            decidedBy: 'you',
            attempts: [],
          },
        }),
      ),
    );

    // Assert — the same element, still open.
    const after = must(view.container.querySelector<HTMLDetailsElement>('details.fy-pack-fold'), 'the brief');
    expect(after).toBe(fold);
    expect(after.open).toBe(true);
  });
});
