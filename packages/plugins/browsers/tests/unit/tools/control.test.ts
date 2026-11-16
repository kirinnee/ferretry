import { describe, it } from 'bun:test';
import should from 'should';
import { forgetsClosedPages, SurfaceControl } from '../../../daemon/tools/control.ts';
import type { RecordedSurfaceEvent, SurfaceEventSink } from '../../../daemon/tools/types.ts';

const T0 = Date.parse('2026-10-16T10:00:00.000Z');
const page = { surface: 'browser', id: 'page-1' } as const;

/** A clock the test moves by hand. */
class ManualClock {
  ms = T0;
  now = (): number => this.ms;
}

/** The session's journal: what was published is kept and read back, and a read can be made to fail. */
class RecordingEvents implements SurfaceEventSink {
  readonly published: { readonly type: string; readonly data: unknown }[] = [];
  /** Earlier runs' events, as the daemon read them from the journal at a start. */
  readonly earlier = new Map<string, RecordedSurfaceEvent[]>();
  /** How many of the next `history` reads fail. */
  unreadable = 0;
  reads = 0;

  publish = async (_sessionId: string, type: string, data: unknown): Promise<void> => {
    this.published.push({ type, data });
  };

  history = async (sessionId: string): Promise<readonly RecordedSurfaceEvent[]> => {
    this.reads += 1;
    if (this.unreadable > 0) {
      this.unreadable -= 1;
      throw new Error('the journal could not be read');
    }
    return this.earlier.get(sessionId) ?? [];
  };
}

describe('SurfaceControl — a takeover of a page', () => {
  it('holds a takeover until it is handed back, publishing each change once', async () => {
    // Arrange
    const events = new RecordingEvents();
    const clock = new ManualClock();
    const control = new SurfaceControl(events, clock);

    // Act
    const taken = await control.takeover('s1', page, { by: 'local' });
    clock.ms += 5_000;
    const again = await control.takeover('s1', page, { by: 'human', deviceId: 'phone-1' });
    const held = await control.takeoverOf('s1', page);
    await control.handback('s1', page);
    await control.handback('s1', page);

    // Assert — the second takeover found the first standing, and the second handback found nothing to hand back.
    should(again).equal(taken);
    should(held).equal(taken);
    should(await control.takeoverOf('s1', page)).be.undefined();
    should(events.published.map(event => event.type)).deepEqual(['surface.takeover', 'surface.handback']);
    should(events.published[0]?.data).deepEqual({
      surface: 'browser',
      id: 'page-1',
      by: { by: 'local' },
      since: '2026-10-16T10:00:00.000Z',
    });
    should(events.published[1]?.data).deepEqual({
      surface: 'browser',
      id: 'page-1',
      at: '2026-10-16T10:00:05.000Z',
    });
  });

  it('keys a takeover by the page’s id and the session, and drops everything about a page that closed', async () => {
    // Arrange
    const events = new RecordingEvents();
    const control = new SurfaceControl(events, new ManualClock());
    await control.takeover('s1', { ...page, name: 'app' }, { by: 'local' });
    await control.drove('s1', { surface: 'browser', id: 'page-2' }, {});

    // Act
    const sameNameNewId = await control.takeoverOf('s1', { surface: 'browser', id: 'page-9', name: 'app' });
    const otherSession = await control.takeoverOf('s2', page);
    control.forget('s1', page);
    control.forget('s1', { surface: 'browser', id: 'page-2' });
    await control.handback('s1', page);

    // Assert
    should(sameNameNewId).be.undefined();
    should(otherSession).be.undefined();
    should(await control.view('s1', 'browser')).deepEqual({
      sessionId: 's1',
      driving: [],
      takeovers: [],
      handed: [],
      opened: [],
      asked: [],
    });
    // Forgetting is memory only: it published nothing, and a handback of a forgotten takeover publishes nothing.
    should(events.published.map(event => event.type)).deepEqual(['surface.takeover', 'surface.driving']);
  });

  it('retries an unreadable journal, and never reads it as a takeover released', async () => {
    // Arrange — a previous daemon run took the page over; the first read of its journal fails.
    const events = new RecordingEvents();
    events.earlier.set('s1', [
      {
        type: 'surface.takeover',
        data: { surface: 'browser', id: 'page-1', by: { by: 'local' }, since: '2026-10-16T09:00:00.000Z' },
      },
    ]);
    events.unreadable = 1;
    const control = new SurfaceControl(events, new ManualClock());

    // Act
    const failed = await control.takeoverOf('s1', page).catch((error: unknown) => error);
    const retried = await control.takeoverOf('s1', page);
    const cached = await control.takeoverOf('s1', page);

    // Assert — the failure reached the caller (so the act fails closed), the retry found the takeover, and a
    // journal that was read is read once.
    should((failed as Error).message).equal('the journal could not be read');
    should(retried).match({ surface: 'browser', id: 'page-1', by: { by: 'local' } });
    should(cached).equal(retried);
    should(events.reads).equal(2);
  });
});

