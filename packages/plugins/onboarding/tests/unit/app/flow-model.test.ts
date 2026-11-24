import { describe, expect, test } from 'bun:test';
import { EMPTY_LEDGER, flattenFlow, type PairedDaemon } from '../../../app/lib/index.ts';
import {
  advance,
  answeredBefore,
  clearNotNeeded,
  dropPage,
  END,
  markNotNeeded,
  pagesOf,
  passedOver,
  progressOf,
  retreat,
  startRun,
} from '../../../app/features/setup-flow/flow-model.ts';
import { readFlowAddress, setupFlowHref } from '../../../app/features/setup-flow/flow-href.ts';
import { foreseenPassedOver, undecidedPages } from '../../../app/features/setup-flow/foresight.ts';
import { fakeDaemon } from '../../fixtures/fake-steps/index.ts';

const A = 'fy_daemon_a';
const daemon = (extra: Partial<PairedDaemon> = {}): PairedDaemon => ({ ...fakeDaemon(A, 'Studio'), ...extra });
const flowOf = (
  daemons: readonly PairedDaemon[] = [daemon()],
  journey: 'first-time' | 'pair' | 'add-daemon' = 'first-time',
) => flattenFlow({ journey, target: A, daemons, ledger: EMPTY_LEDGER });
const keys = (pages: readonly { readonly key: string }[]): string[] => pages.map(page => page.key);

describe('the run: which pages, in which order', () => {
  test('the machine first, then this device', () => {
    expect(keys(pagesOf(flowOf()))).toEqual([
      'onboarding.name',
      'fake-pack.welcome',
      'fake-pack.choose',
      'fake-pack.finish',
      'onboarding.appearance',
      'fake-pack.look',
    ]);
  });

  test('a run resumes at the first page nobody answered, and a client page left for later is not asked again', () => {
    const answered = daemon({
      steps: daemon().steps.map(step =>
        step.id === 'name' || step.id === 'welcome' ? { ...step, state: 'done' as const } : step,
      ),
    });
    const pages = pagesOf(flowOf([answered]));
    const before = answeredBefore(pages, new Set(['onboarding.appearance']), []);
    expect([...before].sort()).toEqual(['fake-pack.welcome', 'onboarding.appearance', 'onboarding.name']);
    expect(startRun(pages, before).at).toBe('fake-pack.choose');
    // Walking on passes the page left for later.
    let state = startRun(pages, before);
    state = advance(state, pages, before);
    state = advance(state, pages, before);
    expect(state.at).toBe('fake-pack.look');
  });

  test('everything answered starts at the end', () => {
    const pages = pagesOf(flowOf([daemon({ steps: daemon().steps.filter(step => step.side === 'client') })]));
    const all = new Set(pages.map(page => page.key));
    expect(startRun(pages, all).at).toBe(END);
  });
});

describe('moving through the run', () => {
  const pages = pagesOf(flowOf());
  const none = new Set<string>();

  test('every move counts a new visit, so a callback from a page already left can be told apart', () => {
    const start = startRun(pages, none);
    const second = advance(start, pages, none);
    const back = retreat(second);
    expect([start.visit, second.visit, back.visit]).toEqual([0, 1, 2]);
    expect(back.at).toBe(start.at);
  });

  test('Next goes forward, Back returns to where the person came from, the end stays the end', () => {
    let state = startRun(pages, none);
    expect(state.at).toBe('onboarding.name');
    state = advance(state, pages, none);
    state = advance(state, pages, none);
    expect(state.at).toBe('fake-pack.choose');
    expect(retreat(state).at).toBe('fake-pack.welcome');
    expect(retreat(state).direction).toBe('back');
    let last = state;
    for (let step = 0; step < 10; step += 1) last = advance(last, pages, none);
    expect(last.at).toBe(END);
    expect(advance(last, pages, none)).toBe(last);
  });

  test('Back at the first page stays at the first page', () => {
    const state = startRun(pages, none);
    expect(retreat(state)).toBe(state);
  });

  test('a page that skips itself is gone: the run moves on without putting it on the trail, and Back never lands on it', () => {
    let state = startRun(pages, none);
    state = advance(state, pages, none); // welcome
    state = advance(state, pages, none); // choose
    expect(state.at).toBe('fake-pack.choose');
    state = dropPage(state, pages, none, 'fake-pack.choose');
    expect(state.at).toBe('fake-pack.finish');
    expect(state.trail).not.toContain('fake-pack.choose');
    expect(retreat(state).at).toBe('fake-pack.welcome');
  });

  test('a page that skips itself while another is on screen is only marked gone', () => {
    const state = startRun(pages, none);
    const dropped = dropPage(state, pages, none, 'fake-pack.finish');
    expect(dropped.at).toBe('onboarding.name');
    expect([...dropped.gone]).toEqual(['fake-pack.finish']);
    // ... and is passed by when the run gets there.
    const at = advance(advance(advance(dropped, pages, none), pages, none), pages, none);
    expect(at.at).toBe('onboarding.appearance');
  });
});

