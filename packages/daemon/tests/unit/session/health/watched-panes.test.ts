import { describe, it } from 'bun:test';
import should from 'should';
import type { ExitedSessionTransition, SessionExitObservation } from '../../../../src/lib/session/health/exit.ts';
import type { SessionExitPort } from '../../../../src/lib/session/health/service.ts';
import type { ExitObserveOptions, SurveyedSession } from '../../../../src/lib/session/health/types.ts';
import { UnwatchedPaneExits, WatchedPanes } from '../../../../src/lib/session/health/watched-panes.ts';
import { parseSessionId } from '../../../../src/lib/session-id.ts';

const OBSERVATION: SessionExitObservation = {
  id: 'b',
  status: 'running',
  registration: {
    daemonId: 'daemon',
    sessionId: 'b',
    tmuxSession: 'fy-b',
    paneId: '%1',
    pid: 4242,
    processStartTicks: 99,
  },
  exit: { kind: 'gone' },
};

const TRANSITION: ExitedSessionTransition = {
  status: 'failed',
  health: 'unknown',
  reason: 'the pane is gone',
};

class RecordingExits implements SessionExitPort {
  readonly observed: { readonly ids: readonly string[]; readonly options?: ExitObserveOptions | undefined }[] = [];
  readonly settled: SessionExitObservation[] = [];

  async observe(survey: readonly SurveyedSession[], options?: ExitObserveOptions) {
    this.observed.push({ ids: survey.map(session => session.id), options });
    return [OBSERVATION];
  }

  async settle(observation: SessionExitObservation): Promise<boolean> {
    this.settled.push(observation);
    return true;
  }
}

const survey = (...ids: string[]): SurveyedSession[] => ids.map(id => ({ id: parseSessionId(id), journalLost: false }));

describe('watched panes', () => {
  it('should watch nothing until hosting is bound', () => {
    // Arrange
    const panes = new WatchedPanes();

    // Act
    const actual = panes.watched('a');

    // Assert
    should(actual).be.false();
  });

  it('should watch a hosted session until its worker says it exited', () => {
    // Arrange
    const panes = new WatchedPanes();
    panes.hostedBy(id => id === 'a');

    // Act
    const before = [panes.watched('a'), panes.watched('b')];
    panes.exited('a');
    const after = panes.watched('a');

    // Assert
    should(before).deepEqual([true, false]);
    should(after).be.false();
  });

  it('should watch a session again once it was unhosted after its exit', () => {
    // Arrange
    let hosted = true;
    const panes = new WatchedPanes();
    panes.hostedBy(() => hosted);
    panes.exited('a');

    // Act
    hosted = false;
    const unhosted = panes.watched('a');
    hosted = true;
    const rehosted = panes.watched('a');

    // Assert
    should(unhosted).be.false();
    should(rehosted).be.true();
  });
});

describe('unwatched pane exits', () => {
  it('should ask about only the sessions no worker watches, with the options it was given', async () => {
    // Arrange
    const exits = new RecordingExits();
    const panes = new WatchedPanes();
    panes.hostedBy(id => id === 'a');
    const subject = new UnwatchedPaneExits(exits, panes);

    // Act
    const observed = await subject.observe(survey('a', 'b'), { partial: true });

    // Assert
    should(exits.observed).deepEqual([{ ids: ['b'], options: { partial: true } }]);
    should(observed).deepEqual([OBSERVATION]);
  });

  it('should settle through the exits it wraps', async () => {
    // Arrange
    const exits = new RecordingExits();
    const subject = new UnwatchedPaneExits(exits, new WatchedPanes());

    // Act
    const settled = await subject.settle(OBSERVATION, TRANSITION);

    // Assert
    should(settled).be.true();
    should(exits.settled).deepEqual([OBSERVATION]);
  });
});
