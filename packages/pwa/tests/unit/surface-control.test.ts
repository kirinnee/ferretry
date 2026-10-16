import { describe, test } from 'bun:test';
import type { FyEvent, SurfaceControlView, SurfaceDriving, SurfaceTakeover } from '@ferretry/protocol';
import should from 'should';
import {
  activeSurfaceDriving,
  applySurfaceEvent,
  createSurfaceEventHub,
  drivingAgentName,
  isSurfaceControlEvent,
  nextDrivingLapse,
  type SurfaceControlState,
  surfaceDrivingFor,
  surfaceTakeoverFor,
  UNREAD_SURFACE_CONTROL,
  withSurfaceControlView,
} from '../../src/lib/surface-control.ts';

const SESSION = 'sess-1';
const NOW = Date.parse('2026-10-16T10:00:00.000Z');
const LATER = '2026-10-16T10:00:15.000Z';
const EARLIER = '2026-10-16T09:59:00.000Z';

const driving = (overrides: Partial<SurfaceDriving> = {}): SurfaceDriving => ({
  surface: 'terminal',
  id: 'a1b2c3d4e5f6',
  name: 'dev',
  agentSessionId: SESSION,
  agentName: 'Hadi',
  since: EARLIER,
  until: LATER,
  ...overrides,
});

const takeover = (overrides: Partial<SurfaceTakeover> = {}): SurfaceTakeover => ({
  surface: 'terminal',
  id: 'a1b2c3d4e5f6',
  name: 'dev',
  by: { by: 'human', deviceId: 'phone' },
  since: EARLIER,
  ...overrides,
});

const view = (overrides: Partial<SurfaceControlView> = {}): SurfaceControlView => ({
  sessionId: SESSION,
  driving: [],
  takeovers: [],
  handed: [],
  ...overrides,
});

const event = (type: string, data: unknown, sessionId = SESSION): FyEvent => ({
  sequence: 1,
  time: EARLIER,
  sessionId,
  type,
  source: 'daemon',
  data,
});

describe('withSurfaceControlView', () => {
  test('should replace one kind with the daemon answer for this session', () => {
    // Act
    const state = withSurfaceControlView(UNREAD_SURFACE_CONTROL, SESSION, 'terminal', view({ driving: [driving()] }));

    // Assert
    should(state.terminal?.driving).have.length(1);
    should(state.browser).be.null();
  });

  test('should drop an answer for another session', () => {
    const state = withSurfaceControlView(UNREAD_SURFACE_CONTROL, SESSION, 'terminal', view({ sessionId: 'other' }));
    should(state).equal(UNREAD_SURFACE_CONTROL);
  });
});

describe('applySurfaceEvent', () => {
  test('should fold a driving record into an unread kind, and replace it on the next one', () => {
    // Act
    const first = applySurfaceEvent(UNREAD_SURFACE_CONTROL, SESSION, event('surface.driving', driving()));
    const second = applySurfaceEvent(
      first,
      SESSION,
      event('surface.driving', driving({ until: '2026-10-16T10:01:00.000Z' })),
    );

    // Assert
    should(second.terminal?.driving).deepEqual([driving({ until: '2026-10-16T10:01:00.000Z' })]);
  });

  test('should drop the agent marker when a person takes the surface, and restore nothing on hand back', () => {
    // Arrange
    const driven = applySurfaceEvent(UNREAD_SURFACE_CONTROL, SESSION, event('surface.driving', driving()));

    // Act
    const held = applySurfaceEvent(driven, SESSION, event('surface.takeover', takeover()));
    const late = applySurfaceEvent(held, SESSION, event('surface.driving', driving()));
    const back = applySurfaceEvent(
      late,
      SESSION,
      event('surface.handback', { surface: 'terminal', id: 'a1b2c3d4e5f6', at: LATER }),
    );

    // Assert
    should(held.terminal?.driving).deepEqual([]);
    should(held.terminal?.takeovers).have.length(1);
    // An out-of-order driving record never shows a held surface as driven.
    should(late).equal(held);
    should(back.terminal?.takeovers).deepEqual([]);
    should(back.terminal?.driving).deepEqual([]);
  });

  test('should record a surface handed to the agent', () => {
    const state = applySurfaceEvent(
      UNREAD_SURFACE_CONTROL,
      SESSION,
      event('surface.handed', { surface: 'browser', id: 'PAGE1', by: { by: 'local' }, at: EARLIER }),
    );
    should(state.browser?.handed).have.length(1);
    should(state.terminal).be.null();
  });

  test('should ignore another session, another event type and a malformed record', () => {
    for (const ignored of [
      event('surface.driving', driving(), 'other'),
      event('turn.started', {}),
      event('surface.driving', { surface: 'terminal' }),
      event('surface.takeover', { id: 1 }),
      event('surface.handback', null),
      event('surface.handed', 'nope'),
    ])
      should(applySurfaceEvent(UNREAD_SURFACE_CONTROL, SESSION, ignored)).equal(UNREAD_SURFACE_CONTROL);
  });
});