describe('the progress counter: ONE reading for the words and the bar', () => {
  const flow = flowOf();
  const pages = pagesOf(flow);
  const none = new Set<string>();
  const read = (at: string, trail: readonly string[], extra: { passed?: Set<string>; unknown?: Set<string> } = {}) =>
    progressOf(flow, pages, none, extra.passed ?? none, extra.unknown ?? none, at, trail);

  test('one segment per counted page: the bar is as long as the total and its lit segment is the place', () => {
    const state = read('fake-pack.choose', ['onboarding.name', 'fake-pack.welcome']);
    expect([state?.step, state?.of]).toEqual([3, 6]);
    expect(state?.segments).toHaveLength(6);
    expect(state?.segments[(state?.step ?? 0) - 1]?.id).toBe(state?.current);
    expect(state?.segments.map(segment => segment.label)).toEqual([
      'Onboarding',
      'Fake Pack',
      'Fake Pack',
      'Fake Pack',
      'This device',
      'This device',
    ]);
  });

  test('walking forward the counter only goes up and never falls below the page on screen', () => {
    let state = startRun(pages, none);
    const reads: [number, number][] = [];
    for (let guard = 0; state.at !== END && guard < 20; guard += 1) {
      const now = progressOf(flow, pages, none, passedOver(state), none, state.at, state.trail);
      reads.push([now?.step ?? 0, now?.of ?? 0]);
      state = advance(state, pages, none);
    }
    expect(reads).toEqual([
      [1, 6],
      [2, 6],
      [3, 6],
      [4, 6],
      [5, 6],
      [6, 6],
    ]);
  });

  test('a page that passes over is never counted: the total shrinks but never below the page on screen', () => {
    const passed = new Set(['fake-pack.choose']);
    const state = read('fake-pack.finish', ['onboarding.name', 'fake-pack.welcome'], { passed });
    expect([state?.step, state?.of]).toEqual([3, 5]);
  });

  test('pages not decided yet are left out of the total, and the total grows when they turn out to be needed', () => {
    const unknown = new Set(['fake-pack.choose', 'fake-pack.finish']);
    expect(read('fake-pack.welcome', ['onboarding.name'], { unknown })).toMatchObject({ step: 2, of: 4 });
    expect(read('fake-pack.welcome', ['onboarding.name'])).toMatchObject({ step: 2, of: 6 });
  });

  test('the page on screen always counts, even when it was foreseen to pass over', () => {
    const unknown = new Set(['fake-pack.choose']);
    expect(read('fake-pack.choose', ['onboarding.name', 'fake-pack.welcome'], { unknown })).toMatchObject({
      step: 3,
      of: 6,
    });
  });

  test('an answered-before page is not counted', () => {
    const state = progressOf(flow, pages, new Set(['onboarding.name']), none, none, 'fake-pack.welcome', []);
    expect([state?.step, state?.of]).toEqual([1, 5]);
  });

  test('an offer page does not count, unless it is the page on screen', () => {
    const offered = flowOf();
    const withOffer = [
      ...pagesOf(offered),
      { key: 'projects.github', plugin: 'projects', id: 'github', phase: 'client' },
    ] as never;
    const last = pagesOf(offered).at(-1)?.key ?? '';
    expect(
      progressOf(
        offered,
        withOffer,
        none,
        none,
        none,
        last,
        pagesOf(offered)
          .slice(0, -1)
          .map(page => page.key),
      ),
    ).toMatchObject({
      step: 6,
      of: 6,
    });
    expect(
      progressOf(
        offered,
        withOffer,
        none,
        none,
        none,
        'projects.github',
        pagesOf(offered).map(page => page.key),
      ),
    ).toMatchObject({
      step: 7,
      of: 7,
    });
  });

  test('Back lowers the place by one and nothing else', () => {
    const forward = read('fake-pack.finish', ['onboarding.name', 'fake-pack.welcome', 'fake-pack.choose']);
    const back = read('fake-pack.choose', ['onboarding.name', 'fake-pack.welcome']);
    expect([forward?.step, forward?.of]).toEqual([4, 6]);
    expect([back?.step, back?.of]).toEqual([3, 6]);
  });
});

