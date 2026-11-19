import { describe, expect, test } from 'bun:test';
import { EMPTY_LEDGER, flattenFlow, type PairedDaemon } from '../../../app/lib/index.ts';
import {
  advance,
  answeredBefore,
  dropPage,
  END,
  pagesOf,
  progressOf,
  retreat,
  startRun,
} from '../../../app/features/setup-flow/flow-model.ts';
import { readFlowAddress, setupFlowHref } from '../../../app/features/setup-flow/flow-href.ts';
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
    const before = answeredBefore(pages, new Set(['onboarding.appearance']));
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

describe('the progress bar', () => {
  const flow = flowOf();
  const pages = pagesOf(flow);
  const none = new Set<string>();

  test('one segment per plugin with pages left, then "This device"; n of m counts inside the current segment', () => {
    const read = progressOf(flow, pages, none, none, 'fake-pack.choose');
    expect(read?.segments.map(segment => segment.label)).toEqual(['Onboarding', 'Fake Pack', 'This device']);
    expect(read?.current).toBe('fake-pack');
    expect([read?.step, read?.of]).toEqual([2, 3]);
  });

  test('a skipped page never counts: the total shrinks, it never grows backwards', () => {
    const gone = new Set(['fake-pack.choose']);
    const read = progressOf(flow, pages, none, gone, 'fake-pack.finish');
    expect([read?.step, read?.of]).toEqual([2, 2]);
  });

  test('the client pages are one segment, whichever plugin they belong to', () => {
    const read = progressOf(flow, pages, none, none, 'fake-pack.look');
    expect(read?.current).toBe('device');
    expect([read?.step, read?.of]).toEqual([2, 2]);
  });

  test('answered-before pages leave the bar', () => {
    const read = progressOf(flow, pages, new Set(['onboarding.name']), none, 'fake-pack.welcome');
    expect(read?.segments.map(segment => segment.id)).toEqual(['fake-pack', 'device']);
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
