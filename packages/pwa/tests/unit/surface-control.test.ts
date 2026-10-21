import { describe, test } from 'bun:test';
import type {
  FyEvent,
  SurfaceAsked,
  SurfaceControlView,
  SurfaceDriving,
  SurfaceOpened,
  SurfaceTakeover,
} from '@ferretry/protocol';
import should from 'should';
import {
  activeSurfaceDriving,
  applySurfaceEvent,
  createSurfaceEventHub,
  drivingAgentName,
  isSurfaceControlEvent,
  nextDrivingLapse,
  openedSurfaces,
  askedSurfaces,
  surfaceAskFor,
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
  opened: [],
  asked: [],
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
      event('surface.opened', { surface: 'terminal' }),
      event('surface.asked', 42),
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

  test('should recognise exactly the control events', () => {
    for (const type of [
      'surface.driving',
      'surface.takeover',
      'surface.handback',
      'surface.handed',
      'surface.opened',
      'surface.asked',
    ])
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

const opened = (overrides: Partial<SurfaceOpened> = {}): SurfaceOpened => ({
  surface: 'terminal',
  id: 'a1b2c3d4e5f6',
  name: 'dev',
  agentSessionId: SESSION,
  agentName: 'Hadi',
  at: EARLIER,
  ...overrides,
});
const asked = (overrides: Partial<SurfaceAsked> = {}): SurfaceAsked => ({
  ...opened({ at: LATER }),
  message: 'Enter the code',
  ...overrides,
});
const page = { surface: 'browser', id: 'PAGE1' } as const;

describe('agent-opened and asked surfaces', () => {
  test('should fold an opened surface once, replacing a repeat of the same id', () => {
    // Act
    const first = applySurfaceEvent(UNREAD_SURFACE_CONTROL, SESSION, event('surface.opened', opened()));
    const second = applySurfaceEvent(first, SESSION, event('surface.opened', opened({ agentName: 'Sam' })));

    // Assert
    should(second.terminal?.opened).have.length(1);
    should(second.terminal?.opened[0]?.agentName).equal('Sam');
  });

  test('should fold an ask, and clear it when a person takes the surface or hands it back', () => {
    // Arrange
    const standing = applySurfaceEvent(UNREAD_SURFACE_CONTROL, SESSION, event('surface.asked', asked()));

    // Act
    const taken = applySurfaceEvent(standing, SESSION, event('surface.takeover', takeover()));
    const back = applySurfaceEvent(
      standing,
      SESSION,
      event('surface.handback', { surface: 'terminal', id: 'a1b2c3d4e5f6', at: LATER }),
    );

    // Assert
    should(standing.terminal?.asked).have.length(1);
    should(taken.terminal?.asked).deepEqual([]);
    should(back.terminal?.asked).deepEqual([]);
  });

  test('should ignore a late ask for a surface a person already holds', () => {
    // Arrange
    const held = applySurfaceEvent(UNREAD_SURFACE_CONTROL, SESSION, event('surface.takeover', takeover()));

    // Act + Assert
    should(applySurfaceEvent(held, SESSION, event('surface.asked', asked()))).equal(held);
  });

  test('should list opened and asked surfaces of both kinds, oldest first, and find an ask by id or name', () => {
    // Arrange
    const state: SurfaceControlState = {
      terminal: view({ opened: [opened({ at: LATER })], asked: [asked()] }),
      browser: view({
        opened: [{ ...opened({ ...page, at: EARLIER }), name: 'login' }],
        asked: [asked({ ...page, at: EARLIER })],
      }),
    };

    // Act + Assert
    should(openedSurfaces(state).map(entry => entry.id)).deepEqual(['PAGE1', 'a1b2c3d4e5f6']);
    should(askedSurfaces(state).map(entry => entry.id)).deepEqual(['PAGE1', 'a1b2c3d4e5f6']);
    should(surfaceAskFor(state, 'terminal', 'dev')?.message).equal('Enter the code');
    should(surfaceAskFor(state, 'terminal', 'a1b2c3d4e5f6')?.id).equal('a1b2c3d4e5f6');
    should(surfaceAskFor(state, 'terminal', 'nope')).be.undefined();
    should(surfaceAskFor(UNREAD_SURFACE_CONTROL, 'terminal', 'dev')).be.undefined();
    should(openedSurfaces(UNREAD_SURFACE_CONTROL)).deepEqual([]);
    should(askedSurfaces(UNREAD_SURFACE_CONTROL)).deepEqual([]);
  });
});
