import { describe, expect, test } from 'bun:test';
import { ok } from '@ferretry/std';
import { ConversationLeaseStore } from '../../../../contract/conversation-lease.ts';
import { type FerretRecord, type LaunchSpec, PERSON_ORIGIN, type RunSpec } from '../../../../contract/index.ts';
import { emptyChildEnvironment, FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import type { FerretLaunchLeases } from '../../../../daemon/lib/ferrets/launch-leases.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import {
  ConversationLeases,
  registryLeaseSessions,
} from '../../../../daemon/lib/session/lifecycle/conversation-leases.ts';
import { MemoryLeaseDisk } from '../../../support/daemon/memory-lease-disk.ts';
import { additivesFixture } from './additives-fixture.ts';

/**
 * PIN (C58 H5 U6a): the exact order of everything one launch does around its conversation lease, and of the stop that
 * frees it. ONE log records every port a launch touches and each test asserts the WHOLE sequence, so a lease claim that
 * slips after the harness is asked, a move onto the pane that slips after the ferret is saved `working`, or a release
 * that slips ahead of the stop's own writes fails here. Written against the base before the lease check moves into a
 * guard list (U6b): the order is the security property (one writer per conversation), not an implementation detail.
 *
 * The pane's media folder and question file are deliberately NOT in the log: their source moves in U6c, their place in
 * the launch does not, and the real-daemon parity test (`tests/unit/parity/jobs.test.ts`) pins both end to end.
 */

const NOW = new Date('2026-11-16T10:00:00.000Z');
const OLD = 'conv-old';

class OrderRunner extends FakeRunner {
  constructor(private readonly log: string[]) {
    super();
  }
  override async start(spec: RunSpec) {
    this.log.push('runner.start');
    return await super.start(spec);
  }
  override async stop(...args: Parameters<FakeRunner['stop']>) {
    this.log.push('runner.stop');
    await super.stop(...args);
  }
}

class OrderHarness extends FakeHarness {
  constructor(private readonly log: string[]) {
    super();
  }
  override async prepareHome(spec: LaunchSpec) {
    this.log.push('harness.prepareHome');
    return await super.prepareHome(spec);
  }
  override async start(...args: Parameters<FakeHarness['start']>) {
    this.log.push('harness.start');
    return await super.start(...args);
  }
  override async resume(...args: Parameters<FakeHarness['resume']>) {
    this.log.push(`harness.resume(${args[3]})`);
    return await super.resume(...args);
  }
}

function built(options: { readonly empty?: boolean; readonly resumable?: boolean } = {}) {
  const log: string[] = [];
  const base = additivesFixture({ ...(options.empty === true ? { empty: true } : {}) });
  if (options.resumable === true)
    base.registry.put({ ...(base.registry.get(base.id) as FerretRecord), harnessConversation: OLD });
  const real = new ConversationLeases(
    new ConversationLeaseStore(new MemoryLeaseDisk(), () => NOW),
    registryLeaseSessions(base.registry, async () => ({ status: 'running' })),
    4000,
  );
  const leases: FerretLaunchLeases = {
    claimConversation: async (ferret, conversation) => {
      log.push(`leases.claimConversation(${conversation})`);
      await real.claimConversation(ferret, conversation);
    },
    moveConversationToPane: async (ferret, conversation, pid) => {
      log.push(`leases.moveConversationToPane(${conversation},${pid})`);
      await real.moveConversationToPane(ferret, conversation, pid);
    },
    release: async ferret => {
      log.push('leases.release');
      await real.release(ferret);
    },
  };
  const runner = new OrderRunner(log);
  const harness = new OrderHarness(log);
  const ports: FerretsPorts = {
    ...base.ports,
    harness: () => harness,
    runner: () => runner,
    leases,
    save: async record => {
      log.push(`save(${record.state})`);
    },
    saveTokens: async () => {
      log.push('saveTokens');
    },
    endWait: async () => {
      log.push('endWait');
    },
    bindFolder: async () =>
      ok({
        insideStateHome: false,
        verify: async () => {
          log.push('bound.verify');
          return ok(undefined);
        },
      }),
    vault: {
      childEnvironment: async () => {
        log.push('vault.childEnvironment');
        return ok(emptyChildEnvironment());
      },
    },
    launchEnvironment: {
      write: async () => {
        log.push('launchEnvironment.write');
      },
    },
    launchSections: {
      write: async () => {
        log.push('launchSections.write');
      },
      forget: async () => {
        log.push('launchSections.forget');
      },
    },
    session: {
      prepare: async () => {
        log.push('session.prepare');
      },
      stamp: async () => {
        log.push('session.stamp');
      },
      carry: async () => {
        log.push('session.carry');
      },
    },
  };
  const service = new FerretsService(base.registry, base.tokens, ports);
  return { ...base, log, service };
}

describe('the order of one launch around its conversation lease', () => {
  test('should claim after the folder check, before the harness, move onto the pane before `working` is saved', async () => {
    // Arrange
    const f = built({ resumable: true });

    // Act
    const resumed = await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });

    // Assert
    expect(resumed.ok).toBe(true);
    expect(f.log).toEqual([
      'save(starting)',
      'session.prepare',
      'session.carry',
      'saveTokens',
      'harness.prepareHome',
      'vault.childEnvironment',
      'launchEnvironment.write',
      'bound.verify',
      'leases.claimConversation(conv-old)',
      'harness.resume(conv-old)',
      'runner.start',
      'leases.moveConversationToPane(conv-old,1001)',
      'launchSections.write',
      'save(working)',
    ]);
  });

  test('should do the same for a start bound to a conversation', async () => {
    // Arrange
    const f = built({ empty: true });

    // Act
    const started = await f.service.start(
      { by: 'owner', folder: '/work', harness: 'claude-code', harnessConversation: 'conv-bound' },
      PERSON_ORIGIN,
    );

    // Assert
    expect(started.ok).toBe(true);
    expect(f.log).toEqual([
      'save(starting)',
      'session.prepare',
      'session.stamp',
      'saveTokens',
      'harness.prepareHome',
      'vault.childEnvironment',
      'launchEnvironment.write',
      'bound.verify',
      'leases.claimConversation(conv-bound)',
      'harness.resume(conv-bound)',
      'runner.start',
      'leases.moveConversationToPane(conv-bound,1001)',
      'launchSections.write',
      'save(working)',
    ]);
  });

  test('should claim nothing for a start with no conversation, and move the one the harness names onto the pane', async () => {
    // Arrange
    const f = built({ empty: true });

    // Act
    const started = await f.service.start({ by: 'owner', folder: '/work', harness: 'claude-code' }, PERSON_ORIGIN);

    // Assert
    expect(started.ok).toBe(true);
    expect(f.log).toEqual([
      'save(starting)',
      'session.prepare',
      'session.stamp',
      'saveTokens',
      'harness.prepareHome',
      'vault.childEnvironment',
      'launchEnvironment.write',
      'bound.verify',
      'harness.start',
      'runner.start',
      'leases.moveConversationToPane(conv-fern,1001)',
      'launchSections.write',
      'save(working)',
    ]);
  });
});

describe('the order of the stop that frees the lease', () => {
  test('should save the ferret stopped and end its wait BEFORE the lease is released', async () => {
    // Arrange
    const f = built({ empty: true });
    await f.service.start({ by: 'owner', folder: '/work', harness: 'claude-code' }, PERSON_ORIGIN);
    f.log.length = 0;

    // Act
    await f.service.stop(f.id, 'now');

    // Assert
    expect(f.log).toEqual(['runner.stop', 'saveTokens', 'save(stopped)', 'endWait', 'leases.release']);
  });
});
