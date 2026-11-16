import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AttachmentEntry,
  EMPTY_ATTACHMENTS,
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

  it('should ask only one ferret\'s attachments to detach, optionally only one job\'s', () => {
    const state = [entry('1', 'a', 10, 'j1'), entry('2', 'a', 11, 'j2'), entry('3', 'b', 12, 'j1')].reduce(withEntry, EMPTY_ATTACHMENTS);
    should(withDetaching(state, 'a').entries.map(item => item.detaching)).deepEqual([true, true, false]);
    should(withDetaching(state, 'a', 'j2').entries.map(item => item.detaching)).deepEqual([false, true, false]);
  });

  it('should prove an entry dead by pid and start: a gone pid or a reused one goes, an unreadable one stays', () => {
    const state = [entry('1', 'a', 10), entry('2', 'a', 11), entry('3', 'a', 12), entry('4', 'a', 13)].reduce(withEntry, EMPTY_ATTACHMENTS);
    const now = new Map<number, string | undefined | 'unknown'>([
      [10, 'start-10'], // the same process
      [11, undefined], // gone
      [12, 'start-other'], // the pid was reused
      [13, 'unknown'], // the host could not say
    ]);
    should(withoutStale(state, now).entries.map(item => item.id)).deepEqual(['1', '4']);
  });

  it('should list a ferret\'s entries oldest first', () => {
    const state = [entry('2', 'a', 11), entry('1', 'a', 10), entry('3', 'b', 12)].reduce(withEntry, EMPTY_ATTACHMENTS);
    should(entriesOf(state, 'a').map(item => item.id)).deepEqual(['1', '2']);
  });
});
