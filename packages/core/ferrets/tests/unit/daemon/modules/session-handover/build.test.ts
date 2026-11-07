import { describe, expect, test } from 'bun:test';
import { sessionHandoverModule } from '../../../../../daemon/modules/session-handover.ts';
import { sessionHandoverNeedsForTest } from './fixture.ts';

/**
 * THE `session-handover` MODULE'S BUILD.
 *
 * These pin what the port onto the kernel could have changed: the build creates no timer (the loop's timers belong to
 * `jobs.arm()`, which the host calls on the line `start()` always had, over the INJECTED `every` — never a global
 * `setInterval`), the arming registers its disarm so a stopping daemon leaves no timer behind, and the three routes come
 * back as the module's own contribution.
 */

/** A repeating timer the test drives: what was armed, at what interval, and whether it was cancelled. */
function timers() {
  const armed: { readonly intervalMs: number; readonly tick: () => void; cancelled: number }[] = [];
  return {
    armed,
    every: (intervalMs: number, tick: () => void) => {
      const timer = { intervalMs, tick, cancelled: 0 };
      armed.push(timer);
      return () => {
        timer.cancelled += 1;
      };
    },
  };
}

describe('the session-handover module build', () => {
  test('should contribute the three handover routes and register no release while building', () => {
    // Arrange
    const releases: string[] = [];

    // Act
    const built = sessionHandoverModule.build(sessionHandoverNeedsForTest(), undefined, {
      onRelease: label => void releases.push(label),
    });

    // Assert
    expect(built.id).toBe('sessionHandover');
    expect(releases).toEqual([]);
    expect(built.contributes.routes.map(route => `${route.method} ${route.path}`)).toEqual([
      'POST /v1/ferrets/:ferretId/handover',
      'GET /v1/ferrets/:ferretId/handover',
      'POST /v1/ferrets/:ferretId/handover/cancel',
    ]);
  });

  test('should create no timer while building, and hand the loop to the arming job unarmed', () => {
    // Arrange
    const clock = timers();

    // Act
    const built = sessionHandoverModule.build(sessionHandoverNeedsForTest({ every: clock.every }), undefined, {
      onRelease: () => undefined,
    });

    // Assert
    expect(clock.armed).toEqual([]);
    expect(typeof built.jobs.arm).toBe('function');
    expect(built.provides.reconcile).toBeDefined();
    expect(built.provides.handover).toBeDefined();
  });

  test('should arm the loop on the injected timer and cancel every timer when the daemon stops', async () => {
    // Arrange
    const clock = timers();
    const releases: Array<() => void | Promise<void>> = [];
    const built = sessionHandoverModule.build(sessionHandoverNeedsForTest({ every: clock.every }), undefined, {
      onRelease: (_label, release) => void releases.push(release),
    });

    // Act
    const disarm = built.jobs.arm();
    await new Promise<void>(resolve => queueMicrotask(resolve));

    // Assert — the boot sweep found nothing open, so only the slow backstop is armed.
    expect(clock.armed.map(timer => timer.cancelled)).toEqual([0]);
    expect(releases).toHaveLength(1);

    // Act — the daemon stops, then the caller disarms as well.
    await releases[0]?.();
    disarm();

    // Assert — each timer was cancelled exactly once: the disarm is idempotent.
    expect(clock.armed.map(timer => timer.cancelled)).toEqual([1]);
  });
});

describe('the session-handover route declarations', () => {
  test('should not audit either POST from the route layer, because the session journal records a handover', async () => {
    // Arrange
    const { default: manifest } = await import('../../../../../manifest.ts');
    const declared = (key: string) => manifest.actions?.routes?.find(route => route.key === key);

    // Assert
    for (const key of ['POST /v1/ferrets/:ferretId/handover', 'POST /v1/ferrets/:ferretId/handover/cancel'])
      expect(declared(key)?.audit).toEqual({ skip: 'drives an existing session; its journal records it' });
  });
});
