import { describe, it } from 'bun:test';
import type { BrowserScreencastFrame } from '../../../contract/wire/browser.ts';
import type { FrameClock, FrameTimer } from '../../../daemon/stream/contracts.ts';
import { allOf, scopeDelivery } from '../../../daemon/stream/delivery.ts';
import { heldViewerHost } from '../../../daemon/stream/held-host.ts';
import {
  type BrowserViewerHost,
  type ViewerDownstream,
  type ViewerTerminalSignal,
} from '../../../daemon/stream/viewer-contracts.ts';
import { VIEWER_RECHECK_MS, VIEWER_SCOPE_REFUSAL, ViewerScope } from '../../../daemon/stream/viewer-scope.ts';
import { BrowserViewerStream } from '../../../daemon/stream/viewer-stream.ts';
import should from 'should';

/**
 * The agent viewer's delivery path: a frame is stamped where it ARRIVES and the permission is asked again, synchronously,
 * where it leaves — after a pending act, while it waits in a congested socket, and on the transport's own send permit — so a
 * takeover with no new frame arriving still ends it. Fake values only.
 */
const shot: BrowserScreencastFrame = { dataBase64: btoa('AAAA'), width: 1, height: 1, pageId: 'p1' };

/** A scope whose rule answers what the test says, and whose timers the test runs. */
function scoped(initial = true) {
  const rule = { allowed: initial };
  const timers: (() => void)[] = [];
  const scope = new ViewerScope({
    may: async () => rule.allowed,
    after: (_ms, action) => {
      timers.push(action);
      return () => undefined;
    },
  });
  return { scope, rule, timers };
}

describe('revocation while kernel.act is pending', () => {
  function world() {
    const { scope } = scoped();
    let deliver: ((frame: BrowserScreencastFrame) => void) | undefined;
    const host = {
      attachViewer: async (_session: string, onFrame: (frame: BrowserScreencastFrame) => void) => {
        deliver = onFrame;
        return { detach: () => undefined };
      },
    };
    const release: (() => void)[] = [];
    const kernel = {
      act: async () => {
        await new Promise<void>(resolve => release.push(resolve));
        return { ok: true as const, value: { kind: 'content' as const } };
      },
    };
    const viewer = heldViewerHost(kernel as never, host as never, {
      mayType: false,
      delivery: allOf([scopeDelivery(scope, 'f1')]),
    });
    const frames: unknown[] = [];
    const ended: ViewerTerminalSignal[] = [];
    return {
      scope,
      frames,
      ended,
      release,
      attach: async () => {
        await viewer.attachViewer(
          'f1',
          each => frames.push(each),
          signal => ended.push(signal),
        );
      },
      send: () => deliver?.(shot),
    };
  }

  it('should NOT deliver a frame whose act was awaiting when a person took the page over, and end the stream', async () => {
    // Arrange
    const w = world();
    await w.attach();
    w.send();
    await new Promise(resolve => setTimeout(resolve, 5));
    should(w.release).have.length(1);

    // Act: the act is pending; the takeover lands now
    w.scope.revoke('f1', 'p1');
    for (const resolve of w.release) resolve();
    await new Promise(resolve => setTimeout(resolve, 5));

    // Assert
    should(w.frames).eql([]);
    should(w.ended).have.length(1);
    should(w.ended[0]).match({ code: 1008, reason: VIEWER_SCOPE_REFUSAL });
  });

  it('should NOT deliver a frame when the takeover lands while the rule itself is still being asked', async () => {
    // Arrange
    const w = world();
    await w.attach();

    // Act: arrives and is revoked in the same tick, before anything is awaited
    w.send();
    w.scope.revoke('f1', 'p1');
    await new Promise(resolve => setTimeout(resolve, 5));
    for (const resolve of w.release) resolve();
    await new Promise(resolve => setTimeout(resolve, 5));

    // Assert
    should(w.frames).eql([]);
    should(w.ended[0]?.code).equal(1008);
  });

  it('should deliver the frame when nothing was withdrawn', async () => {
    // Arrange
    const w = world();
    await w.attach();
    w.send();
    await new Promise(resolve => setTimeout(resolve, 5));

    // Act
    for (const resolve of w.release) resolve();
    await new Promise(resolve => setTimeout(resolve, 5));

    // Assert
    should(w.frames).have.length(1);
    should(w.ended).eql([]);
  });

  it('should end the stream on a page of another ferret’s revocation not at all', async () => {
    // Arrange
    const w = world();
    await w.attach();

    // Act
    w.scope.revoke('f2', 'p1');

    // Assert
    should(w.ended).eql([]);
  });
});

