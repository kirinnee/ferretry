import { describe, it } from 'bun:test';
import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import { ok } from '@ferretry/std';
import should from 'should';
import { AccountAutoResumeAvailability } from '../../../../../daemon/adapters/session/auto-resume/account-auto-resume-availability.ts';
import { BootExitRecorder } from '../../../../../daemon/adapters/session/auto-resume/boot-exit-recorder.ts';
import {
  StateAutoResumeLedger,
  StateAutoResumeSummaryStore,
} from '../../../../../daemon/adapters/session/auto-resume/state-auto-resume-ledger.ts';
import { StorageAutoResumeJournal } from '../../../../../daemon/adapters/session/auto-resume/storage-auto-resume-journal.ts';
import { AutoResumeService } from '../../../../../daemon/lib/session/auto-resume/service.ts';
import type { ExitedSessionTransition, SessionExitObservation } from '../../../../../daemon/lib/session/health/exit.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';
import type { SessionExitPort } from '../../../../../daemon/lib/session/health/service.ts';

const NOW = '2026-10-21T12:00:00.000Z';
const ID = '2c8f5f2e-5b53-4a53-9a38-8f2b3d2f6a11';

/** Ferrets' own state documents, in memory, keyed by the declared file's path: what the state adapters stand on. */
function memoryState(): Pick<StatePort, 'read' | 'write' | 'remove'> {
  const files = new Map<string, unknown>();
  return {
    read: async <Shape>(file: StateFileDef<string, Shape>) => ok(files.get(file.path) as Shape | undefined),
    write: async (file, value) => {
      files.set(file.path, structuredClone(value));
    },
    remove: async file => {
      files.delete(file.path);
    },
  };
}

describe('auto-resume availability', () => {
  it('should say yes when the runtime resolves and give the refusal when it does not', async () => {
    // Arrange
    const availability = new AccountAutoResumeAvailability(
      async id => (id === 'none' ? undefined : id),
      async runtime => {
        if (runtime === 'expired') throw new Error('the expired login needs signing in again');
        if (runtime === 'odd') throw 'odd refusal';
      },
    );

    // Act / Assert
    should(await availability.unavailable('fine')).equal(undefined);
    should(await availability.unavailable('expired')).equal('the expired login needs signing in again');
    should(await availability.unavailable('odd')).equal('odd refusal');
    should(await availability.unavailable('none')).equal('its session record names no runtime');
  });
});

describe('auto-resume journal', () => {
  it('should append one event per outcome on the session journal', async () => {
    // Arrange
    const events: { id: string; type: string; data: unknown }[] = [];
    const journal = new StorageAutoResumeJournal({
      append: async (id, type, data) => {
        events.push({ id, type, data });
        return {} as never;
      },
    });

    // Act
    await journal.record(ID, { kind: 'resumed', notified: true });
    await journal.record(ID, { kind: 'skipped', reason: 'login expired' });
    await journal.record('not a session id', { kind: 'resumed', notified: false });

    // Assert
    should(events).deepEqual([
      {
        id: ID,
        type: 'session.auto_resumed',
        data: { reason: 'resumed automatically after the machine restarted', notified: true },
      },
      { id: ID, type: 'session.auto_resume_skipped', data: { reason: "couldn't auto-resume: login expired" } },
    ]);
  });
});

function observation(id: string, status: string, kind: 'gone' | 'exited'): SessionExitObservation {
  return {
    id,
    status,
    registration: {
      daemonId: 'd',
      sessionId: id,
      tmuxSession: `fy-${id}`,
      paneId: '%0',
      pid: 1,
      processStartTicks: 1,
      sessionCreated: 1,
    },
    exit: kind === 'gone' ? { kind: 'gone' } : { kind: 'exited', exitStatus: 1 },
  };
}

describe('boot exit recorder', () => {
  const failed: ExitedSessionTransition = { status: 'failed', health: 'unknown', reason: 'gone' };
  const completed: ExitedSessionTransition = { status: 'completed', health: 'idle', reason: 'done', exitCode: 0 };

  const SURVEY = [{ id: parseSessionId('a'), journalLost: false }];
  /** Every survey the inner port was handed: the recorder must pass the check's own walk through. */
  const surveys: unknown[] = [];

  function recorder(settled: (id: string) => boolean) {
    const inner: SessionExitPort = {
      observe: async survey => {
        surveys.push(survey);
        return [observation('a', 'running', 'gone')];
      },
      settle: async o => settled(o.id),
    };
    return new BootExitRecorder(inner, { now: () => NOW });
  }

  it('should pass observation through to the real port', async () => {
    should(await recorder(() => true).observe(SURVEY)).deepEqual([observation('a', 'running', 'gone')]);
    should(surveys).deepEqual([SURVEY]);
  });

  it('should record only a settled gone failure, with the status it claimed', async () => {
    // Arrange
    const exits = recorder(id => id !== 'lost-race');

    // Act
    await exits.settle(observation('a', 'thinking', 'gone'), failed);
    await exits.settle(observation('lost-race', 'running', 'gone'), failed);
    await exits.settle(observation('crashed', 'running', 'exited'), failed);
    await exits.settle(observation('finished', 'running', 'gone'), completed);

    // Assert
    should(exits.close()).deepEqual([{ id: 'a', status: 'thinking', at: NOW }]);
  });

  it('should stop recording once closed, so a later crash is not mistaken for a reboot', async () => {
    // Arrange
    const exits = recorder(() => true);
    await exits.settle(observation('a', 'running', 'gone'), failed);
    exits.close();

    // Act
    await exits.settle(observation('later', 'running', 'gone'), failed);

    // Assert
    should(exits.close().map(entry => entry.id)).deepEqual(['a']);
  });
});