describe('SurfaceControl — a page that closed', () => {
  it('ends its takeover and ask in memory and in the journal, so a replay reads the page released', async () => {
    // Arrange
    const events = new RecordingEvents();
    const clock = new ManualClock();
    const control = new SurfaceControl(events, clock);
    await control.asked('s1', { ...page, name: 'app' }, {});
    await control.takeover('s1', { ...page, name: 'app' }, { by: 'local' });
    await control.asked('s1', { ...page, name: 'app' }, {}, 'Your turn');
    clock.ms += 3_000;

    // Act
    await control.closed('s1', page);
    await control.closed('s1', page);
    const standing = await control.view('s1', 'browser');
    const replayed = new SurfaceControl(
      { publish: async () => undefined, history: async () => events.published },
      new ManualClock(),
    );

    // Assert — one handback was journaled, naming the page; nothing stands, now or after a restart.
    should(events.published.map(event => event.type)).deepEqual([
      'surface.asked',
      'surface.takeover',
      'surface.asked',
      'surface.handback',
    ]);
    should(events.published[3]?.data).deepEqual({
      surface: 'browser',
      id: 'page-1',
      name: 'app',
      at: '2026-10-16T10:00:03.000Z',
      closed: true,
    });
    should(standing).deepEqual({ sessionId: 's1', driving: [], takeovers: [], handed: [], opened: [], asked: [] });
    should(await replayed.takeoverOf('s1', page)).be.undefined();
    should((await replayed.view('s1', 'browser')).asked).deepEqual([]);
  });

  it('does not let a takeover of a closed page hold a new page that reuses its id', async () => {
    // Arrange — `page-1` is taken over and closes; the browser starts again and opens another `page-1`.
    const control = new SurfaceControl(new RecordingEvents(), new ManualClock());
    await control.takeover('s1', page, { by: 'local' });
    await control.hand('s1', page, { by: 'local' });

    // Act
    await control.closed('s1', page);

    // Assert
    should(await control.takeoverOf('s1', page)).be.undefined();
    should(await control.isHanded('s1', page)).be.false();
  });

  it('forgets the page even when the journal cannot be read, and tells the caller', async () => {
    // Arrange
    const events = new RecordingEvents();
    const control = new SurfaceControl(events, new ManualClock());
    await control.drove('s1', page, {});
    events.unreadable = 1;

    // Act
    const failed = await control.closed('s1', page).catch((error: unknown) => error);

    // Assert
    should((failed as Error).message).equal('the journal could not be read');
    should(JSON.stringify(await control.view('s1', 'browser'))).not.containEql('page-1');
  });

  it('is what a closing page tells, through the browser’s close hook', async () => {
    // Arrange
    const events = new RecordingEvents();
    const control = new SurfaceControl(events, new ManualClock());
    await control.takeover('s1', page, { by: 'local' });
    const told: string[] = [];

    // Act
    forgetsClosedPages(control, (sessionId, pageId) => told.push(`${sessionId}:${pageId}`)).closed('s1', 'page-1');
    await Bun.sleep(5);

    // Assert
    should(told).deepEqual(['s1:page-1']);
    should(await control.takeoverOf('s1', page)).be.undefined();
    should(events.published.map(event => event.type)).deepEqual(['surface.takeover', 'surface.handback']);
  });
});

describe('SurfaceControl — a page that closed, replayed from its journal', () => {
  /** A control over the journal an earlier one wrote: what a daemon that kept its events reads at a start. */
  async function replayed(setup: (control: SurfaceControl) => Promise<void>) {
    const events = new RecordingEvents();
    const control = new SurfaceControl(events, new ManualClock());
    await setup(control);
    events.earlier.set('s1', events.published as RecordedSurfaceEvent[]);
    return await new SurfaceControl(events, new ManualClock()).view('s1', 'browser');
  }

  it('does not ask again for a page that closed with an ask and no takeover', async () => {
    // Act
    const view = await replayed(async control => {
      await control.asked('s1', page, {});
      await control.closed('s1', page);
    });

    // Assert
    should(view.asked).deepEqual([]);
  });

  it('does not mark a closed page as handed or opened again', async () => {
    // Act
    const view = await replayed(async control => {
      await control.opened('s1', page, {});
      await control.hand('s1', page, { by: 'local' });
      await control.takeover('s1', page, { by: 'local' });
      await control.closed('s1', page);
    });

    // Assert
    should([view.opened, view.handed, view.takeovers, view.asked]).deepEqual([[], [], [], []]);
  });

  it('does not mark a closed page as handed when it had no takeover at all', async () => {
    // Act
    const view = await replayed(async control => {
      await control.hand('s1', page, { by: 'local' });
      await control.closed('s1', page);
    });

    // Assert
    should(view.handed).deepEqual([]);
  });

  it('journals nothing for a page that never carried a mark', async () => {
    // Arrange
    const events = new RecordingEvents();
    const control = new SurfaceControl(events, new ManualClock());

    // Act
    await control.closed('s1', page);

    // Assert
    should(events.published).deepEqual([]);
  });
});
