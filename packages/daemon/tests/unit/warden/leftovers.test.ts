import { describe, it } from 'bun:test';
import should from 'should';
import { leftoverBrowserCandidates, type WardenSessionView } from '../../../src/lib/warden/index.ts';

const NOW = Date.parse('2026-10-28T00:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

type ViewOverrides = Omit<Partial<WardenSessionView>, 'state'> & {
  readonly state?: Partial<WardenSessionView['state']>;
};

const view = (overrides: ViewOverrides = {}) =>
  ({
    config: { id: 's1', mode: 'auto', ...overrides.config },
    hasLiveMonitor: true,
    leftoverBrowserSince: ago(30),
    ...overrides,
    state: { status: 'running', turnState: 'your-turn', ...overrides.state },
  }) as WardenSessionView;

const candidates = (sessions: readonly WardenSessionView[]) =>
  leftoverBrowserCandidates(sessions, NOW, { tickSeconds: 30 }).map(candidate => candidate.sessionId);

describe('leftover browsers closed by rule', () => {
  it('should close the browser of a finished ferret with nothing else of its own running', () => {
    // Act / Assert
    should(leftoverBrowserCandidates([view()], NOW, { tickSeconds: 30 })).deepEqual([
      { sessionId: 's1', since: ago(30) },
    ]);
  });

  it('should also close it once the done marker is written', () => {
    // Act / Assert
    should(candidates([view({ hasDoneMarker: true, state: { turnState: undefined } })])).deepEqual(['s1']);
  });

  it.each([
    ['the turn is still working', view({ state: { turnState: 'working' } })],
    ['it is parked on a question', view({ state: { turnState: 'needs-input' } })],
    ['a tool command still runs', view({ state: { lastSubprocessAt: ago(0.5) } })],
    ['the browser is younger than the grace', view({ leftoverBrowserSince: ago(5) })],
    ['there is no browser', view({ leftoverBrowserSince: undefined })],
    ['it is a person’s own terminal', view({ config: { id: 's1', mode: 'interactive' } })],
    ['it is a warden', view({ config: { id: 's1', mode: 'auto', label: 'fleet-warden' } })],
    ['it has finished for good', view({ state: { status: 'completed' } })],
  ] as const)('should leave it alone when %s', (_name, session) => {
    // Act / Assert
    should(candidates([session])).deepEqual([]);
  });
});
