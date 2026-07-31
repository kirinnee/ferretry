import { describe, it } from 'bun:test';
import should from 'should';
import { buildStopPlan } from '../../../src/lib/stop/plan';
import {
  confirmationPhrase,
  defaultStopReason,
  renderStopPlan,
  renderStopSweep,
  selectorDescription,
  targetDisplay,
} from '../../../src/lib/stop/render';
import type { StopSweepResult, StopTarget } from '../../../src/lib/stop/types';
import { session } from './fixtures';

const FLEET = [
  session({ id: 'lead' }),
  session({ id: 'mid', parent: 'lead' }),
  session({ id: 'worker-a', parent: 'mid', teammate: 'ana' }),
  session({ id: 'worker-b', parent: 'mid' }),
];

const target = (overrides: Partial<StopTarget> = {}): StopTarget => ({
  id: 'worker-a',
  name: 'Fix Thing',
  status: 'running',
  depth: 2,
  caller: false,
  callerAncestor: false,
  ...overrides,
});

describe('selector descriptions', () => {
  it('should describe every selector kind with its blast radius', () => {
    // Act + Assert
    should(selectorDescription({ kind: 'orphan', rootId: 'a' })).containEql('descendants keep running');
    should(selectorDescription({ kind: 'cascade', rootId: 'a' })).containEql('all transitive descendants');
    should(selectorDescription({ kind: 'children', rootId: 'a' })).containEql('keep this session running');
    should(selectorDescription({ kind: 'label', label: 'b' })).containEql('LABEL "b"');
  });
});

describe('target display', () => {
  it('should lead with the teammate when one is set', () => {
    // Act + Assert
    should(targetDisplay(target({ teammate: 'ana' }))).equal('ana — Fix Thing (worker-a)');
    should(targetDisplay(target())).equal('Fix Thing (worker-a)');
  });

  it('should annotate the caller and its ancestors', () => {
    // Act
    const actual = targetDisplay(target({ caller: true, callerAncestor: true }));

    // Assert
    should(actual).equal('Fix Thing (worker-a)  [CALLER; CALLER ANCESTOR / POSSIBLE LEAD]');
  });
});

describe('plan rendering', () => {
  it('should list the targets in stop order', () => {
    // Act
    const actual = renderStopPlan(buildStopPlan(FLEET, { kind: 'cascade', rootId: 'mid' }));

    // Assert
    should(actual).containEql('Will stop 3 sessions:');
    should(actual).containEql('  - mid (mid)');
    should(actual).not.containEql('Excluded for caller safety');
  });

  it('should say "(none)" rather than print an empty list', () => {
    // Act
    const actual = renderStopPlan(buildStopPlan(FLEET, { kind: 'cascade', rootId: 'ghost' }));

    // Assert
    should(actual).containEql('Will stop 0 sessions:');
    should(actual).containEql('  (none)');
  });

  it('should use the singular noun for a single session', () => {
    // Act
    const actual = renderStopPlan(buildStopPlan(FLEET, { kind: 'orphan', rootId: 'worker-a' }));

    // Assert
    should(actual).containEql('Will stop 1 session:');
    should(actual).containEql('No live descendants will be orphaned.');
  });

  it('should spell out which descendants an orphan stop abandons', () => {
    // Act
    const actual = renderStopPlan(buildStopPlan(FLEET, { kind: 'orphan', rootId: 'mid' }));

    // Assert
    should(actual).containEql('Will leave 2 live descendants running without this parent:');
    should(actual).containEql('  - ana — worker-a (worker-a)');
  });

  it('should use the singular descendant noun for exactly one orphan', () => {
    // Arrange
    const pair = [session({ id: 'root' }), session({ id: 'only', parent: 'root' })];

    // Act
    const actual = renderStopPlan(buildStopPlan(pair, { kind: 'orphan', rootId: 'root' }));

    // Assert
    should(actual).containEql('Will leave 1 live descendant running without this parent:');
  });

  it('should report the caller exclusion and how to override it', () => {
    // Act
    const actual = renderStopPlan(buildStopPlan(FLEET, { kind: 'cascade', rootId: 'mid' }, { callerId: 'worker-a' }));

    // Assert
    should(actual).containEql('Excluded for caller safety (1; will NOT be stopped):');
    should(actual).containEql('--include-caller');
  });

  it('should warn when a lead is selected and when the caller itself is selected', () => {
    // Act
    const actual = renderStopPlan(
      buildStopPlan(FLEET, { kind: 'cascade', rootId: 'lead' }, { callerId: 'mid', includeCaller: true }),
    );

    // Assert
    should(actual).containEql("WARNING: 1 selected session is in the caller's ancestor/lead chain.");
    should(actual).containEql('WARNING: the issuing session is selected');
  });

  it('should pluralise the lead warning', () => {
    // Act
    const actual = renderStopPlan(
      buildStopPlan(FLEET, { kind: 'cascade', rootId: 'lead' }, { callerId: 'worker-a', includeCaller: true }),
    );

    // Assert
    should(actual).containEql("WARNING: 2 selected sessions are in the caller's ancestor/lead chain.");
  });
});

