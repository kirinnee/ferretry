import { describe, expect, test } from 'bun:test';
import { audit } from '@ferretry/core-gate/contract';
import { sessionForkModule } from '../../../../../daemon/modules/session-fork.ts';
import { sessionForkNeedsForTest } from './fixture.ts';

/**
 * THE `session-fork` MODULE'S BUILD.
 *
 * These pin the things the port onto the kernel could have changed: the module registers no release and no job (the fork
 * holds no timer and no process), the transfer module's ports factory is still CALLED inside the build (the injection
 * survives, and is called at the point the fork always constructed those ports, once), and every value the old call read
 * LATE is still a closure the build never runs (the account resolution, the lifecycle factory and the session view are
 * read per request, never at construction).
 */

describe('the session-fork module build', () => {
  test('should contribute the one fork route and arm nothing', () => {
    // Arrange
    const releases: string[] = [];

    // Act
    const built = sessionForkModule.build(sessionForkNeedsForTest(), undefined, {
      onRelease: label => void releases.push(label),
      releasing: () => false,
    });

    // Assert
    expect(built.id).toBe('sessionFork');
    expect(built.jobs).toEqual({});
    expect(releases).toEqual([]);
    expect(built.contributes.routes.map(route => `${route.method} ${route.path}`)).toEqual([
      'POST /v1/ferrets/:ferretId/fork',
    ]);
  });

  test('should call the injected transfer ports factory once, inside the build, over the ports it was handed', () => {
    // Arrange
    const needs = sessionForkNeedsForTest();
    const asked: unknown[] = [];
    const realPorts = needs.transferPorts;

    // Act
    const built = sessionForkModule.build({
      ...needs,
      transferPorts: parts => {
        asked.push(parts);
        return realPorts(parts);
      },
    });

    // Assert
    expect(built.provides).toBeDefined();
    expect(asked).toEqual([{ state: needs.state, briefs: needs.briefs, attachments: needs.attachmentStore }]);
  });

  test('should read no late value at build: the account resolution, the lifecycle factory and the view stay unread', () => {
    // Arrange
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
      readableHandoffs: () => {
        reads.push('readableHandoffs');
        return [];
      },
    });

    // Act
    sessionForkModule.build(needs);

    // Assert
    expect(reads).toEqual([]);
  });
});

describe('the session-fork route declaration', () => {
  test('should be a person-only operator route, no-store, and audited as a session opened', async () => {
    // Arrange
    const { default: manifest } = await import('../../../../../manifest.ts');

    // Act
    const declared = manifest.actions?.routes?.find(route => route.key === 'POST /v1/ferrets/:ferretId/fork');

    // Assert — a fork's target descends from nothing, so a ferret that could fork would start a parent-less session
    // past its sub-ferret limits (caller: 'person'); it launches a wrapper under the daemon's own privileges (operator).
    expect(declared?.minimum).toBe('operator');
    expect(declared?.caller).toBe('person');
    expect(declared?.noStore).toBe(true);
    expect(declared?.audit).toEqual(audit('session.opened'));
  });
});
