import { describe, expect, test } from 'bun:test';
import { sessionForkModule } from '../../../../bin/modules/session-fork.ts';
import type { ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';
import { sessionForkNeedsForTest } from './fixture.ts';

/**
 * THE `session-fork` MODULE'S BUILD.
 *
 * The extraction moved `createForkSubsystem` out of `fyd.ts` untouched, so these pin the three things the move could
 * have changed: the module registers no release and no job (the fork holds no timer and no process), the transfer
 * module's ports factory is still CALLED inside the build (the injection survives, and is called at the point the fork
 * always constructed those ports, once), and every value the old call read LATE is still a closure the build never runs
 * (the account resolution, the lifecycle factory and the session view are read per request, never at construction).
 */

describe('the session-fork module build', () => {
  test('contributes the one fork route and its audit rule, and arms nothing', () => {
    const releases: string[] = [];
    const lifecycle: ModuleLifecycle = { onRelease: label => void releases.push(label), releasing: () => false };

    const built = sessionForkModule.build(sessionForkNeedsForTest(), undefined, lifecycle);

    expect(built.id).toBe('sessionFork');
    expect(built.jobs).toEqual({});
    expect(releases).toEqual([]);
    expect((built.contributes.routes ?? []).map(route => `${route.method} ${route.path}`)).toEqual([
      'POST /v1/sessions/:sessionId/fork',
    ]);
    expect(built.contributes.sockets).toBeUndefined();
    expect(built.contributes.features).toBeUndefined();
    expect(built.contributes.audit?.routes).toEqual([
      {
        method: 'POST',
        path: '/v1/sessions/:sessionId/fork',
        event: 'session.opened',
        subject: 'sessionId',
        detail: { action: 'fork' },
      },
    ]);
  });

  test('calls the injected transfer ports factory once, inside the build, over the paths and resolver it was handed', () => {
    const needs = sessionForkNeedsForTest();
    const asked: unknown[] = [];
    const realPorts = needs.transferPorts;

    const built = sessionForkModule.build(
      {
        ...needs,
        transferPorts: parts => {
          asked.push(parts);
          return realPorts(parts);
        },
      },
      undefined,
      { onRelease: () => undefined, releasing: () => false },
    );

    expect(built.provides).toBeDefined();
    expect(asked).toEqual([{ paths: needs.paths, attachmentOriginals: needs.attachmentOriginals }]);
  });

  test('reads no late value at build: the account resolution, the lifecycle factory, the view and the sources stay unread', () => {
    const reads: string[] = [];
    const needs = sessionForkNeedsForTest({
      accounts: async () => {
        reads.push('accounts');
        throw new Error('not exercised');
      },
      createLifecycle: () => {
        reads.push('createLifecycle');
        throw new Error('not exercised');
      },
      view: async () => {
        reads.push('view');
        return undefined;
      },
    });

    sessionForkModule.build(needs, undefined, { onRelease: () => undefined, releasing: () => false });

    expect(reads).toEqual([]);
  });
});