describe('confirmation phrase', () => {
  it('should name the size of the sweep', () => {
    // Act
    const actual = confirmationPhrase(buildStopPlan(FLEET, { kind: 'cascade', rootId: 'mid' }));

    // Assert
    should(actual).equal('stop 3');
  });

  it('should name the orphan fallout so a large abandonment cannot be typed past', () => {
    // Act
    const actual = confirmationPhrase(buildStopPlan(FLEET, { kind: 'orphan', rootId: 'mid' }));

    // Assert
    should(actual).equal('stop 1 leaving 2');
  });

  it('should name the caller and lead inclusions', () => {
    // Act
    const actual = confirmationPhrase(
      buildStopPlan(FLEET, { kind: 'cascade', rootId: 'lead' }, { callerId: 'mid', includeCaller: true }),
    );

    // Assert
    should(actual).equal('stop 4 including caller and lead');
  });
});

describe('default stop reason', () => {
  it('should record the command that ended the session under the shipped binary name', () => {
    // Act + Assert
    should(defaultStopReason({ kind: 'cascade', rootId: 'abc' }, 'fy')).equal('stopped by fy stop cascade abc');
    should(defaultStopReason({ kind: 'label', label: 'batch' }, 'fy')).equal('stopped by fy stop label batch');
  });
});

const sweep = (overrides: Partial<StopSweepResult> = {}): StopSweepResult => ({
  kind: 'cascade',
  outcomes: [],
  appeared: [],
  leftRunning: [],
  appearedLeftRunning: [],
  ...overrides,
});

describe('sweep rendering', () => {
  it('should mark each outcome OK or FAILED with its detail', () => {
    // Act
    const actual = renderStopSweep(
      sweep({
        outcomes: [
          { target: target(), ok: true, status: 'stopped' },
          { target: target({ id: 'worker-b', name: 'Other' }), ok: false, error: 'boom' },
        ],
      }),
    );

    // Assert
    should(actual).containEql('Stop outcomes (2):');
    should(actual).containEql('  OK     Fix Thing (worker-a) — stopped');
    should(actual).containEql('  FAILED Other (worker-b) — boom');
  });

  it('should fall back to generic wording when the daemon reported no status or error', () => {
    // Act
    const actual = renderStopSweep(
      sweep({
        outcomes: [
          { target: target(), ok: true },
          { target: target({ id: 'b' }), ok: false },
        ],
      }),
    );

    // Assert
    should(actual).containEql('— stopped');
    should(actual).containEql('— unknown error');
  });

  it('should say when no stop calls were made at all', () => {
    // Act
    const actual = renderStopSweep(sweep());

    // Assert
    should(actual).containEql('  (no stop calls made)');
  });

  it('should surface a failed race check instead of claiming the fleet is clean', () => {
    // Act
    const actual = renderStopSweep(sweep({ raceCheckError: 'connection refused' }));

    // Assert
    should(actual).containEql('RACE CHECK FAILED: connection refused');
    should(actual).not.containEql('no new matching sessions appeared');
  });

  it('should report new matches that appeared after confirmation without stopping them', () => {
    // Act
    const actual = renderStopSweep(sweep({ appeared: [target({ id: 'late', name: 'Late' })] }));

    // Assert
    should(actual).containEql('1 matching session appeared after confirmation and was NOT stopped:');
    should(actual).containEql('  - Late (late)');
    should(actual).containEql('Re-run the same command');
  });

  it('should pluralise the appeared report', () => {
    // Act
    const actual = renderStopSweep(sweep({ appeared: [target({ id: 'a' }), target({ id: 'b' })] }));

    // Assert
    should(actual).containEql('2 matching sessions appeared after confirmation and were NOT stopped:');
  });

  it('should confirm a clean race check when nothing new appeared', () => {
    // Act
    const actual = renderStopSweep(sweep({ outcomes: [{ target: target(), ok: true, status: 'stopped' }] }));

    // Assert
    should(actual).containEql('Race check: no new matching sessions appeared during the sweep.');
  });

  it('should list the descendants an orphan stop left running', () => {
    // Act
    const actual = renderStopSweep(sweep({ kind: 'orphan', leftRunning: [target({ id: 'kid', name: 'Kid' })] }));

    // Assert
    should(actual).containEql('Left running after the orphan stop (1 live descendant):');
    should(actual).containEql('  - Kid (kid)');
    should(actual).containEql('Race check: no new live descendants appeared after confirmation.');
  });

  it('should say "(none)" when an orphan stop left nothing running', () => {
    // Act
    const actual = renderStopSweep(sweep({ kind: 'orphan' }));

    // Assert
    should(actual).containEql('Left running after the orphan stop (0 live descendants):');
    should(actual).containEql('  (none)');
  });

  it('should call out descendants that appeared after confirmation and were deliberately spared', () => {
    // Act
    const actual = renderStopSweep(
      sweep({
        kind: 'orphan',
        leftRunning: [target({ id: 'kid' }), target({ id: 'late' })],
        appearedLeftRunning: [target({ id: 'late', name: 'Late' })],
      }),
    );

    // Assert
    should(actual).containEql('1 live descendant appeared after confirmation and was intentionally NOT stopped:');
    should(actual).containEql('  - Late (late)');
  });

  it('should pluralise the spared-descendant report', () => {
    // Act
    const actual = renderStopSweep(
      sweep({ kind: 'orphan', appearedLeftRunning: [target({ id: 'a' }), target({ id: 'b' })] }),
    );

    // Assert
    should(actual).containEql('2 live descendants appeared after confirmation and were intentionally NOT stopped:');
  });
});
