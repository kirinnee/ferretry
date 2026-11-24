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
  const read = (at: string, excluded: Set<string> = none, answered: Set<string> = none) =>
    progressOf(flow, pages, answered, excluded, at);

  test('one segment per counted page: the bar is as long as the total and its lit segment is the place', () => {
    const state = read('fake-pack.choose');
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

  test('walking forward the total never moves and the place only goes up, even over pages that pass themselves over', () => {
    let state = startRun(pages, none);
    const reads: [number, number][] = [];
    for (let guard = 0; state.at !== END && guard < 20; guard += 1) {
      const now = progressOf(flow, pages, none, none, state.at);
      reads.push([now?.step ?? 0, now?.of ?? 0]);
      // The page that is next declares itself not needed on mount: it is passed, and the total stays where it was.
      state = advance(state, pages, none);
      if (state.at === 'fake-pack.choose') state = markNotNeeded(state, pages, none, 'fake-pack.choose');
    }
    expect(reads).toEqual([
      [1, 6],
      [2, 6],
      [4, 6],
      [5, 6],
      [6, 6],
    ]);
  });

  test('the total changes only when an answer adds or removes pages', () => {
    const passes = new Set(['fake-pack.choose', 'fake-pack.finish']);
    expect(read('fake-pack.welcome')).toMatchObject({ step: 2, of: 6 });
    expect(read('fake-pack.welcome', passes)).toMatchObject({ step: 2, of: 4 });
  });

  test('the page on screen always counts, even when the answers leave it out', () => {
    expect(read('fake-pack.choose', new Set(['fake-pack.choose']))).toMatchObject({ step: 3, of: 6 });
  });

  test('an answered-before page is not counted', () => {
    const state = read('fake-pack.welcome', none, new Set(['onboarding.name']));
    expect([state?.step, state?.of]).toEqual([1, 5]);
  });

  describe('an offer page (Connect GitHub)', () => {
    const offered = flowOf();
    const withOffer = [
      ...pagesOf(offered),
      { key: 'projects.github', plugin: 'projects', id: 'github', phase: 'client' },
    ] as never;
    const last = pagesOf(offered).at(-1)?.key ?? '';
    const everyOther = new Set(pagesOf(offered).map(page => page.key));

    test('counts up front whenever the run has another page to draw before it, so the total never moves on the way there', () => {
      expect(progressOf(offered, withOffer, none, none, last)).toMatchObject({ step: 6, of: 7 });
      expect(progressOf(offered, withOffer, none, none, 'projects.github')).toMatchObject({ step: 7, of: 7 });
    });

    test('is not counted more than the page on screen when every page before it is answered or left out (the run would pass it over)', () => {
      expect(progressOf(offered, withOffer, everyOther, none, 'projects.github')).toMatchObject({ step: 1, of: 1 });
      expect(progressOf(offered, withOffer, none, everyOther, 'projects.github')).toMatchObject({ step: 1, of: 1 });
      const answered = new Set(everyOther);
      answered.delete(last);
      expect(progressOf(offered, withOffer, answered, none, last)).toMatchObject({ step: 1, of: 2 });
    });
  });

  test('Back lowers the place by one and nothing else', () => {
    expect(read('fake-pack.finish')).toMatchObject({ step: 4, of: 6 });
    expect(read('fake-pack.choose')).toMatchObject({ step: 3, of: 6 });
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

  test('no import mode chosen yet counts as the page default, Import everything: the checklist is passed, the run page is not', () => {
    expect(foreseenPassedOver(claude(...ids), named(undefined)).size).toBe(5);
    expect(foreseenPassedOver(claude(...ids), named('custom')).size).toBe(0);
  });

  test("a harness's pages the default pick leaves out are undecided until Which AI is answered", () => {
    const harnesses = new Set(['claude-code', 'codex']);
    expect(undecidedPages(claude(...ids), harnesses, new Set(['claude-code']), true).size).toBe(0);
    expect(undecidedPages(claude(...ids), harnesses, new Set(['codex']), true).size).toBe(ids.length);
    expect(undecidedPages(claude(...ids), harnesses, new Set(['codex']), false).size).toBe(0);
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

  test('Choose what to import passes over nothing', () => {
    expect(foreseenPassedOver(claude(...ids), named('choose')).size).toBe(0);
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

  test('stays in the count as a passed page, and Back from the page after it lands on the last page actually shown', () => {
    const state = markNotNeeded(
      at(startRun(pages, none), 'fake-pack.choose', ['fake-pack.welcome']),
      pages,
      none,
      'fake-pack.choose',
    );
    const flow = flowOf();
    expect(progressOf(flow, pages, none, none, 'fake-pack.finish')).toMatchObject({ step: 4, of: 6 });
    expect(retreat(state).at).toBe('fake-pack.welcome');
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
