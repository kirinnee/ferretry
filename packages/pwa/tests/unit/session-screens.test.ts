import { describe, expect, test } from 'bun:test';
import {
  canSubmitComposer,
  composerUsesEnterToSend,
  isTerminalSessionStatus,
  relativeTime,
  sessionNavigation,
  sessionStatusLabel,
  transcriptIsFollowing,
} from '../../src/lib/session-screens.ts';

describe('session screen behavior', () => {
  test('keeps terminal and nonterminal status meaning explicit', () => {
    expect(isTerminalSessionStatus('completed')).toBe(true);
    expect(isTerminalSessionStatus('failed')).toBe(true);
    expect(isTerminalSessionStatus('stopped')).toBe(true);
    expect(isTerminalSessionStatus('running')).toBe(false);
    expect(sessionStatusLabel('awaiting_question')).toBe('awaiting question');
  });

  test('formats relative time for every display range and rejects bad timestamps', () => {
    expect(relativeTime(undefined, 30_000)).toBe('—');
    expect(relativeTime('not-a-date', 30_000)).toBe('—');
    expect(relativeTime(1, 30_000)).toBe('now');
    expect(relativeTime(1_000, 121_000)).toBe('2m ago');
    expect(relativeTime(1_000, 2 * 60 * 60_000 + 1_000)).toBe('2h ago');
    expect(relativeTime(1_000, 2 * 24 * 60 * 60_000 + 1_000)).toBe('2d ago');
  });

  test('never separates daemon identity from navigation or transcript follow state', () => {
    expect(sessionNavigation('daemon-a', 'same-id')).toEqual(['daemon-a', 'same-id']);
    expect(transcriptIsFollowing({ scrollHeight: 500, clientHeight: 200, scrollTop: 276 })).toBe(true);
    expect(transcriptIsFollowing({ scrollHeight: 500, clientHeight: 200, scrollTop: 275 })).toBe(false);
  });

  test('uses keyboard submission only on hardware-desktop confidence', () => {
    expect(composerUsesEnterToSend(true, true)).toBe(true);
    expect(composerUsesEnterToSend(false, true)).toBe(false);
    expect(canSubmitComposer('message', false, false)).toBe(true);
    expect(canSubmitComposer(' ', false, false)).toBe(false);
    expect(canSubmitComposer('message', true, false)).toBe(false);
    expect(canSubmitComposer('message', false, true)).toBe(false);
  });

  test('keeps the rendered components wired to the tested daemon-safe contracts', async () => {
    const [composer, list, details, transcript] = await Promise.all(
      ['composer.tsx', 'session-list.tsx', 'session-details.tsx', 'transcript.tsx'].map(file =>
        Bun.file(new URL(`../../src/components/${file}`, import.meta.url)).text(),
      ),
    );
    expect(composer).toContain('daemonSessionScope(daemon, sessionId)');
    expect(composer).toContain('api.send(sessionId');
    expect(list).toContain('sessionNavigation(daemonId, config.id)');
    expect(details).toContain('<Detail label="Daemon" value={daemonId} />');
    expect(transcript).toContain('data-daemon-id={daemonId}');
    expect(transcript).toContain('transcriptIsFollowing(element)');
  });
});
