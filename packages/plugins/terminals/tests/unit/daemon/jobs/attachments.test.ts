import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AttachmentEntry,
  EMPTY_ATTACHMENTS,
  JOB_MAX_ATTACHMENTS_PER_JOB,
  entriesOf,
  withDetaching,
  withEntry,
  withoutEntry,
  withoutStale,
} from '../../../../daemon/lib/jobs/attachments.ts';

const entry = (id: string, sessionId: string, pid: number, jobId = 'j1'): AttachmentEntry => ({
  id,
  sessionId,
  jobId,
  pid,
  processStart: `start-${pid}`,
  registeredAt: `2026-11-16T00:00:0${id}Z`,
  detaching: false,
});

describe('the attachment registry', () => {
  it('should add, replace by id and remove entries', () => {
    const one = withEntry(EMPTY_ATTACHMENTS, entry('1', 's', 10));
    const again = withEntry(one, { ...entry('1', 's', 10), jobId: 'j2' });
    should(again.entries).have.length(1);
    should(again.entries[0]?.jobId).equal('j2');
    should(withoutEntry(again, '1').entries).deepEqual([]);
  });

  it("should ask only one ferret's attachments to detach, optionally only one job's", () => {
    const state = [entry('1', 'a', 10, 'j1'), entry('2', 'a', 11, 'j2'), entry('3', 'b', 12, 'j1')].reduce(
      withEntry,
      EMPTY_ATTACHMENTS,
    );
    should(withDetaching(state, 'a').entries.map(item => item.detaching)).deepEqual([true, true, false]);
    should(withDetaching(state, 'a', 'j2').entries.map(item => item.detaching)).deepEqual([false, true, false]);
  });

  it('should prove an entry dead by pid and start: a gone pid or a reused one goes, an unreadable one stays', () => {
    const state = [entry('1', 'a', 10), entry('2', 'a', 11), entry('3', 'a', 12), entry('4', 'a', 13)].reduce(
      withEntry,
      EMPTY_ATTACHMENTS,
    );
    const now = new Map<number, string | undefined | 'unknown'>([
      [10, 'start-10'], // the same process
      [11, undefined], // gone
      [12, 'start-other'], // the pid was reused
      [13, 'unknown'], // the host could not say
    ]);
    should(withoutStale(state, now).entries.map(item => item.id)).deepEqual(['1', '4']);
  });

  it("should list a ferret's entries oldest first", () => {
    const state = [entry('2', 'a', 11), entry('1', 'a', 10), entry('3', 'b', 12)].reduce(withEntry, EMPTY_ATTACHMENTS);
    should(entriesOf(state, 'a').map(item => item.id)).deepEqual(['1', '2']);
  });
});

describe('the attachment registry stays bounded', () => {
  it('should keep one entry for the same process attaching to the same job again', () => {
    const state = [entry('1', 's', 10), entry('2', 's', 10), entry('3', 's', 10)].reduce(withEntry, EMPTY_ATTACHMENTS);
    should(state.entries.map(item => item.id)).deepEqual(['3']);
  });

  it('should keep the same pid on another job, and another ferret, apart', () => {
    const state = [entry('1', 's', 10, 'j1'), entry('2', 's', 10, 'j2'), entry('3', 't', 10, 'j1')].reduce(
      withEntry,
      EMPTY_ATTACHMENTS,
    );
    should(state.entries).have.length(3);
  });

  it('should cap a job at its newest attachments, pushing the oldest out', () => {
    const many = Array.from({ length: JOB_MAX_ATTACHMENTS_PER_JOB + 5 }, (_unused, index) => ({
      ...entry('1', 's', 100 + index),
      id: `id-${index}`,
      registeredAt: `2026-11-16T00:00:${String(index).padStart(2, '0')}Z`,
    }));
    const state = many.reduce(withEntry, EMPTY_ATTACHMENTS);
    should(state.entries).have.length(JOB_MAX_ATTACHMENTS_PER_JOB);
    should(state.entries.map(item => item.id)).not.containEql('id-0');
    should(state.entries.map(item => item.id)).containEql(`id-${JOB_MAX_ATTACHMENTS_PER_JOB + 4}`);
  });
});