describe('a host restart, end to end', () => {
  interface Session {
    status: string;
    mode: 'auto' | 'interactive';
    runtime: string;
    pane: boolean;
  }

  /** A fake machine: records say what they said before the power cut; no pane survives it. */
  class Machine {
    readonly sessions = new Map<string, Session>();
    readonly revived: { id: string; message: string | undefined }[] = [];
    readonly events: string[] = [];
    readonly sleeps: number[] = [];
    loggedOut = new Set<string>();

    add(id: string, status: string, mode: 'auto' | 'interactive' = 'auto', runtime = 'claude-work'): void {
      this.sessions.set(id, { status, mode, runtime, pane: false });
    }

    exits(): SessionExitPort {
      const claims = new Set(['running', 'thinking', 'tool_running', 'awaiting_user', 'waiting']);
      return {
        observe: async () =>
          [...this.sessions]
            .filter(([, s]) => claims.has(s.status) && !s.pane)
            .map(([id, s]) => observation(id, s.status, 'gone')),
        settle: async (o, transition) => {
          const session = this.sessions.get(o.id);
          if (session === undefined || session.status !== o.status) return false;
          session.status = transition.status;
          return true;
        },
      };
    }
  }

  it('should bring back what was running, leave stopped work stopped, and say what it could not do', async () => {
    // Arrange
    const machine = new Machine();
    machine.add('mid-turn', 'tool_running');
    machine.add('idle-auto', 'awaiting_user', 'auto');
    machine.add('idle-chat', 'waiting', 'interactive');
    machine.add('logged-out', 'running', 'auto', 'codex-old');
    machine.add('owner-stopped', 'stopped');
    machine.add('finished', 'completed');
    machine.loggedOut.add('codex-old');
    const state = memoryState();
    const ledger = new StateAutoResumeLedger(state);
    const summaryStore = new StateAutoResumeSummaryStore(state);
    const exits = new BootExitRecorder(machine.exits(), { now: () => NOW });
    const service = new AutoResumeService(
      {
        ledger,
        roster: {
          subject: async id => {
            const session = machine.sessions.get(id);
            return session === undefined ? undefined : { status: session.status, mode: session.mode };
          },
        },
        availability: new AccountAutoResumeAvailability(
          async id => machine.sessions.get(id)?.runtime,
          async runtime => {
            if (machine.loggedOut.has(runtime)) throw new Error(`${runtime} needs signing in again`);
          },
        ),
        resumer: {
          resume: async (id, message) => {
            machine.revived.push({ id, message });
            const session = machine.sessions.get(id);
            if (session !== undefined) Object.assign(session, { status: 'running', pane: true });
          },
        },
        journal: new StorageAutoResumeJournal({
          append: async (id, type) => {
            machine.events.push(`${id}:${type}`);
            return {} as never;
          },
        }),
        summary: summaryStore,
        setting: { enabled: async () => true },
        clock: { now: () => NOW, nowMs: () => Date.parse(NOW) },
        sleep: async milliseconds => {
          machine.sleeps.push(milliseconds);
        },
      },
      { concurrency: 2, staggerMs: 4_000, maxAgeMs: 86_400_000 },
    );

    // The first self-check after boot sees every terminal gone and settles the running claims.
    for (const observed of await exits.observe([])) {
      const settled = machine.sessions.get(observed.id);
      if (settled !== undefined)
        await exits.settle(observed, { status: 'failed', health: 'unknown', reason: 'its terminal is gone' });
    }
    await service.record(exits.close());

    // Act: the daemon is serving
    const summary = await service.run();

    // Assert
    const revivedIds = machine.revived.map(entry => entry.id).sort();
    should(revivedIds).deepEqual(['idle-auto', 'idle-chat', 'mid-turn']);
    should(machine.revived.find(entry => entry.id === 'mid-turn')?.message).containEql('restarted mid-turn');
    should(machine.revived.find(entry => entry.id === 'idle-auto')?.message).containEql('nothing was interrupted');
    should(machine.revived.find(entry => entry.id === 'idle-chat')?.message).equal(undefined);
    should(machine.sessions.get('owner-stopped')?.status).equal('stopped');
    should(machine.sessions.get('finished')?.status).equal('completed');
    should(machine.sessions.get('logged-out')?.status).equal('failed');
    should(summary).deepEqual({
      at: NOW,
      resumed: 3,
      skipped: [{ sessionId: 'logged-out', reason: 'codex-old needs signing in again' }],
    });
    should(await summaryStore.read()).deepEqual(summary as NonNullable<typeof summary>);
    should(await ledger.read()).deepEqual([]);
    should(machine.sleeps.length).be.above(0);
  });
});