describe('the pages the answers given so far pass over', () => {
  const claude = (...ids: string[]) =>
    ids.map(id => ({ key: `claude-code.${id}`, plugin: 'claude-code', id, phase: 'daemon' as const })) as never;
  const ids = [
    'import-choice',
    'import-settings',
    'import-model-set',
    'import-instructions',
    'import-skills',
    'import-mcp',
    'conversations',
    'import-run',
    'permission',
  ];
  const named = (mode: string | undefined) => (plugin: string) =>
    plugin === 'claude-code' && mode !== undefined ? { importMode: mode } : {};

  test('before the import mode is chosen the checklist and the run page are undecided; a chosen mode decides them', () => {
    expect([...undecidedPages(claude(...ids), named(undefined), new Set(), false)].length).toBe(6);
    expect(undecidedPages(claude(...ids), named('custom'), new Set(), false).size).toBe(0);
  });

  test("a harness's pages are undecided until Which AI is answered", () => {
    const harnesses = new Set(['claude-code']);
    expect(undecidedPages(claude(...ids), named('custom'), harnesses, true).size).toBe(ids.length);
    expect(undecidedPages(claude(...ids), named('custom'), harnesses, false).size).toBe(0);
  });

  test('Import everything passes over the five checklist pages and keeps the run page', () => {
    expect([...foreseenPassedOver(claude(...ids), named('everything'))]).toEqual([
      'claude-code.import-settings',
      'claude-code.import-model-set',
      'claude-code.import-instructions',
      'claude-code.import-skills',
      'claude-code.import-mcp',
    ]);
  });

  test('Start fresh passes over the checklist pages and the run page', () => {
    expect(foreseenPassedOver(claude(...ids), named('fresh')).size).toBe(6);
  });

  test('Choose what to import, or no answer yet (a reload), passes over nothing', () => {
    expect(foreseenPassedOver(claude(...ids), named('choose')).size).toBe(0);
    expect(foreseenPassedOver(claude(...ids), named(undefined)).size).toBe(0);
  });

  test('another plugin that says nothing about an import mode is never touched, and a client page never is', () => {
    expect(foreseenPassedOver(claude(...ids), () => ({ importMode: 'everything' })).size).toBe(5);
    const client = [{ key: 'voice.voice', plugin: 'voice', id: 'import-skills', phase: 'client' }] as never;
    expect(foreseenPassedOver(client, () => ({ importMode: 'everything' })).size).toBe(0);
  });
});

describe('the flow address', () => {
  test('builds the machine address with only the words given', () => {
    expect(setupFlowHref('fy_daemon_a')).toBe('/d/fy_daemon_a/onboarding/setup');
    expect(setupFlowHref('fy_daemon_a', { phase: 'client', journey: 'pair' })).toBe(
      '/d/fy_daemon_a/onboarding/setup?phase=client&journey=pair',
    );
  });

  test('reads it back: Pair starts in the client phase, anything unknown is the default', () => {
    expect(readFlowAddress('')).toEqual({ phase: 'daemon', journey: 'first-time' });
    expect(readFlowAddress('?phase=client')).toEqual({ phase: 'client', journey: 'pair' });
    expect(readFlowAddress('?phase=daemon&journey=add-daemon')).toEqual({ phase: 'daemon', journey: 'add-daemon' });
    expect(readFlowAddress('?phase=sideways&journey=nowhere')).toEqual({ phase: 'daemon', journey: 'first-time' });
  });
});

