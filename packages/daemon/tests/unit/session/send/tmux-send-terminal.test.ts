import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'bun:test';
import should from 'should';
import { holdsExactly, TmuxSendTerminal } from '../../../../src/adapters/session/send/tmux-send-terminal.ts';
import { PaneStrandedError } from '../../../../src/adapters/tmux/pane-delivery.ts';
import { SendLandingUnconfirmed } from '../../../../src/lib/session/send/index.ts';
import { parseSessionId, type TmuxController } from '../../../../src/lib/index.ts';
import { type DeliveryFrame, promptIsReady } from '../../../../src/lib/tmux/index.ts';

const ID = parseSessionId('session-1');
const FIXTURES = join(import.meta.dir, '../../../fixtures/composer');

/** A real codex-cli 0.166.0 pane at 80x24, with its cursor, as the daemon reads it. */
function capture(state: string): { readonly visible: string; readonly cursorX: number; readonly cursorY: number } {
  const [x, y] = readFileSync(join(FIXTURES, `codex-0.166.0-${state}.cursor`), 'utf8')
    .trim()
    .split('|');
  return {
    visible: readFileSync(join(FIXTURES, `codex-0.166.0-${state}.txt`), 'utf8'),
    cursorX: Number(x),
    cursorY: Number(y),
  };
}

function frameOf(state: string): DeliveryFrame {
  const pane = capture(state);
  return { alive: true, dead: false, promptReady: promptIsReady(pane.visible, pane.cursorY, pane.cursorX), ...pane };
}

/** Just the controller verbs this adapter's observe, clear and submit use, answering one pane. */
function terminalOver(state: string): { readonly terminal: TmuxSendTerminal; readonly keys: string[] } {
  const pane = capture(state);
  const keys: string[] = [];
  const tmux = {
    state: async () => ({
      alive: true,
      dead: false,
      promptReady: promptIsReady(pane.visible, pane.cursorY, pane.cursorX),
      history: '',
      ...pane,
    }),
    rows: async () => undefined,
    sendKey: async (_session: string, key: string) => void keys.push(key),
  } as unknown as TmuxController;
  const terminal = new TmuxSendTerminal(
    tmux,
    async () => 'pane',
    {} as never,
    {} as never,
    async () => undefined,
    { clearMargin: 2, submitPolls: 2, pollMs: 0 },
  );
  return { terminal, keys };
}

describe('a composer parked under Codex 0.166’s `Waiting for startup` line', () => {
  it('is observed as startupParked with no draft, even though the text is drawn in the composer', async () => {
    for (const state of ['startup-queued-message', 'startup-queued-slash']) {
      const observed = await terminalOver(state).terminal.observe(ID);

      should(observed.startupParked).be.true();
      should(observed.promptReady).be.false();
      should(observed.draft).be.undefined();
    }
  });

  it('is an ordinary draft once the park was cancelled, and not parked at an idle composer', async () => {
    const cancelled = await terminalOver('startup-queued-cancelled').terminal.observe(ID);
    const idle = await terminalOver('startup-composer').terminal.observe(ID);

    should(cancelled.startupParked).be.false();
    should(cancelled.draft).equal('say hello');
    should(idle.startupParked).be.false();
    should(idle.draft).be.undefined();
  });

  it('is never a composer holding exactly the payload, so no daemon Enter is pressed into it', async () => {
    should(holdsExactly(frameOf('startup-queued-message'), 'say hello')).be.false();
    // The same text after the park was cancelled is a draft Enter may submit.
    should(holdsExactly(frameOf('startup-queued-cancelled'), 'say hello')).be.true();
  });

  it('&B153: in strict mode, holds only the whole text, re-wrapped at most', () => {
    should(holdsExactly(frameOf('startup-queued-cancelled'), 'say hello', true)).be.true();
    should(holdsExactly(frameOf('startup-queued-cancelled'), 'say\n  hello', true)).be.true();
    should(holdsExactly(frameOf('startup-queued-cancelled'), 'say hello there', true)).be.false();
    should(holdsExactly(frameOf('startup-queued-message'), 'say hello', true)).be.false();
  });

  it('presses no Enter and no C-u at it', async () => {
    const submit = terminalOver('startup-queued-message');
    const clear = terminalOver('startup-queued-message');

    should(await submit.terminal.submitComposer(ID, 'say hello')).equal('absent');
    should(await clear.terminal.clearComposer(ID, 'say hello')).equal('stuck');
    should(submit.keys).be.empty();
    should(clear.keys).be.empty();
  });
});

describe('B188 a fill whose Enter left the text in the composer', () => {
  it('B188 PaneStrandedError becomes SendLandingUnconfirmed', async () => {
    // Typed and Enter pressed, text still in the box: typed-but-unproven, so the B144 watch can finish it.
    const terminal = new TmuxSendTerminal(
      {} as unknown as TmuxController,
      async () => 'pane',
      {
        deliver: async () => {
          throw new PaneStrandedError('Enter left the message in the composer');
        },
      } as never,
      {} as never,
      async () => undefined,
    );

    await should(terminal.deliver(ID, 'hello')).be.rejectedWith(SendLandingUnconfirmed);
  });
});
