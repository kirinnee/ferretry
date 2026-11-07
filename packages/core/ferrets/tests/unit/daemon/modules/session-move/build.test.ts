import { describe, expect, test } from 'bun:test';
import { sessionMigrateModule } from '../../../../bin/modules/session-migrate.ts';
import type { ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';
import { sessionMigrateNeedsForTest } from './fixture.ts';

/**
 * THE `session-migrate` MODULE'S BUILD.
 *
 * The extraction moved the migration service out of `fyd.ts` untouched, so these pin what the move could have changed:
 * the module registers no release and creates no timer while building, and the four routes come back as the module's own
 * contribution with exactly the one audit rule that left the shared list.
 */

describe('the session-migrate module build', () => {
  test('contributes the four migration routes and the ask-to-stop-jobs audit rule, and registers no release', () => {
    const releases: string[] = [];
    const lifecycle: ModuleLifecycle = { onRelease: label => void releases.push(label), releasing: () => false };

    const built = sessionMigrateModule.build(sessionMigrateNeedsForTest(), undefined, lifecycle);

    expect(built.id).toBe('sessionMigrate');
    expect(releases).toEqual([]);
    expect((built.contributes.routes ?? []).map(route => `${route.method} ${route.path}`)).toEqual([
      'GET /v1/sessions/:sessionId/relaunch-settings',
      'POST /v1/sessions/:sessionId/conversion-preview',
      'POST /v1/sessions/:sessionId/migrate',
      'POST /v1/sessions/:sessionId/migrate/ask-to-stop-jobs',
    ]);
    expect(built.contributes.sockets).toBeUndefined();
    expect(built.contributes.audit?.sockets).toBeUndefined();
    expect((built.contributes.audit?.routes ?? []).map(rule => `${rule.method} ${rule.path} ${rule.event}`)).toEqual([
      'POST /v1/sessions/:sessionId/migrate/ask-to-stop-jobs agent.prompted',
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
      const built = sessionMigrateModule.build(sessionMigrateNeedsForTest(), undefined, {
        onRelease: () => undefined,
        releasing: () => false,
      });

      expect(timers).toEqual([]);
      expect(typeof built.provides.migrate).toBe('function');
    } finally {
      globalThis.setInterval = setInterval0;
      globalThis.setTimeout = setTimeout0;
    }
  });
});
