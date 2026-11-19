import { describe, expect, test } from 'bun:test';
import type { Instant } from '@ferretry/std';
import type { StepView } from '../../../contract/index.ts';
import { EMPTY_LEDGER, withClientStep } from '../../../app/lib/client-ledger.ts';
import {
  askableSteps,
  firstUnanswered,
  flattenFlow,
  type FlowSegment,
  type PairedDaemon,
  stepsOf,
} from '../../../app/lib/flatten.ts';
import { fakeDaemon, FAKE_PLUGIN } from '../../fixtures/fake-steps/index.ts';

const AT = '2026-11-19T09:00:00.000Z' as Instant;
const A = 'fy_daemon_a';
const B = 'fy_daemon_b';
const keys = (segments: readonly FlowSegment[]): string[] => stepsOf(segments).map(step => step.key);

const view = (plugin: string, id: string, order: number, side: 'daemon' | 'client', extra: Partial<StepView> = {}) =>
  ({ plugin, id, title: id, order, side, state: 'pending', ...extra }) as StepView;

describe('flattening: the daemon phase', () => {
  test('segments sort by their lowest order (Onboarding first), steps by order then id', () => {
    const daemon: PairedDaemon = {
      id: A,
      name: 'Studio',
      steps: [
        view('warden', 'warden', 60, 'daemon'),
        view('claude-code', 'import', 23, 'daemon'),
        view('claude-code', 'installed', 20, 'daemon'),
        view('codex', 'installed', 40, 'daemon'),
        view('claude-code', 'permission', 30, 'daemon'),
        view('onboarding', 'name', 5, 'daemon'),
        view('runtimes', 'start', 10, 'daemon'),
      ],
    };
    const flow = flattenFlow({ journey: 'first-time', target: A, daemons: [daemon], ledger: EMPTY_LEDGER });
    expect(flow.daemon.map(segment => segment.plugin)).toEqual([
      'onboarding',
      'runtimes',
      'claude-code',
      'codex',
      'warden',
    ]);
    // Claude's three steps stay together even though runtimes' step sits between their orders' neighbours.
    expect(keys(flow.daemon)).toEqual([
      'onboarding.name',
      'runtimes.start',
      'claude-code.installed',
      'claude-code.import',
      'claude-code.permission',
      'codex.installed',
      'warden.warden',
    ]);
  });

  test('two plugins whose first steps share an order sort by plugin id, whatever order they arrived in', () => {
    const daemon: PairedDaemon = {
      id: A,
      name: 'Studio',
      steps: [view('zeta', 'one', 50, 'daemon'), view('alpha', 'one', 50, 'daemon'), view('mid', 'one', 50, 'daemon')],
    };
    const flow = flattenFlow({ journey: 'first-time', target: A, daemons: [daemon], ledger: EMPTY_LEDGER });
    expect(flow.daemon.map(segment => segment.plugin)).toEqual(['alpha', 'mid', 'zeta']);
  });

  test('only the machine being set up, and only its daemon-side steps', () => {
    const flow = flattenFlow({
      journey: 'add-daemon',
      target: B,
      daemons: [fakeDaemon(A, 'Studio'), fakeDaemon(B, 'Laptop')],
      ledger: EMPTY_LEDGER,
    });
    expect(keys(flow.daemon)).toEqual([
      'onboarding.name',
      `${FAKE_PLUGIN}.welcome`,
      `${FAKE_PLUGIN}.choose`,
      `${FAKE_PLUGIN}.finish`,
    ]);
    expect(stepsOf(flow.daemon).every(step => step.appliesTo.length === 1 && step.appliesTo[0]?.daemon === B)).toBe(
      true,
    );
    expect(stepsOf(flow.daemon).every(step => step.onlyOn.length === 0)).toBe(true);
  });

  test('the segment title is the declared group, else the plugin title, else the id in words', () => {
    const daemon: PairedDaemon = {
      id: A,
      name: 'Studio',
      steps: [
        view('claude-code', 'a', 20, 'daemon', { group: 'Claude' }),
        view('shells', 'nix', 80, 'daemon'),
        view('lessons', 'l', 70, 'daemon'),
      ],
    };
    const flow = flattenFlow({
      journey: 'first-time',
      target: A,
      daemons: [daemon],
      ledger: EMPTY_LEDGER,
      pluginTitles: { shells: 'Nix shells' },
    });
    expect(flow.daemon.map(segment => segment.group)).toEqual(['Claude', 'Lessons', 'Nix shells']);
  });

  test('a recorded answer is not asked again: resume lands on the first pending step', () => {
    const daemon: PairedDaemon = {
      id: A,
      name: 'Studio',
      steps: [
        view('claude-code', 'installed', 20, 'daemon', { state: 'done' }),
        view('claude-code', 'sign-in', 21, 'daemon', { state: 'found' }),
        view('claude-code', 'permission', 30, 'daemon'),
      ],
    };
    const flow = flattenFlow({ journey: 'first-time', target: A, daemons: [daemon], ledger: EMPTY_LEDGER });
    expect(firstUnanswered(flow.daemon)?.key).toBe('claude-code.permission');
    const finished = flattenFlow({
      journey: 'first-time',
      target: A,
      daemons: [{ ...daemon, steps: daemon.steps.map(step => ({ ...step, state: 'done' as const })) }],
      ledger: EMPTY_LEDGER,
    });
    expect(firstUnanswered(finished.daemon)).toBeUndefined();
  });
});

