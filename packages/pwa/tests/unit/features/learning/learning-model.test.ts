import { describe, expect, it } from 'bun:test';
import {
  basename,
  calendarDay,
  diffLines,
  diffSummary,
  emptyTabSentence,
  estimateNotes,
  estimateParts,
  formatScanUsd,
  initialScanDraft,
  lessonCount,
  lessonSourceLabel,
  lessonsIn,
  lessonTime,
  pickedSentence,
  type ScanDraft,
  scanPercent,
  scanReadingSentence,
  scanResultSentence,
  scopeFromDraft,
  sessionName,
  strengthLabel,
  toggled,
  typeLabel,
} from '../../../../src/features/learning/learning-model.ts';
import { estimate, evidence, lesson, progress } from '../../../support/learning.ts';
import { sessionView } from '../../../support/sessions.ts';

const sessions = new Map([['session-hadi', sessionView('session-hadi', { config: { teammate: 'hadi' } })]]);

describe('learning vocabulary', () => {
  it('sorts a tab newest first and counts it under the source filter', () => {
    const lessons = [
      lesson({ id: 'old', lastSeen: '2026-10-01T00:00:00.000Z', firstSeen: '2026-10-01T00:00:00.000Z' }),
      lesson({ id: 'new', source: 'scan' }),
      lesson({ id: 'done', state: 'applied' }),
    ];
    expect(lessonsIn(lessons, 'pending', 'all').map(entry => entry.id)).toEqual(['new', 'old']);
    expect(lessonsIn(lessons, 'pending', 'passive').map(entry => entry.id)).toEqual(['old']);
    expect(lessonCount(lessons, 'pending', 'scan')).toBe(1);
    expect(lessonCount(lessons, 'applied', 'all')).toBe(1);
    expect(emptyTabSentence('accepted', 'all')).toBe('No accepted lessons.');
    expect(emptyTabSentence('pending', 'scan')).toBe('No to review lessons from scan.');
  });

  it('names chips, sources and sessions from what the hub knows', () => {
    expect(basename('/work/ferretry/')).toBe('ferretry');
    expect(basename('C:\\work\\repo')).toBe('repo');
    expect(basename('/')).toBe('/');
    expect(strengthLabel(9)).toBe('9×');
    expect(typeLabel('global', '/work/x')).toBe('Global');
    expect(typeLabel('repo', '/work/x')).toBe('Repo · x');
    expect(typeLabel('repo', undefined)).toBe('Repo');
    expect(sessionName('session-hadi', sessions)).toBe('Hadi');
    expect(sessionName('session-unknown-long', sessions, 'kofi')).toBe('Kofi');
    expect(sessionName('session-unknown-long', sessions)).toBe('session-…');
    expect(lessonSourceLabel(lesson({ source: 'scan' }), sessions)).toBe('scan');
    expect(
      lessonSourceLabel(
        lesson({
          evidence: [
            evidence({ observationId: 'later', sessionId: 'other', at: '2026-10-17T00:00:00.000Z' }),
            evidence(),
          ],
        }),
        sessions,
      ),
    ).toBe('passive · Hadi');
    expect(pickedSentence(lesson())).toBe('The ferret picked Repo; you can change it.');
    expect(pickedSentence(lesson({ source: 'scan', suggestedCategory: undefined, category: 'global' }))).toBe(
      'The scan picked Global; you can change it.',
    );
    expect(lessonTime('2026-10-16T09:40:00.000Z', 'UTC')).toBe('2026-10-16 09:40');
    expect(lessonTime('not a time')).toBe('not a time');
  });

  it('reads a unified diff line by line', () => {
    expect(diffLines('--- a\n+++ b\n@@ -1 +1 @@\n ctx\n-gone\n+new\n').map(line => line.kind)).toEqual([
      'meta',
      'meta',
      'hunk',
      'context',
      'remove',
      'add',
    ]);
    expect(diffSummary('+a\n+b\n-c')).toBe('+2 −1');
    expect(diffSummary(' same')).toBe('no change');
  });

  it('turns a draft into a scope, or says what is missing', () => {
    const now = new Date(2026, 9, 16, 12).getTime();
    const draft = initialScanDraft(now);
    expect(draft).toMatchObject({ kind: 'not-passive', from: '2026-10-09', to: '2026-10-16', agent: '', model: '' });
    expect(calendarDay(new Date(2026, 0, 5).getTime())).toBe('2026-01-05');
    expect(scopeFromDraft(draft)).toEqual({ kind: 'not-passive' });
    const range = scopeFromDraft({ ...draft, kind: 'range' });
    expect(typeof range === 'object' && range.kind === 'range' && range.from < range.to).toBe(true);
    expect(scopeFromDraft({ ...draft, kind: 'range', from: '' })).toBe('Pick both days.');
    expect(scopeFromDraft({ ...draft, kind: 'range', from: '2026-10-20' })).toBe(
      'The first day must come before the last.',
    );
    expect(scopeFromDraft({ ...draft, kind: 'projects' })).toBe('Pick at least one project.');
    expect(scopeFromDraft({ ...draft, kind: 'projects', projects: ['/p'] })).toEqual({
      kind: 'projects',
      projects: ['/p'],
    });
    expect(scopeFromDraft({ ...draft, kind: 'sessions' })).toBe('Pick at least one ferret.');
    const forFerret: ScanDraft = initialScanDraft(now, { kind: 'sessions', sessionIds: ['s1'] });
    expect(scopeFromDraft(forFerret)).toEqual({ kind: 'sessions', sessionIds: ['s1'] });
    expect(initialScanDraft(now, { kind: 'projects', projects: ['/p'] }).projects).toEqual(['/p']);
    expect(toggled(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggled(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('says what a scan costs without inventing a price', () => {
    expect(estimateParts(estimate())).toEqual(['2 ferrets', '~320K tokens', '~$0.32']);
    expect(estimateParts(estimate({ sessions: 1, usd: undefined }))).toEqual([
      '1 ferret',
      '~320K tokens',
      'cost unknown',
    ]);
    expect(formatScanUsd(0.001)).toBe('<$0.01');
    expect(formatScanUsd(0)).toBe('$0.00');
    expect(estimateNotes(estimate())).toEqual([]);
    expect(estimateNotes(estimate({ skipped: 3, beyondLimit: 5 }))).toEqual([
      '3 skipped: no transcript to read.',
      '5 more beyond this scan’s limit — scan again for them.',
    ]);
  });

  it('says how far a scan is and what it found', () => {
    expect(scanPercent(progress({ total: 0, done: 0 }))).toBe(0);
    expect(scanPercent(progress({ total: 4, done: 1 }))).toBe(25);
    expect(scanPercent(progress({ total: 4, done: 9 }))).toBe(100);
    expect(scanReadingSentence(progress({ total: 0 }))).toBe('Starting the scan…');
    expect(scanReadingSentence(progress({ total: 4, done: 4 }))).toBe('Reading ferret 4 of 4…');
    expect(scanResultSentence(progress({ state: 'cancelled' }))).toContain('Scan cancelled');
    expect(scanResultSentence(progress({ state: 'failed', message: 'no login' }))).toBe('The scan failed: no login');
    expect(scanResultSentence(progress({ state: 'failed' }))).toBe('The scan failed.');
    expect(scanResultSentence(progress({ state: 'finished', added: 0, merged: 0 }))).toBe('No new lessons.');
    expect(scanResultSentence(progress({ state: 'finished', added: 1, merged: 2 }))).toBe(
      'Added 1 lesson to To review and merged 2 into existing ones.',
    );
    expect(scanResultSentence(progress({ state: 'finished', added: 3, merged: 0 }))).toBe(
      'Added 3 lessons to To review.',
    );
  });
});
