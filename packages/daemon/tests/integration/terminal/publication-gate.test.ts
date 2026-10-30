import { describe, it } from 'bun:test';
import should from 'should';
import {
  RedactingTerminalStreamService,
  TerminalStreamBridge,
  type TerminalStreamScheduler,
  type TerminalStreamService,
  type TerminalStreamTimer,
} from '../../../src/adapters/index.ts';
import { NO_REDACTION, type TerminalCapture } from '../../../src/lib/index.ts';

const turn = async (): Promise<void> => await new Promise<void>(resolve => setImmediate(resolve));

const pane = (lines: readonly string[]): TerminalCapture => ({
  lines,
  cols: 100,
  rows: lines.length,
  cursorX: 0,
  cursorY: 0,
  historySize: 0,
});
const SAFE = pane(['$ ls', '', '', '', '']);
const SECRET = pane(['Password: hunter2', '', '', '', '']);

class Scheduler implements TerminalStreamScheduler {
  callback?: () => void;
  schedule(callback: () => void): TerminalStreamTimer {
    this.callback = callback;
    return { cancel: () => undefined };
  }
}

/** A terminal whose hold begins in the gap between the redacting wrapper's last check and the bridge's send. */
const harness = () => {
  const state = { screen: SAFE, heldUntil: undefined as number | undefined, holdAfterRead: false };
  const inner: TerminalStreamService = {
    write: async () => undefined,
    resize: async () => undefined,
    capture: async () => state.screen,
  };
  const wrapper = new RedactingTerminalStreamService(
    inner,
    NO_REDACTION,
    () => state.heldUntil,
    () => 0,
  );
  const gapped: TerminalStreamService = {
    write: (s, t, b) => wrapper.write(s, t, b),
    resize: (s, t, c, r) => wrapper.resize(s, t, c, r),
    capture: async (s, t, h) => {
      const seen = await wrapper.capture(s, t, h);
      if (state.holdAfterRead) state.heldUntil = 30_000;
      return seen;
    },
    publishable: (s, t, c) => wrapper.publishable(s, t, c),
  };
  const scheduler = new Scheduler();
  const sent: string[] = [];
  const bridge = new TerminalStreamBridge(
    gapped,
    's',
    't',
    { send: bytes => sent.push(new TextDecoder().decode(bytes)), close: () => undefined },
    scheduler,
  );
  return { state, scheduler, sent, bridge, gapped };
};

describe('the one publication gate, at the real bridge', () => {
  it('should not send a complete redraw read before a hold began (full)', async () => {
    const h = harness();
    h.state.screen = SECRET;
    h.state.holdAfterRead = true;

    await h.bridge.open();

    should(h.sent.join('')).not.containEql('hunter2');
    should(h.sent.join('')).containEql('Kept from view');
  });

  it('should not send a delta read before a hold began (delta)', async () => {
    const h = harness();
    await h.bridge.open();
    h.state.screen = SECRET;
    h.state.holdAfterRead = true;

    h.scheduler.callback?.();
    await turn();

    should(h.sent.length).equal(2);
    should(h.sent.join('')).not.containEql('hunter2');
    should(h.sent[1]).containEql('Kept from view');
  });

  it('should not send a re-attach read before a hold began (reattach)', async () => {
    const h = harness();
    await h.bridge.open();
    h.state.screen = SECRET;
    h.state.holdAfterRead = true;
    const sent: string[] = [];
    const again = new TerminalStreamBridge(
      h.gapped,
      's',
      't',
      { send: bytes => sent.push(new TextDecoder().decode(bytes)), close: () => undefined },
      new Scheduler(),
    );

    await again.open();

    should(sent.join('')).not.containEql('hunter2');
    should(sent.join('')).containEql('Kept from view');
  });

  it('should not send the second capture of a complete redraw read before a hold began', async () => {
    const h = harness();
    await h.bridge.open();
    h.state.screen = SECRET;
    h.state.holdAfterRead = true;
    h.bridge.fromClient(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    await turn();
    h.scheduler.callback?.();
    await turn();

    should(h.sent.join('')).not.containEql('hunter2');
  });

  it('should leave a capture alone when no hold applies, and a notice already drawn as it is', async () => {
    const h = harness();
    const wrapper = new RedactingTerminalStreamService(
      { write: async () => undefined, resize: async () => undefined, capture: async () => SAFE },
      NO_REDACTION,
      () => h.state.heldUntil,
      () => 0,
    );

    should(wrapper.publishable('s', 't', SAFE)).equal(SAFE);
    h.state.heldUntil = 30_000;
    const notice = wrapper.publishable('s', 't', SAFE);
    should(notice).not.equal(SAFE);
    should(wrapper.publishable('s', 't', notice)).equal(notice);
  });
});