describe('flattening: the client phase', () => {
  test("a step on two daemons is asked once; Onboarding's own page leads", () => {
    const flow = flattenFlow({
      journey: 'first-time',
      target: A,
      daemons: [fakeDaemon(A, 'Studio'), fakeDaemon(B, 'Laptop')],
      ledger: EMPTY_LEDGER,
    });
    expect(keys(flow.client)).toEqual(['onboarding.appearance', `${FAKE_PLUGIN}.look`]);
    const look = stepsOf(flow.client).find(step => step.id === 'look');
    expect(look?.appliesTo.map(on => on.daemon)).toEqual([A, B]);
    // On every paired daemon: no chip.
    expect(look?.onlyOn).toEqual([]);
  });

  test('a step on only some paired daemons carries the "Only on" names', () => {
    const flow = flattenFlow({
      journey: 'first-time',
      target: A,
      daemons: [fakeDaemon(A, 'Studio'), fakeDaemon(B, 'Laptop', { withFake: false })],
      ledger: EMPTY_LEDGER,
    });
    const look = stepsOf(flow.client).find(step => step.id === 'look');
    expect(look?.onlyOn).toEqual(['Studio']);
    // Onboarding's own page is on both, so it is not highlighted.
    expect(stepsOf(flow.client).find(step => step.id === 'appearance')?.onlyOn).toEqual([]);
  });

  test('one paired daemon never shows a chip', () => {
    const flow = flattenFlow({
      journey: 'first-time',
      target: A,
      daemons: [fakeDaemon(A, 'Studio')],
      ledger: EMPTY_LEDGER,
    });
    expect(stepsOf(flow.client).every(step => step.onlyOn.length === 0)).toBe(true);
  });

  test('a step already on the device ledger is marked already-set, whichever daemon set it, and is not asked', () => {
    const ledger = withClientStep(EMPTY_LEDGER, FAKE_PLUGIN, 'look', B, AT);
    const flow = flattenFlow({
      journey: 'add-daemon',
      target: A,
      daemons: [fakeDaemon(A, 'Studio'), fakeDaemon(B, 'Laptop')],
      ledger,
    });
    const look = stepsOf(flow.client).find(step => step.id === 'look');
    expect(look?.skip).toBe('already-set');
    expect(askableSteps(flow.client).map(step => step.key)).toEqual(['onboarding.appearance']);
  });

  test('Pair: no daemon phase, and only the client steps this device has not answered are asked', () => {
    const ledger = withClientStep(EMPTY_LEDGER, 'onboarding', 'appearance', A, AT);
    const flow = flattenFlow({
      journey: 'pair',
      target: B,
      daemons: [fakeDaemon(A, 'Studio'), fakeDaemon(B, 'Laptop')],
      ledger,
    });
    expect(flow.daemon).toEqual([]);
    expect(askableSteps(flow.client).map(step => step.key)).toEqual([`${FAKE_PLUGIN}.look`]);
  });

  test("Set up a new daemon: only the client steps of the new daemon's plugins", () => {
    const flow = flattenFlow({
      journey: 'add-daemon',
      target: B,
      daemons: [
        { id: A, name: 'Studio', steps: [...fakeDaemon(A, 'Studio').steps, view('voice', 'voice', 3, 'client')] },
        fakeDaemon(B, 'Laptop'),
      ],
      ledger: EMPTY_LEDGER,
    });
    expect(keys(flow.client)).toEqual(['onboarding.appearance', `${FAKE_PLUGIN}.look`]);
  });

  test('first time on a fresh device asks every client step once', () => {
    const flow = flattenFlow({
      journey: 'first-time',
      target: A,
      daemons: [fakeDaemon(A, 'Studio')],
      ledger: EMPTY_LEDGER,
    });
    expect(askableSteps(flow.client)).toHaveLength(2);
    expect(firstUnanswered(flow.client)?.key).toBe('onboarding.appearance');
  });

  test('a daemon with no steps at all flattens to nothing', () => {
    const flow = flattenFlow({
      journey: 'first-time',
      target: A,
      daemons: [{ id: A, name: 'Studio', steps: [] }],
      ledger: EMPTY_LEDGER,
    });
    expect(flow).toEqual({ daemon: [], client: [] });
  });

  test('a steps without side reads as a daemon step (an old snapshot)', () => {
    const old = { plugin: 'shells', id: 'nix', title: 'nix', order: 80, state: 'pending' } as StepView;
    const flow = flattenFlow({
      journey: 'first-time',
      target: A,
      daemons: [{ id: A, name: 'Studio', steps: [old] }],
      ledger: EMPTY_LEDGER,
    });
    expect(keys(flow.daemon)).toEqual(['shells.nix']);
    expect(flow.client).toEqual([]);
  });
});
