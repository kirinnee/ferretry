import { describe, expect, it } from 'bun:test';
import {
  isOutdated,
  OUTDATED_REQUEST,
  outdatedLabel,
  outdatedSectionWords,
  outdatedViews,
  restartButtonLabel,
  restartSummary,
} from '../../../../src/features/restart-outdated/outdated-model.ts';
import { sessionView } from '../../../support/sessions.ts';

const outdated = (id: string, sections: readonly string[], status = 'running') => ({
  ...sessionView(id, { state: { status: status as never } }),
  outdated: { sections },
});

describe('outdated ferrets', () => {
  it('should call a live ferret with an outdated record outdated, and nothing else', () => {
    expect(isOutdated(outdated('a', ['pack']) as never)).toBe(true);
    expect(isOutdated(sessionView('b'))).toBe(false);
    expect(isOutdated(outdated('c', ['pack'], 'stopped') as never)).toBe(false);
  });

  it('should say which sections changed, in words', () => {
    expect(outdatedSectionWords(outdated('a', ['pack']) as never)).toBe('Pack mode');
    expect(outdatedSectionWords(outdated('a', ['notify', 'pack', 'agenda']) as never)).toBe(
      'notifications, Pack mode and agenda',
    );
    expect(outdatedSectionWords(sessionView('a'))).toBe('');
    expect(outdatedLabel(outdated('a', ['tools']) as never)).toBe(
      'Outdated — restart to load new instructions (tools)',
    );
    expect(outdatedLabel(sessionView('a'))).toBe('Outdated — restart to load new instructions');
  });

  it('should count only the outdated live ferrets, and none while unread', () => {
    const sessions = [
      outdated('a', ['pack']),
      sessionView('b'),
      outdated('c', ['tools'], 'completed'),
      outdated('d', ['notify']),
    ] as never[];
    expect(outdatedViews(sessions).map(view => (view as never as { config: { id: string } }).config.id)).toEqual([
      'a',
      'd',
    ]);
    expect(outdatedViews(null)).toEqual([]);
    const overlay = { restarted: new Set(['a']), queued: new Set(['d']) };
    expect(outdatedViews(sessions, overlay)).toEqual([]);
    expect(outdatedViews(sessions, { restarted: new Set(['a']), queued: new Set<string>() })).toHaveLength(1);
    expect(restartButtonLabel(2)).toBe('Restart outdated (2)');
    expect(OUTDATED_REQUEST).toEqual({ scope: 'outdated' });
  });

  it('should summarise a restart as restarted now and queued', () => {
    const none = { restarted: [], queued: [], skipped: [], failed: [] };
    expect(restartSummary(none)).toBe('Nothing needed restarting.');
    expect(
      restartSummary({
        restarted: [{ id: 'a' }],
        queued: [
          { id: 'b', reason: 'mid-turn' },
          { id: 'c', reason: 'in-flight' },
        ],
        skipped: [],
        failed: [{ id: 'd', reason: 'x' }],
      }),
    ).toBe('1 ferret restarted now, 2 ferrets queued for their next idle moment, 1 restart failed.');
  });
});
