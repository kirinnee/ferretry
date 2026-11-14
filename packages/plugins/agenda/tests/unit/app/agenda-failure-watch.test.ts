/**
 * B11: the mounted notification watch reads REAL Ferrets list rows. Ferrets never says `failed`: a death is `stopped`
 * with an end cause nobody chose, so the watch must classify that cause, not a legacy status. Intentional stops,
 * completion and first sight stay silent, and repeated ticks of one death notify once.
 */

import { describe, expect, it } from 'bun:test';
import { daemonId } from '../../../app/lib/machine.ts';
import { ferretViews, parseFerretList } from '../../../app/lib/ferret-view.ts';
import { DeviceNotificationFilterStore } from '../../../app/lib/notification-filter.ts';
import {
  type NotificationSpec,
  type NotifiedFleet,
  startNotificationWatch,
} from '../../../app/lib/notification-ledger.ts';

const daemon = daemonId('review-daemon');

const row = (state: string, cause?: unknown) => ({
  id: 'review-ferret',
  title: 'Review work',
  state,
  ...(cause === undefined ? {} : { cause }),
});
const sessionsOf = (...rows: readonly unknown[]) => ferretViews(parseFerretList(rows), new Map());

const watch = (first: unknown) => {
  let sessions = sessionsOf(first);
  let tick = () => {};
  let clock = 1_000_000;
  const shown: NotificationSpec[] = [];
  const filter = new DeviceNotificationFilterStore();
  const stop = startNotificationWatch(
    {
      snapshot: () => ({ daemons: new Map([[daemon, { sessions }]]) }) as NotifiedFleet,
      subscribe: listener => {
        tick = listener;
        return () => {};
      },
    },
    {
      prefs: () => ({ enabled: true, onlyWhenHidden: false }),
      filter: () => filter.get(),
      hidden: () => true,
      foregroundSession: () => null,
      show: spec => shown.push(spec),
      now: () => clock,
    },
  );
  return {
    shown,
    stop,
    advance: (ms: number) => {
      clock += ms;
    },
    next: (...rows: readonly unknown[]) => {
      sessions = sessionsOf(...rows);
      tick();
    },
  };
};

describe('B11 production list rows', () => {
  it('a working ferret that crashes notifies once, however many ticks repeat it', () => {
    const w = watch(row('working'));
    w.next(row('stopped', { kind: 'agent_crashed', exitCode: 1 }));
    w.next(row('stopped', { kind: 'agent_crashed', exitCode: 1 }));
    w.stop();
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0]?.kind).toBe('failed');
    expect(w.shown[0]?.body).toBe('Failed.');
  });

  it.each([
    [{ kind: 'tmux_crashed' }],
    [{ kind: 'terminal_gone' }],
    [{ kind: 'signal', signal: 9 }],
    [{ kind: 'agent_crashed', exitCode: 2 }],
    [{ kind: 'start_failed' }],
  ])('every end nobody chose notifies: %o', cause => {
    const w = watch(row('idle'));
    w.next(row('stopped', cause));
    w.stop();
    expect(w.shown).toHaveLength(1);
  });

  it.each([[{ kind: 'stopped' }], [{ kind: 'completed' }], [{ kind: 'clean_exit' }], [undefined]])(
    'an intentional stop, completion or a stop with no cause stays silent: %o',
    cause => {
      const w = watch(row('working'));
      w.next(row('stopped', cause));
      w.stop();
      expect(w.shown).toHaveLength(0);
    },
  );

  it('first sight of an already-dead ferret is silent', () => {
    const w = watch(row('stopped', { kind: 'agent_crashed', exitCode: 1 }));
    w.next(row('stopped', { kind: 'agent_crashed', exitCode: 1 }));
    w.stop();
    expect(w.shown).toHaveLength(0);
  });

  it('a ferret that is resumed and dies again notifies again', () => {
    const w = watch(row('working'));
    w.next(row('stopped', { kind: 'signal', signal: 9 }));
    w.next(row('working'));
    w.advance(120_000);
    w.next(row('stopped', { kind: 'signal', signal: 9 }));
    w.stop();
    expect(w.shown).toHaveLength(2);
  });
});
