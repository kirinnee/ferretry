import { describe, expect, test } from 'bun:test';
import { sessionMoveModule } from '../../../../../daemon/modules/session-move.ts';
import { sessionMoveNeedsForTest } from './fixture.ts';

/**
 * THE `session-move` MODULE'S BUILD.
 *
 * The module's build is pure, so these pin what the move could have changed: the module creates no timer while
 * building, and the four routes come back as the module's own contribution. Who may call them, the no-store rule and
 * the one audit record (ask-to-stop-jobs prompts the agent as a send does) are the manifest's descriptors, checked
 * against it by the descriptor parity test.
 */

describe('the session-move module build', () => {
  test('contributes the four move routes', () => {
    const built = sessionMoveModule.build(sessionMoveNeedsForTest(), undefined, undefined);

    expect(built.id).toBe('sessionMove');
    expect(built.contributes.routes.map(route => `${route.method} ${route.path}`)).toEqual([
      'GET /v1/ferrets/:ferretId/relaunch-settings',
      'POST /v1/ferrets/:ferretId/conversion-preview',
      'POST /v1/ferrets/:ferretId/move',
      'POST /v1/ferrets/:ferretId/move/ask-to-stop-jobs',
    ]);
    expect(Object.keys(built.contributes)).toEqual(['routes']);
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
      const built = sessionMoveModule.build(sessionMoveNeedsForTest(), undefined, undefined);

      expect(timers).toEqual([]);
      expect(typeof built.provides.move).toBe('function');
    } finally {
      globalThis.setInterval = setInterval0;
      globalThis.setTimeout = setTimeout0;
    }
  });
});