describe('who is driving', () => {
  const state: SurfaceControlState = {
    terminal: view({ driving: [driving()] }),
    browser: view({
      driving: [driving({ surface: 'browser', id: 'PAGE1', name: 'app', until: EARLIER })],
      takeovers: [takeover({ surface: 'browser', id: 'PAGE2', name: 'docs' })],
    }),
  };

  test('should answer by id or by name, while the marker has not lapsed', () => {
    should(surfaceDrivingFor(state, 'terminal', 'dev', NOW)?.agentName).equal('Hadi');
    should(surfaceDrivingFor(state, 'terminal', 'a1b2c3d4e5f6', NOW)?.agentName).equal('Hadi');
    should(surfaceDrivingFor(state, 'terminal', 'other', NOW)).be.undefined();
    // Lapsed: shown only while now < until.
    should(surfaceDrivingFor(state, 'browser', 'app', NOW)).be.undefined();
    should(surfaceDrivingFor(UNREAD_SURFACE_CONTROL, 'terminal', 'dev', NOW)).be.undefined();
  });

  test('should report a held surface as held, by id or by name, and never as driven', () => {
    const both: SurfaceControlState = { ...state, terminal: view({ driving: [driving()], takeovers: [takeover()] }) };
    should(surfaceTakeoverFor(both, 'terminal', 'dev')).not.be.undefined();
    should(surfaceTakeoverFor(both, 'browser', 'PAGE2')).not.be.undefined();
    should(surfaceTakeoverFor(both, 'browser', 'app')).be.undefined();
    should(surfaceDrivingFor(both, 'terminal', 'dev', NOW)).be.undefined();
  });

  test('should list the markers standing now and when the next one lapses', () => {
    should(activeSurfaceDriving(state, NOW)).deepEqual([driving()]);
    should(nextDrivingLapse(state, NOW)).equal(Date.parse(LATER));
    should(nextDrivingLapse(UNREAD_SURFACE_CONTROL, NOW)).be.undefined();
  });

  test('should name the agent, or say "The agent" when it has no name', () => {
    should(drivingAgentName(driving())).equal('Hadi');
    const { agentName: _omitted, ...nameless } = driving();
    should(drivingAgentName(nameless)).equal('The agent');
  });

  test('should recognise exactly the four control events', () => {
    for (const type of ['surface.driving', 'surface.takeover', 'surface.handback', 'surface.handed'])
      should(isSurfaceControlEvent(event(type, {}))).be.true();
    should(isSurfaceControlEvent(event('surface.closed', {}))).be.false();
  });
});

describe('createSurfaceEventHub', () => {
  test('should hand every published event to every subscriber until it unsubscribes', () => {
    // Arrange
    const hub = createSurfaceEventHub();
    const seen: string[] = [];
    const stop = hub.subscribe(next => seen.push(`a:${next.type}`));
    hub.subscribe(next => seen.push(`b:${next.type}`));

    // Act
    hub.publish(event('surface.driving', {}));
    stop();
    hub.publish(event('surface.takeover', {}));

    // Assert
    should(seen).deepEqual(['a:surface.driving', 'b:surface.driving', 'b:surface.takeover']);
  });
});
