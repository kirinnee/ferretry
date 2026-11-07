import { describe, expect, test } from 'bun:test';
import type { SessionView } from '../../../contract/index.ts';
import {
  archivedFooterShown,
  archivedFooterWords,
  archivedRows,
  byNewestFinished,
} from '../../../app/shell/sessions-bar-archived.ts';
import { sessionView } from '@ferretry/app/testing';

const at = (minutes: number): string => new Date(Date.UTC(2026, 10, 2, 9, minutes)).toISOString();

/** A finished session, as the archive answers it: over, with the instants that ordered its life. */
const finished = (id: string, endedAt?: string, startedAt?: string): SessionView =>
  sessionView(id, {
    config: { name: `Work ${id}`, cwd: `/work/${id}`, mode: 'auto' },
    state: {
      status: 'completed',
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(endedAt === undefined ? {} : { finishedAt: endedAt }),
    },
  });

describe('archivedFooterWords', () => {
  test('should say how many, with the singular only for one', () => {
    // Arrange
    const input = [1, 2, 23];

    // Act
    const actual = input.map(archivedFooterWords);

    // Assert
    expect(actual).toEqual([
      '1 older finished session archived',
      '2 older finished sessions archived',
      '23 older finished sessions archived',
    ]);
  });
});

describe('archivedFooterShown', () => {
  test('should draw the footer only for a known, non-zero count', () => {
    // Arrange — `null` is both a count never read and a daemon too old to serve one.
    const input: (number | null)[] = [null, 0, 1, 7];

    // Act
    const actual = input.map(archivedFooterShown);

    // Assert
    expect(actual).toEqual([false, false, true, true]);
  });
});

describe('byNewestFinished and archivedRows', () => {
  test('should order by when a session ended, newest first', () => {
    // Arrange
    const input = [finished('older', at(0), at(0)), finished('newer', at(30), at(10))];

    // Act
    const actual = archivedRows(input).map(view => view.config.id);

    // Assert
    expect(actual).toEqual(['newer', 'older']);
  });

  test('should fall back to when a session began when it names no end', () => {
    // Arrange
    const input = [finished('began-later', undefined, at(20)), finished('ended-earlier', at(5), at(0))];

    // Act
    const actual = archivedRows(input).map(view => view.config.id);

    // Assert
    expect(actual).toEqual(['began-later', 'ended-earlier']);
  });

  test('should break a tie by the session id, so the order never shuffles between reads', () => {
    // Arrange
    const input = [finished('b', at(10), at(10)), finished('c', at(10), at(10)), finished('a', at(10), at(10))];

    // Act
    const actual = archivedRows(input).map(view => view.config.id);

    // Assert
    expect(actual).toEqual(['a', 'b', 'c']);
  });

  test('should treat two sessions that name no instant as equal, keeping them by id', () => {
    // Arrange / Act
    const actual = [finished('z'), finished('a')].sort(byNewestFinished).map(view => view.config.id);

    // Assert
    expect(actual).toEqual(['a', 'z']);
  });

  test('should leave the read it was given untouched', () => {
    // Arrange
    const input = [finished('older', at(0), at(0)), finished('newer', at(30), at(10))];

    // Act
    archivedRows(input);

    // Assert
    expect(input.map(view => view.config.id)).toEqual(['older', 'newer']);
  });
});
