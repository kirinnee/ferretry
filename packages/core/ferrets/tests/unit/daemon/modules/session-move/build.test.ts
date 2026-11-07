import { describe, expect, test } from 'bun:test';
import { sessionMoveModule } from '../../../../../daemon/modules/session-move.ts';
import type { ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';
import { sessionMoveNeedsForTest } from './fixture.ts';

/**
 * THE `session-move` MODULE'S BUILD.
 *
 * The extraction moved the move service out of `fyd.ts` untouched, so these pin what the move could have changed:
 * the module registers no release and creates no timer while building, and the four routes come back as the module's own
 * contribution with exactly the one audit rule that left the shared list.
 */

describe('the session-move module build', () => {
  test('contributes the four move routes and the ask-to-stop-jobs audit rule, and registers no release', () => {
    const releases: string[] = [];
    const lifecycle: ModuleLifecycle = { onRelease: label => void releases.push(label), releasing: () => false };

    const built = sessionMoveModule.build(sessionMoveNeedsForTest(), undefined, lifecycle);

    expect(built.id).toBe('sessionMove');
    expect(releases).toEqual([]);
    expect((built.contributes.routes ?? []).map(route => `${route.method} ${route.path}`)).toEqual([
      'GET /v1/ferrets/:ferretId/relaunch-settings',
      'POST /v1/ferrets/:ferretId/conversion-preview',
      'POST /v1/ferrets/:ferretId/move',
      'POST /v1/ferrets/:ferretId/move/ask-to-stop-jobs',
    ]);
    expect(built.contributes.sockets).toBeUndefined();
    expect(built.contributes.audit?.sockets).toBeUndefined();
    expect((built.contributes.audit?.routes ?? []).map(rule => `${rule.method} ${rule.path} ${rule.event}`)).toEqual([
      'POST /v1/ferrets/:ferretId/move/ask-to-stop-jobs agent.prompted',
    ]);
    expect(built.contributes.features).toBeUndefined();
    expect(built.jobs).toEqual({});
  });

  test('creates no timer while building', () => {
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
      const built = sessionMoveModule.build(sessionMoveNeedsForTest(), undefined, {
        onRelease: () => undefined,
        releasing: () => false,
      });

      expect(timers).toEqual([]);
      expect(typeof built.provides.move).toBe('function');
    } finally {
      globalThis.setInterval = setInterval0;
      globalThis.setTimeout = setTimeout0;
    }
  });
});