describe('revocation while a frame is retained for a congested socket', () => {
  class Clock implements FrameClock {
    due: (() => void) | undefined;
    now = () => 0;
    schedule(callback: () => void): FrameTimer {
      this.due = callback;
      return { cancel: () => (this.due = undefined) };
    }
  }
  class Down implements ViewerDownstream {
    sent: { envelope: Uint8Array; permit: (() => boolean) | undefined }[] = [];
    closes: { code: number; reason: string }[] = [];
    buffered = 1;
    send(envelope: Uint8Array, permit?: () => boolean): void {
      this.sent.push({ envelope, permit });
    }
    close(code: number, reason: string): void {
      this.closes.push({ code, reason });
    }
    bufferedBytes = () => this.buffered;
  }

  async function connect() {
    const { scope } = scoped();
    await scope.admit('f1', 'p1');
    let onFrame: ((frame: BrowserScreencastFrame) => void) | undefined;
    const host: BrowserViewerHost = {
      attachViewer: async (_s, frame) => {
        onFrame = frame;
        return { detach: () => undefined };
      },
      dispatchHumanInput: async () => undefined,
    };
    const down = new Down();
    const clock = new Clock();
    const stream = await BrowserViewerStream.connect(host, 'f1', down, clock, {
      delivery: scopeDelivery(scope, 'f1'),
    });
    return { scope, down, clock, stream, frame: () => onFrame?.(shot) };
  }

  it('should send nothing on the recovery retry once the page was taken over, with no new frame arriving', async () => {
    // Arrange
    const { scope, down, clock, stream, frame } = await connect();
    frame();
    should(down.sent).eql([]);
    should(clock.due).not.equal(undefined);

    // Act
    scope.revoke('f1', 'p1');
    down.buffered = 0;
    clock.due?.();

    // Assert
    should(down.sent).eql([]);
    should(down.closes).eql([{ code: 1008, reason: VIEWER_SCOPE_REFUSAL }]);
    should(stream.finished).be.true();
  });

  it('should send the retained frame when the permission still holds', async () => {
    // Arrange
    const { down, clock, frame } = await connect();
    frame();

    // Act
    down.buffered = 0;
    clock.due?.();

    // Assert
    should(down.sent.length).be.above(0);
  });

  it('should hand the transport a send permit that says no the moment the permission is withdrawn', async () => {
    // Arrange
    const { scope, down, frame } = await connect();
    down.buffered = 0;
    frame();
    const permit = down.sent[0]?.permit;
    should(permit).not.equal(undefined);
    should(permit?.()).be.true();

    // Act
    scope.revoke('f1', 'p1');

    // Assert: a send already handed to the transport but not yet on the wire is refused by the transport's own guard
    should(permit?.()).be.false();
  });
});

describe('the permission is asked again on a timer, for what raises no event', () => {
  it('should withdraw it, and end the streams of that page, when the rule now refuses', async () => {
    // Arrange
    const { scope, rule, timers } = scoped();
    const ended: string[] = [];
    const guard = scopeDelivery(scope, 'f1');
    guard.watch?.(reason => ended.push(reason));
    guard.stamp('p1');
    await scope.admit('f1', 'p1');
    should(timers).have.length(1);

    // Act: the owner turns "What agents may control" off, and the timer fires
    rule.allowed = false;
    timers.shift()?.();
    await new Promise(resolve => setTimeout(resolve, 5));

    // Assert
    should(ended).eql([VIEWER_SCOPE_REFUSAL]);
    should(VIEWER_RECHECK_MS).be.above(0);
  });

  it('should keep it, and keep asking, while the rule says yes', async () => {
    // Arrange
    const { scope, timers } = scoped();
    const ended: string[] = [];
    const guard = scopeDelivery(scope, 'f1');
    guard.watch?.(reason => ended.push(reason));
    guard.stamp('p1');
    await scope.admit('f1', 'p1');

    // Act
    timers.shift()?.();
    await new Promise(resolve => setTimeout(resolve, 5));

    // Assert
    should(ended).eql([]);
    should(timers).have.length(1);
  });
});
