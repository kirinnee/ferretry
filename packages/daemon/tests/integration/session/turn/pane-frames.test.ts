/**
 * A RUNNING PANE'S FRAMES, captured only when they may have changed.
 *
 * Since stage 3d the main thread no longer looks at running panes on a tick, so this class — shared by the
 * main thread's turn ports and every session worker — is held here on its own, over a scripted reader.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { PaneFrames, type TurnPaneReader } from '../../../../src/adapters/session/turn/pane-frames.ts';
import type { PaneActivity } from '../../../../src/lib/tmux/contracts.ts';

const NOW = '2026-10-22T08:00:00.000Z';
const NOW_SECOND = Math.floor(Date.parse(NOW) / 1_000);

/** One pane, scripted: what its activity question answers and what a capture returns, counted. */
class ScriptedPane implements TurnPaneReader {
  activityAnswer: PaneActivity | undefined | Error = {
    dead: false,
    activityAt: NOW_SECOND - 5,
    historySize: 10,
    cursorX: 2,
    cursorY: 3,
    height: 40,
    width: 100,
  };
  screen: string | undefined = '│ > ';
  captures = 0;

  async activity(): Promise<PaneActivity | undefined> {
    if (this.activityAnswer instanceof Error) throw this.activityAnswer;
    return this.activityAnswer;
  }

  async visible(): Promise<string | undefined> {
    this.captures += 1;
    return this.screen;
  }
}

const frames = (pane: ScriptedPane) => new PaneFrames(pane, { now: () => NOW });

describe('PaneFrames', () => {
  it('should capture a pane once, and hand back the held frame while nothing drew', async () => {
    // Arrange
    const pane = new ScriptedPane();
    const subject = frames(pane);

    // Act
    const first = await subject.state('fy-a');
    const second = await subject.state('fy-a');

    // Assert
    should(pane.captures).equal(1);
    should(first?.visible).equal('│ > ');
    should(second?.visible).equal('│ > ');
  });

  it('should capture again once the pane drew', async () => {
    // Arrange
    const pane = new ScriptedPane();
    const subject = frames(pane);
    await subject.state('fy-a');

    // Act
    pane.activityAnswer = { ...(pane.activityAnswer as PaneActivity), historySize: 11 };
    pane.screen = 'drawn';
    const drawn = await subject.state('fy-a');

    // Assert
    should(pane.captures).equal(2);
    should(drawn?.visible).equal('drawn');
  });

  it('should read a dead, missing or unanswering pane as none, and forget its frame', async () => {
    // Arrange
    const pane = new ScriptedPane();
    const subject = frames(pane);
    await subject.state('fy-a');
    const live = pane.activityAnswer as PaneActivity;

    // Act
    pane.activityAnswer = { ...live, dead: true };
    const dead = await subject.state('fy-a');
    pane.activityAnswer = undefined;
    const missing = await subject.state('fy-a');
    pane.activityAnswer = new Error('tmux went away');
    const unanswering = await subject.evidence('fy-a');
    pane.activityAnswer = live;
    await subject.state('fy-a');

    // Assert — the frame was forgotten, so the pane coming back is captured again.
    should([dead, missing, unanswering]).deepEqual([undefined, undefined, undefined]);
    should(pane.captures).equal(2);
  });

  it('should read a failed capture as a blank screen and never hold it', async () => {
    // Arrange
    const pane = new ScriptedPane();
    pane.screen = undefined;
    const subject = frames(pane);

    // Act
    const blank = await subject.state('fy-a');
    pane.screen = '│ > ';
    const captured = await subject.state('fy-a');

    // Assert
    should(blank?.visible).equal('');
    should(captured?.visible).equal('│ > ');
    should(pane.captures).equal(2);
  });

  it('should give the turn evidence of a live pane, and capture again after a pane is forgotten', async () => {
    // Arrange
    const pane = new ScriptedPane();
    const subject = frames(pane);

    // Act
    const evidence = await subject.evidence('fy-a');
    subject.forget('fy-a');
    await subject.state('fy-a');

    // Assert
    should(evidence).not.be.undefined();
    should(pane.captures).equal(2);
  });
});
