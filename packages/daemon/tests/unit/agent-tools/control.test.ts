import { describe, it } from 'bun:test';
import should from 'should';
import { DRIVING_WINDOW_MS, SurfaceControl } from '../../../src/lib/index.ts';
import { ManualClock, RecordingEvents } from './support.ts';

const dev = { surface: 'terminal', id: 'a1b2c3d4e5f6', name: 'dev' } as const;
const page = { surface: 'browser', id: 'page-1' } as const;

describe('SurfaceControl — the driving marker', () => {
  it('should publish a marker once, and again only when it is about to lapse', async () => {
    // Arrange
    const events = new RecordingEvents();
    const clock = new ManualClock();
    const control = new SurfaceControl(events, clock);

    // Act
    await control.drove('s1', dev, { name: 'Hadi' });
    clock.ms += 1_000;
    await control.drove('s1', dev, { name: 'Hadi' });
    clock.ms += DRIVING_WINDOW_MS / 2;
    await control.drove('s1', dev, {});

    // Assert — the second act was inside the fresh half of the window, the third was not, and the
    // marker kept its original `since` because the agent never stopped.
    should(events.published.map(event => event.data)).deepEqual([
      {
        surface: 'terminal',
        id: 'a1b2c3d4e5f6',
        name: 'dev',
        agentSessionId: 's1',
        agentName: 'Hadi',
        since: '2026-10-16T10:00:00.000Z',
        until: '2026-10-16T10:00:15.000Z',
      },
      {
        surface: 'terminal',
        id: 'a1b2c3d4e5f6',
        name: 'dev',
        agentSessionId: 's1',
        since: '2026-10-16T10:00:00.000Z',
        until: '2026-10-16T10:00:23.500Z',
      },
    ]);
  });

  it('should start a new marker after one lapsed, and show only live ones', async () => {
    // Arrange
    const events = new RecordingEvents();
    const clock = new ManualClock();
    const control = new SurfaceControl(events, clock);
    await control.drove('s1', page, {});
    await control.drove('s2', dev, {});

    // Act
    const both = control.view('s1');
    clock.ms += DRIVING_WINDOW_MS;
    const lapsed = control.view('s1');
    await control.drove('s1', page, {});

    // Assert
    should(both.driving.map(driving => driving.id)).deepEqual(['page-1']);
    should(lapsed.driving).deepEqual([]);
    should(control.view('s1').driving).deepEqual([
      {
        surface: 'browser',
        id: 'page-1',
        agentSessionId: 's1',
        since: '2026-10-16T10:00:15.000Z',
        until: '2026-10-16T10:00:30.000Z',
      },
    ]);
  });
});

describe('SurfaceControl — takeover', () => {
  it('should hold a takeover until it is handed back, publishing each change once', async () => {
    // Arrange
    const events = new RecordingEvents();
    const clock = new ManualClock();
    const control = new SurfaceControl(events, clock);
    await control.drove('s1', dev, {});

    // Act
    const taken = await control.takeover('s1', dev, { by: 'local' });
    clock.ms += 5_000;
    const again = await control.takeover('s1', dev, { by: 'human', deviceId: 'phone-1' });
    const held = control.takeoverOf('s1', dev);
    await control.handback('s1', dev);
    await control.handback('s1', dev);

    // Assert
    should(again).equal(taken);
    should(held).equal(taken);
    should(control.takeoverOf('s1', dev)).be.undefined();
    should(events.published.map(event => event.type)).deepEqual([
      'surface.driving',
      'surface.takeover',
      'surface.handback',
    ]);
    should(events.published[2]?.data).deepEqual({
      surface: 'terminal',
      id: 'a1b2c3d4e5f6',
      name: 'dev',
      at: '2026-10-16T10:00:05.000Z',
    });
  });

  it('should key a takeover by the surface’s id, and drop everything about a surface that closed', async () => {
    // Arrange
    const events = new RecordingEvents();
    const control = new SurfaceControl(events, new ManualClock());
    await control.takeover('s1', page, { by: 'local' });
    await control.drove('s1', dev, {});

    // Act
    const reusedName = control.takeoverOf('s1', { surface: 'browser', id: 'page-2' });
    const otherSession = control.takeoverOf('s2', page);
    control.forget('s1', page);
    control.forget('s1', dev);
    await control.handback('s1', page);

    // Assert
    should(reusedName).be.undefined();
    should(otherSession).be.undefined();
    should(control.view('s1')).deepEqual({ sessionId: 's1', driving: [], takeovers: [] });
    should(events.published.map(event => event.type)).deepEqual(['surface.takeover', 'surface.driving']);
    should(events.published[0]?.data).deepEqual({
      surface: 'browser',
      id: 'page-1',
      by: { by: 'local' },
      since: '2026-10-16T10:00:00.000Z',
    });
  });
});
