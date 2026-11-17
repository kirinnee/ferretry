import { describe, it } from 'bun:test';
import should from 'should';
import { buildMonitor } from '../../../../../daemon/modules/monitor.ts';
import {
  defaultSessionMonitorSettings,
  type MonitorWaits,
  type ParkedSession,
  type WaitExpiry,
} from '../../../../../daemon/lib/session/monitor/index.ts';
import type { SessionSendService } from '../../../../../daemon/lib/session/peers/send.ts';
import { parseSessionId, type SessionId } from '../../../../../daemon/lib/session-id.ts';
import type { DeclaredWait } from '../../../../../daemon/lib/session/signal/types.ts';

/**
 * A tick that is still in flight when the daemon stops must do nothing more.
 *
 * The kernel aborts a job on stop but gives an uncooperative run ten seconds before the lifecycle `onStop` runs, and
 * `close()` only disarms the loop. A tick suspended in the roster read used to resume after `close()`, expire a wait,
 * tell the ferret, and re-stamp the record `armed: true` over the statement that the loop had stopped.
 */

const REVIEW = parseSessionId('20260806-review');
const SINCE = '2026-08-01T12:00:00.000Z';
const NOW_MS = Date.parse(SINCE) + defaultSessionMonitorSettings.backstopMs;
const clock = { now: () => new Date(NOW_MS).toISOString(), nowMs: () => NOW_MS };

/** A roster read the test holds open, then releases with an expired park on it. */
class ParkedGate implements MonitorWaits {
  readonly expired: SessionId[] = [];
  private release: (roster: readonly ParkedSession[]) => void = () => undefined;
  private readonly entered: Promise<void>;
  private markEntered: () => void = () => undefined;

  constructor() {
    this.entered = new Promise(resolve => (this.markEntered = resolve));
  }

  async parked(): Promise<readonly ParkedSession[]> {
    this.markEntered();
    return await new Promise(resolve => (this.release = resolve));
  }

  async expire(id: SessionId, _nowMs: number, _expiry: WaitExpiry): Promise<DeclaredWait | undefined> {
    this.expired.push(id);
    return { since: SINCE };
  }

  async hold(): Promise<boolean> {
    return false;
  }

  /** Resolves once a tick is suspended inside `parked()`. */
  suspended(): Promise<void> {
    return this.entered;
  }

  releaseExpired(): void {
    this.release([{ id: REVIEW, status: 'waiting', waiting: { since: SINCE } }]);
  }
}

function build() {
  const waits = new ParkedGate();
  const sent: string[] = [];
  const records: Record<string, unknown>[] = [];
  const sends: Pick<SessionSendService, 'send'> = {
    send: async input => {
      sent.push(String(input.id));
      return undefined as never;
    },
  };
  const monitor = buildMonitor({
    waits,
    files: {
      ensureDirectory: async () => undefined,
      writeTextAtomic: async (path, text) => {
        if (path.endsWith('monitor-tick.json')) records.push(JSON.parse(text));
      },
    },
    sends,
    clock,
  });
  return { monitor, waits, sent, records };
}

describe('a monitor tick in flight when the daemon stops', () => {
  it('sends nothing and does not stamp the loop armed after close()', async () => {
    const { monitor, waits, sent, records } = build();
    monitor.arm();
    const running = monitor.run();
    await waits.suspended();
    await monitor.close();
    waits.releaseExpired();
    await running;
    should(waits.expired).eql([]);
    should(sent).eql([]);
    should(records.at(-1)?.armed).equal(false);
  });

  it('stops the same way when the job signal aborts', async () => {
    const { monitor, waits, sent, records } = build();
    monitor.arm();
    const controller = new AbortController();
    const running = monitor.run(controller.signal);
    await waits.suspended();
    controller.abort();
    waits.releaseExpired();
    await running;
    should(waits.expired).eql([]);
    should(sent).eql([]);
    // The aborted run publishes nothing at all: the record still says whatever the last real write said.
    should(records).eql([]);
  });

  it('sends the wake of a park whose expire already committed, and expires no second park', async () => {
    const OTHER = parseSessionId('20260806-other');
    const expired: SessionId[] = [];
    const sent: string[] = [];
    const records: Record<string, unknown>[] = [];
    let stop: () => Promise<void> = async () => undefined;
    const waits: MonitorWaits = {
      parked: async () => [
        { id: REVIEW, status: 'waiting', waiting: { since: SINCE } },
        { id: OTHER, status: 'waiting', waiting: { since: SINCE } },
      ],
      // The stop lands after this park's expire has committed, before its nudge goes out.
      expire: async id => {
        expired.push(id);
        await stop();
        return { since: SINCE };
      },
      hold: async () => false,
    };
    const monitor = buildMonitor({
      waits,
      files: {
        ensureDirectory: async () => undefined,
        writeTextAtomic: async (path, text) => {
          if (path.endsWith('monitor-tick.json')) records.push(JSON.parse(text));
        },
      },
      sends: {
        send: async input => {
          sent.push(String(input.id));
          return undefined as never;
        },
      },
      clock,
    });
    stop = () => monitor.close();
    monitor.arm();
    await monitor.run();
    // Its park is already cleared, so no later tick or restart could wake it: the committed wake is sent.
    should(sent).eql([String(REVIEW)]);
    should(expired).eql([REVIEW]);
    should(records.at(-1)?.armed).equal(false);
  });
});