describe('a page that is not needed for this run', () => {
  const pages = pagesOf(flowOf());
  const none = new Set<string>();
  const at = (state: ReturnType<typeof startRun>, key: string, trail: readonly string[] = []) => ({
    ...state,
    at: key,
    trail,
  });

  test('the run passes over it going forward, without putting it on the trail, and nothing is gone', () => {
    const state = markNotNeeded(
      at(startRun(pages, none), 'fake-pack.choose', ['fake-pack.welcome']),
      pages,
      none,
      'fake-pack.choose',
    );
    expect(state.at).toBe('fake-pack.finish');
    expect(state.trail).toEqual(['fake-pack.welcome']);
    expect(state.gone.size).toBe(0);
    expect(state.direction).toBe('forward');
    // The next move forward from the page before it does not stop on it either, and Back skips nothing it never reached.
    const before = at(state, 'fake-pack.welcome', ['onboarding.name']);
    expect(advance(before, pages, none).at).toBe('fake-pack.finish');
    expect(retreat(state).at).toBe('fake-pack.welcome');
  });

  test('is not counted by the progress bar, and Back from the page after it lands on the last page actually shown', () => {
    const state = markNotNeeded(
      at(startRun(pages, none), 'fake-pack.choose', ['fake-pack.welcome']),
      pages,
      none,
      'fake-pack.choose',
    );
    const flow = flowOf();
    expect(
      progressOf(
        flow,
        pages,
        none,
        new Set([...state.gone, ...state.notNeeded]),
        none,
        'fake-pack.finish',
        state.trail,
      ),
    ).toMatchObject({
      step: 2,
      of: 4,
    });
  });

  test('a page reached by Back that is no longer needed sends the person on back, or forward when nothing is before it', () => {
    const back = markNotNeeded(
      { ...at(startRun(pages, none), 'fake-pack.choose', ['onboarding.name', 'fake-pack.welcome']), direction: 'back' },
      pages,
      none,
      'fake-pack.choose',
    );
    expect(back.at).toBe('fake-pack.welcome');
    expect(back.direction).toBe('back');
    const first = markNotNeeded(
      { ...at(startRun(pages, none), 'onboarding.name'), direction: 'back' },
      pages,
      none,
      'onboarding.name',
    );
    expect(first.at).toBe('fake-pack.welcome');
    expect(first.direction).toBe('forward');
  });

  test('every page marked past the last one ends the run', () => {
    let state = at(startRun(pages, none), 'fake-pack.finish');
    state = markNotNeeded(state, pages, none, 'fake-pack.finish');
    expect(state.at).toBe('onboarding.appearance');
    state = markNotNeeded(state, pages, none, 'onboarding.appearance');
    state = markNotNeeded(state, pages, none, 'fake-pack.look');
    expect(state.at).toBe(END);
  });

  test('a mark of a page that is not on screen waits quietly and never moves the run', () => {
    const state = markNotNeeded(at(startRun(pages, none), 'fake-pack.welcome'), pages, none, 'fake-pack.finish');
    expect(state.at).toBe('fake-pack.welcome');
    expect(state.notNeeded.has('fake-pack.finish')).toBe(true);
  });

  test("a change in the plugin's segment memory clears that plugin's marks ahead of the page on screen, and no other plugin's", () => {
    let state = at(startRun(pages, none), 'fake-pack.choose');
    state = markNotNeeded(state, pages, none, 'fake-pack.choose');
    state = markNotNeeded({ ...state, at: 'onboarding.name' }, pages, none, 'onboarding.name');
    expect([...state.notNeeded].sort()).toEqual(['fake-pack.choose', 'onboarding.name']);
    // On the first page: the mark ahead of it goes; the other plugin's stays.
    const fromFirst = { ...state, at: 'fake-pack.welcome' };
    expect([...clearNotNeeded(fromFirst, pages, 'fake-pack').notNeeded]).toEqual(['onboarding.name']);
    expect(clearNotNeeded(fromFirst, pages, 'nobody').notNeeded).toBe(state.notNeeded);
  });

  test('a mark BEHIND the page on screen stays when a later page leaves its own memory (it is already passed)', () => {
    let state = at(startRun(pages, none), 'fake-pack.choose');
    state = markNotNeeded(state, pages, none, 'fake-pack.choose');
    expect(state.at).toBe('fake-pack.finish');
    expect(clearNotNeeded(state, pages, 'fake-pack').notNeeded).toBe(state.notNeeded);
    expect(clearNotNeeded({ ...state, at: END }, pages, 'fake-pack').notNeeded).toBe(state.notNeeded);
  });
});
