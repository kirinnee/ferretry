import { describe, it } from 'bun:test';
import should from 'should';
import type { RedactionScope } from '@ferretry/kernel/contract';
import {
  RedactingTerminalStreamService,
  type StreamAct,
} from '../../../../daemon/adapters/terminal/redacted-stream.ts';
import {
  TerminalStreamBridge,
  type TerminalStreamScheduler,
  type TerminalStreamService,
  type TerminalStreamTimer,
} from '../../../../daemon/adapters/terminal/stream-bridge.ts';
import type { TerminalCapture } from '../../../../daemon/lib/terminal/redraw.ts';

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

/** No vault value to mask: what these cases test is the hold, not the masking. */
const PLAIN: RedactionScope = { text: s => s, cells: grid => grid, lines: lines => lines };

/**
 * The act runner and the hold generation as the composition binds them (`daemon/index.ts`): a held terminal refuses
 * the `stream` act, and `vault.holds-changed` moves the generation (`begin` stands for that event).
 */
const holdsOf = (state: { held: boolean; generation: number }) => {
  const act: StreamAct = async (_s, _t, read, capture) => {
    if (state.held) return { held: true };
    await capture();
    return { shown: read(PLAIN) };
  };
  return {
    act,
    generation: () => state.generation,
    begin: (): void => {
      state.held = true;
      state.generation += 1;
    },
  };
};

/** A terminal whose hold begins in the gap between the redacting wrapper's last check and the bridge's send. */
const harness = () => {
  const state = { screen: SAFE, held: false, generation: 0, holdAfterRead: false };
  const holds = holdsOf(state);
  const inner: TerminalStreamService = {
    write: async () => undefined,
    resize: async () => undefined,
    capture: async () => state.screen,
  };
  const wrapper = new RedactingTerminalStreamService(inner, holds.act, holds.generation);
  const gapped: TerminalStreamService = {
    write: (s, t, b) => wrapper.write(s, t, b),
    resize: (s, t, c, r) => wrapper.resize(s, t, c, r),
    capture: async (s, t, h) => {
      const seen = await wrapper.capture(s, t, h);
      if (state.holdAfterRead) holds.begin();
      return seen;
    },
    publishable: (s, t, c) => wrapper.publishable(s, t, c),
  };
  const scheduler = new Scheduler();
  const sent: string[] = [];
  const permits: Array<(() => boolean) | undefined> = [];
  const bridge = new TerminalStreamBridge(
    gapped,
    's',
    't',
    {
      send: (bytes, permit) => {
        permits.push(permit);
        return sent.push(new TextDecoder().decode(bytes));
      },
      close: () => undefined,
    },
    scheduler,
  );
  return { state, holds, scheduler, sent, permits, bridge, gapped };
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
    // The viewer's size matches the pane's, so the next frame is a delta rather than a complete redraw.
    h.bridge.fromClient(JSON.stringify({ type: 'resize', cols: 100, rows: 5 }));
    await turn();
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

  // R9-1, §7.3: the relay seals a queued record only if its permit still says yes.
  it('a hold beginning mid-relay-queue drops the record (a full frame)', async () => {
    const h = harness();

    await h.bridge.open();
    const permit = h.permits[0];

    should(permit?.()).equal(true);
    h.holds.begin();
    should(permit?.()).equal(false);
  });

  // R9-1, §7.3
  it('a hold beginning mid-relay-queue drops the record (a delta frame)', async () => {
    const h = harness();
    h.bridge.fromClient(JSON.stringify({ type: 'resize', cols: 100, rows: 5 }));
    await turn();
    await h.bridge.open();
    h.state.screen = pane(['$ ls -l', '', '', '', '']);

    h.scheduler.callback?.();
    await turn();
    const permit = h.permits[1];

    should(h.sent).have.length(2);
    should(permit?.()).equal(true);
    h.holds.begin();
    should(permit?.()).equal(false);
  });

  it('should keep a notice permitted while the hold lasts', async () => {
    const h = harness();
    h.holds.begin();

    await h.bridge.open();

    should(h.permits[0]?.()).equal(true);
  });

  it('should leave a capture alone when no hold applies, and a notice already drawn as it is', async () => {
    const h = harness();
    const wrapper = new RedactingTerminalStreamService(
      { write: async () => undefined, resize: async () => undefined, capture: async () => SAFE },
      h.holds.act,
      h.holds.generation,
    );
    const shown = await wrapper.capture('s', 't', 10);

    should(wrapper.publishable('s', 't', shown)).equal(shown);
    h.holds.begin();
    const notice = wrapper.publishable('s', 't', shown);
    should(notice).not.equal(SAFE);
    should(wrapper.publishable('s', 't', notice)).equal(notice);
  });
});
