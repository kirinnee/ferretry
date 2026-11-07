import { describe, it } from 'bun:test';
import type { AutoResumeSummary } from '@ferretry/protocol';
import should from 'should';
import { AutoResumeService } from '../../../../src/lib/session/auto-resume/service.ts';
import {
  type AutoResumeCandidate,
  type AutoResumeOutcome,
  type AutoResumePorts,
  type AutoResumeSubject,
  defaultAutoResumeSettings,
} from '../../../../src/lib/session/auto-resume/types.ts';

const NOW = '2026-10-21T12:00:00.000Z';
const SETTINGS = { concurrency: 2, staggerMs: 4_000, maxAgeMs: 24 * 3_600_000 };

function candidate(id: string, status = 'running', at = NOW): AutoResumeCandidate {
  return { id, status, at };
}

class Harness {
  ledger: AutoResumeCandidate[] = [];
  ledgerWrites = 0;
  subjects = new Map<string, AutoResumeSubject>();
  unavailable = new Map<string, string>();
  refused = new Map<string, string>();
  resumed: { id: string; message: string | undefined }[] = [];
  journal: { id: string; outcome: AutoResumeOutcome }[] = [];
  summaries: AutoResumeSummary[] = [];
  sleeps: number[] = [];
  enabled = true;
  summaryFails = false;
  journalFails = false;
  ledgerWriteFails = false;
  availabilityThrows = false;

  ports(): AutoResumePorts {
    return {
      ledger: {
        read: async () => [...this.ledger],
        write: async next => {
          this.ledgerWrites += 1;
          if (this.ledgerWriteFails) throw new Error('disk full');
          this.ledger = [...next];
        },
      },
      roster: {
        subject: async id => {
          if (id === 'unreadable') throw new Error('unreadable');
          return this.subjects.get(id);
        },
      },
      availability: {
        unavailable: async id => {
          if (this.availabilityThrows) throw new Error('inventory unreadable');
          return this.unavailable.get(id);
        },
      },
      resumer: {
        resume: async (id, message) => {
          const refusal = this.refused.get(id);
          if (refusal !== undefined) throw new Error(refusal);
          this.resumed.push({ id, message });
        },
      },
      journal: {
        record: async (id, outcome) => {
          if (this.journalFails) throw new Error('journal closed');
          this.journal.push({ id, outcome });
        },
      },
      summary: {
        write: async summary => {
          if (this.summaryFails) throw new Error('read-only');
          this.summaries.push(summary);
        },
      },
      setting: { enabled: async () => this.enabled },
      clock: { now: () => NOW, nowMs: () => Date.parse(NOW) },
      sleep: async milliseconds => {
        this.sleeps.push(milliseconds);
      },
    };
  }

  service(settings = SETTINGS): AutoResumeService {
    return new AutoResumeService(this.ports(), settings);
  }

  fail(id: string, mode: 'auto' | 'interactive' = 'auto'): void {
    this.subjects.set(id, { status: 'failed', mode });
  }
}

