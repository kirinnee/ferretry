import { describe, expect, test } from 'bun:test';
import { sessionHandoverModule } from '../../../../bin/modules/session-handover.ts';
import type { ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';
import { sessionHandoverNeedsForTest } from './fixture.ts';

/**
 * THE `session-handover` MODULE'S BUILD.
 *
 * The extraction moved the handover service and its reconcile loop out of `fyd.ts` untouched, so these pin what the move
 * could have changed: the module registers no release, the build creates no timer (the loop's interval belongs to
 * `jobs.arm()`, which `start()` calls on the line it always had), and the three routes come back as the module's own
 * contribution with no audit rule (the session journal records a handover).
 */

describe('the session-handover module build', () => {
  test('contributes the three handover routes and no audit rule, and registers no release', () => {
    const releases: string[] = [];
    const lifecycle: ModuleLifecycle = { onRelease: label => void releases.push(label), releasing: () => false };

    const built = sessionHandoverModule.build(sessionHandoverNeedsForTest(), undefined, lifecycle);

    expect(built.id).toBe('sessionHandover');
    expect(releases).toEqual([]);
    expect((built.contributes.routes ?? []).map(route => `${route.method} ${route.path}`)).toEqual([
      'POST /v1/sessions/:sessionId/handover',
      'GET /v1/sessions/:sessionId/handover',
      'POST /v1/sessions/:sessionId/handover/cancel',
    ]);
    expect(built.contributes.sockets).toBeUndefined();
    expect(built.contributes.audit).toBeUndefined();
    expect(built.contributes.features).toBeUndefined();
  });

  test('creates no timer while building, and hands the loop to the arming job unarmed', () => {
    const timers: string[] = [];
    const setInterval0 = globalThis.setInterval;
    const setTimeout0 = globalThis.setTimeout;
    globalThis.setInterval = ((..._args: unknown[]) => {
      timers.push('setInterval');
      return 0;
    }) as unknown as typeof setInterval;
    globalThis.setTimeout = ((..._args: unknown[]) => {
      timers.push('setTimeout');
      return 0;
    }) as unknown as typeof setTimeout;
    try {
      const built = sessionHandoverModule.build(sessionHandoverNeedsForTest(), undefined, {
        onRelease: () => undefined,
        releasing: () => false,
      });

      expect(timers).toEqual([]);
      expect(typeof built.jobs.arm).toBe('function');
      expect(built.provides.reconcile).toBeDefined();
      expect(built.provides.handover).toBeDefined();
    } finally {
      globalThis.setInterval = setInterval0;
      globalThis.setTimeout = setTimeout0;
    }
  });
});
