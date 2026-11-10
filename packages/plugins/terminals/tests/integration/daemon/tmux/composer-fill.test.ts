import { describe, it } from 'bun:test';
import should from 'should';
import { ComposerUnconfirmedError, fillComposer } from '../../../../daemon/adapters/tmux/composer-fill.ts';
import type { PaneState } from '../../../../daemon/lib/tmux/contracts.ts';
import type { TmuxController } from '../../../../daemon/lib/tmux/index.ts';

const SESSION = 'fy-session-1';
const SETTINGS = { composerAttempts: 2, pollMs: 10, windowMs: 300, stalledWindowMs: 300, settleMs: 0 };

/**
 * A pane whose frames the test writes: `frames(read, typings)` answers the `read`-th capture taken since
 * the last key was typed. Only what the fill asks of a controller is modelled; it has no composer of its
 * own, so what each frame proves is exactly what the test drew.
 */
class ScriptedPane {
  readonly typed: string[] = [];
  readonly pasted: string[] = [];
  /** Captures taken since the latest typing, per typing; index 0 is before the first key. */
  readonly captures: number[] = [0];

  constructor(private readonly frames: (read: number, typings: number) => string) {}

  get controller(): TmuxController {
    return this as unknown as TmuxController;
  }

  async state(): Promise<PaneState> {
    const typings = this.captures.length - 1;
    const read = this.captures[typings] as number;
    this.captures[typings] = read + 1;
    return { alive: true, dead: false, promptReady: true, history: '', visible: this.frames(read, typings) };
  }

  async rows(): Promise<string | undefined> {
    return undefined;
  }

  async sendLiteral(_session: string, text: string): Promise<void> {
    this.typed.push(text);
    this.captures.push(0);
  }

  async paste(_session: string, text: string): Promise<void> {
    this.pasted.push(text);
    this.captures.push(0);
  }
}

const noSleep = async (): Promise<void> => undefined;

describe('fillComposer', () => {
  it('should submit a paste whose placeholder is on screen though the repaint moved no counter', async () => {
    // Arrange — the frame before the paste already shows `#1`, and the repaint after it shows the new
    // placeholder under the very same counter, with no cursor to read the composer by: neither frame
    // proves anything new, yet one placeholder is sitting in the composer.
    const text = 'first line\nsecond line';
    const pane = new ScriptedPane((_read, typings) =>
      typings === 0 ? 'earlier turn [Pasted text #1 +2 lines]\n> ' : '> [Pasted text #1 +2 lines]',
    );

    // Act
    const evidence = await fillComposer(pane.controller, noSleep, SETTINGS, SESSION, text);

    // Assert — taken as landed, and typed once rather than pasted again over it.
    should(evidence).equal('placeholder');
    should(pane.pasted).deepEqual([text]);
    should(pane.typed).deepEqual([]);
  });

  it('should take the payload newly on screen as landed when the composer line has no cursor to read it by', async () => {
    // Arrange — the frame before is an empty prompt; the frame after shows the payload on the prompt line, but with
    // no cursor to say whether that is typed input, so the composer reads "unreadable" and only the count proves it.
    const pane = new ScriptedPane((_read, typings) => (typings === 0 ? 'last frame\n> ' : 'last frame\n> continue'));

    // Act
    const evidence = await fillComposer(pane.controller, noSleep, SETTINGS, SESSION, 'continue');

    // Assert
    should(evidence).equal('chars');
    should(pane.typed).deepEqual(['continue']);
    should(pane.pasted).deepEqual([]);
  });

  it('should say a pane that drew but never showed the payload in its composer was typed once and not retyped', async () => {
    // Arrange — after the keys the pane repaints with no composer line at all: it drew, so this is not "stalled", and
    // nothing in the frame proves the payload landed or that the keys were dropped.
    const pane = new ScriptedPane((_read, typings) => (typings === 0 ? 'last frame\n> ' : 'last frame\n⎿ thinking'));

    // Act
    const refused = await fillComposer(pane.controller, noSleep, SETTINGS, SESSION, 'continue').catch(
      (error: unknown) => error,
    );

    // Assert
    should(refused).be.instanceOf(ComposerUnconfirmedError);
    should((refused as ComposerUnconfirmedError).typings).equal(1);
    should((refused as ComposerUnconfirmedError).message).match(
      /and in [\d.]+ s its composer never showed it; it was not typed again/u,
    );
    should(pane.typed).deepEqual(['continue']);
  });

  it('should refuse, typing nothing more, when a dropped fill finds the composer holding text', async () => {
    // Arrange — measure a pane that drew after the first fill and dropped it every time: the captures
    // taken between the two typings are the watch plus the one read that precedes the second fill.
    const drawn = (_read: number, typings: number): string =>
      typings === 0 ? 'last frame\n> ' : `last frame\n⎿ tick ${typings}\n> `;
    const measuring = new ScriptedPane(drawn);
    await should(fillComposer(measuring.controller, noSleep, SETTINGS, SESSION, 'continue')).be.rejectedWith(
      /2 times and the pane dropped it every time/u,
    );
    const capturesBeforeSecondFill = measuring.captures[1] as number;
    // The same pane, except that a person's draft is on every capture from the one that follows the watch.
    const pane = new ScriptedPane((read, typings) =>
      typings === 1 && read >= capturesBeforeSecondFill - 1
        ? 'last frame\n⎿ tick 1\n> half-written question'
        : drawn(read, typings),
    );

    // Act
    const refused = await fillComposer(pane.controller, noSleep, SETTINGS, SESSION, 'continue').catch(
      (error: unknown) => error,
    );

    // Assert
    should(refused).be.instanceOf(ComposerUnconfirmedError);
    should((refused as ComposerUnconfirmedError).typings).equal(1);
    should((refused as ComposerUnconfirmedError).message).match(/and dropped, and its composer now holds text/u);
    should(pane.typed).deepEqual(['continue']);
  });
});