describe('auto-resume service', () => {
  it('should ship a default of two at a time, a few seconds apart', () => {
    should(defaultAutoResumeSettings.concurrency).equal(2);
    should(defaultAutoResumeSettings.staggerMs).be.within(2_000, 10_000);
  });

  it('should record found sessions once each, replacing an older entry for the same session', async () => {
    // Arrange
    const h = new Harness();
    h.ledger = [candidate('a', 'waiting'), candidate('b')];

    // Act
    await h.service().record([candidate('a', 'thinking'), candidate('c')]);

    // Assert
    should(h.ledger.map(entry => `${entry.id}:${entry.status}`)).deepEqual(['b:running', 'a:thinking', 'c:running']);
  });

  it('should write nothing when nothing was found', async () => {
    const h = new Harness();
    await h.service().record([]);
    should(h.ledgerWrites).equal(0);
  });

  it('should do nothing when nothing is owed', async () => {
    const h = new Harness();
    should(await h.service().run()).equal(undefined);
    should(h.ledgerWrites).equal(0);
  });

  it('should leave sessions down and clear the ledger when the setting is off', async () => {
    // Arrange
    const h = new Harness();
    h.enabled = false;
    h.ledger = [candidate('a')];
    h.fail('a');

    // Act
    const actual = await h.service().run();

    // Assert
    should(actual).equal(undefined);
    should(h.ledger).deepEqual([]);
    should(h.resumed).deepEqual([]);
    should(h.summaries).deepEqual([]);
  });

  it('should resume a failed session with a notice that fits its mode and turn', async () => {
    // Arrange
    const h = new Harness();
    h.ledger = [candidate('idle-auto', 'awaiting_user'), candidate('idle-chat', 'awaiting_user')];
    h.fail('idle-auto', 'auto');
    h.fail('idle-chat', 'interactive');

    // Act
    const actual = await h.service({ ...SETTINGS, concurrency: 1 }).run();

    // Assert
    should(actual).deepEqual({ at: NOW, resumed: 2, skipped: [] });
    should(h.resumed.find(entry => entry.id === 'idle-auto')?.message).containEql('nothing was interrupted');
    should(h.resumed.find(entry => entry.id === 'idle-chat')?.message).equal(undefined);
    should(h.journal.map(entry => entry.outcome)).deepEqual([
      { kind: 'resumed', notified: true },
      { kind: 'resumed', notified: false },
    ]);
    should(h.ledger).deepEqual([]);
    should(h.summaries).deepEqual([actual as AutoResumeSummary]);
  });

  it('should leave an owner-stopped, finished, revived or deleted session alone', async () => {
    // Arrange
    const h = new Harness();
    h.ledger = [candidate('stopped'), candidate('done'), candidate('back'), candidate('gone'), candidate('unreadable')];
    h.subjects.set('stopped', { status: 'stopped', mode: 'auto' });
    h.subjects.set('done', { status: 'completed', mode: 'auto' });
    h.subjects.set('back', { status: 'running', mode: 'auto' });

    // Act
    const actual = await h.service().run();

    // Assert
    should(actual).equal(undefined);
    should(h.resumed).deepEqual([]);
    should(h.journal).deepEqual([]);
    should(h.ledger).deepEqual([]);
  });

  it('should skip a session whose runtime or login cannot serve, and say why', async () => {
    // Arrange
    const h = new Harness();
    h.ledger = [candidate('ok'), candidate('nologin')];
    h.fail('ok');
    h.fail('nologin');
    h.unavailable.set('nologin', 'the claude-work login has expired');

    // Act
    const actual = await h.service({ ...SETTINGS, concurrency: 1 }).run();

    // Assert
    should(actual).deepEqual({
      at: NOW,
      resumed: 1,
      skipped: [{ sessionId: 'nologin', reason: 'the claude-work login has expired' }],
    });
    should(h.resumed.map(entry => entry.id)).deepEqual(['ok']);
    should(h.journal.at(-1)).deepEqual({
      id: 'nologin',
      outcome: { kind: 'skipped', reason: 'the claude-work login has expired' },
    });
  });

  it('should skip with the reason when availability cannot be read at all', async () => {
    const h = new Harness();
    h.ledger = [candidate('a')];
    h.fail('a');
    h.availabilityThrows = true;

    const actual = await h.service().run();

    should(actual?.skipped).deepEqual([{ sessionId: 'a', reason: 'inventory unreadable' }]);
  });

  it('should skip with the revive refusal when the revive itself fails', async () => {
    const h = new Harness();
    h.ledger = [candidate('a')];
    h.fail('a');
    h.refused.set('a', 'the previous terminal shutdown was not confirmed');

    const actual = await h.service().run();

    should(actual).deepEqual({
      at: NOW,
      resumed: 0,
      skipped: [{ sessionId: 'a', reason: 'the previous terminal shutdown was not confirmed' }],
    });
  });

  it('should skip with the text of a non-error refusal', async () => {
    const h = new Harness();
    h.ledger = [candidate('a')];
    h.fail('a');
    const ports = h.ports();
    const service = new AutoResumeService(
      {
        ...ports,
        resumer: {
          resume: async () => {
            throw 'plain refusal';
          },
        },
      },
      SETTINGS,
    );

    const actual = await service.run();

    should(actual?.skipped).deepEqual([{ sessionId: 'a', reason: 'plain refusal' }]);
  });

  it('should revive two at a time, a few seconds apart', async () => {
    // Arrange
    const h = new Harness();
    const ids = ['a', 'b', 'c', 'd', 'e'];
    h.ledger = ids.map(id => candidate(id));
    for (const id of ids) h.fail(id);

    // Act
    const actual = await h.service().run();

    // Assert
    should(actual?.resumed).equal(5);
    // The second worker starts one stagger after the first; each waits a stagger between its own.
    should(h.sleeps.filter(ms => ms === 4_000).length).equal(1 + 3);
    should(h.resumed.map(entry => entry.id).sort()).deepEqual(ids);
  });

  it('should never start more workers than there are sessions', async () => {
    const h = new Harness();
    h.ledger = [candidate('a')];
    h.fail('a');

    await h.service().run();

    should(h.sleeps).deepEqual([]);
  });

  it('should not retry stale entries and should forget them', async () => {
    const h = new Harness();
    h.ledger = [candidate('ancient', 'running', '2026-10-01T00:00:00.000Z'), candidate('fresh')];
    h.fail('ancient');
    h.fail('fresh');

    const actual = await h.service().run();

    should(actual?.resumed).equal(1);
    should(h.resumed.map(entry => entry.id)).deepEqual(['fresh']);
    should(h.ledger).deepEqual([]);
  });

  it('should keep what is still owed in the ledger so a second outage mid-pass loses nothing', async () => {
    // Arrange
    const h = new Harness();
    h.ledger = [candidate('a'), candidate('b'), candidate('c')];
    for (const id of ['a', 'b', 'c']) h.fail(id);
    const ports = h.ports();
    let calls = 0;
    const dying = new AutoResumeService(
      {
        ...ports,
        resumer: {
          resume: async (id, message) => {
            calls += 1;
            if (calls === 2) throw new Error('host went down again');
            await ports.resumer.resume(id, message);
          },
        },
        sleep: async () => {
          if (calls >= 2) throw new Error('process killed');
        },
      },
      { ...SETTINGS, concurrency: 1 },
    );

    // Act
    await dying.run().catch(() => undefined);

    // Assert: the entry that was in flight and the one after it are still owed
    should(h.ledger.map(entry => entry.id)).not.containEql('a');
    should(h.ledger.length).be.aboveOrEqual(1);
  });

  it('should still answer when the summary, journal or ledger cannot be written', async () => {
    const h = new Harness();
    h.ledger = [candidate('a')];
    h.fail('a');
    h.summaryFails = true;
    h.journalFails = true;
    h.ledgerWriteFails = true;

    const actual = await h.service().run();

    should(actual?.resumed).equal(1);
  });
});
