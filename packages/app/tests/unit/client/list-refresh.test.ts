import { describe, expect, it } from 'bun:test';
import { ListRefresh, LIST_REFRESH_MIN_MS } from '../../../src/client/list-refresh.ts';
import { listClock, listDeferred } from '../../support/list-refresh.ts';

describe('ListRefresh', () => {
  it('joins every concurrent caller and coalesces the cooldown into one trailing read', async () => {
    // Arrange
    const clock = listClock();
    let reads = 0;
    const pending = listDeferred<number>();
    const subject = new ListRefresh(
      () => (++reads === 1 ? pending.promise : Promise.resolve(reads)),
      clock.environment,
    );
    // Act
    const first = subject.request();
    for (let index = 0; index < 20; index += 1) expect(subject.request()).toBe(first);
    pending.resolve(1);
    await first;
    const trailing = subject.request();
    for (let index = 0; index < 50; index += 1) expect(subject.request()).toBe(trailing);
    await clock.advance(LIST_REFRESH_MIN_MS - 1);
    // Assert
    expect(reads).toBe(1);
    await clock.advance(1);
    expect(await trailing).toBe(2);
    expect(reads).toBe(2);
    subject.stop();
  });

  it('preserves an event during a slow read, without overlapping requests', async () => {
    // Arrange
    const clock = listClock();
    const pending = listDeferred<number>();
    let reads = 0;
    const subject = new ListRefresh(
      () => (++reads === 1 ? pending.promise : Promise.resolve(reads)),
      clock.environment,
    );
    const first = subject.request();
    // Act
    expect(subject.invalidate()).toBe(first);
    await clock.advance(20_000);
    expect(reads).toBe(1);
    pending.resolve(1);
    await first;
    // Assert
    expect(reads).toBe(2);
    await clock.advance(LIST_REFRESH_MIN_MS);
    expect(reads).toBe(2);
    subject.stop();
  });

  it('cancels a queued read when unpaired and never runs a dirty continuation after stop', async () => {
    // Arrange
    const clock = listClock();
    const subject = new ListRefresh(async () => 1, clock.environment);
    await subject.request();
    const queued = subject.request();
    // Act
    subject.stop();
    await expect(queued).rejects.toThrow('cleared');
    await expect(subject.request()).rejects.toThrow('cleared');
    expect(clock.pending()).toBe(0);
    const pending = listDeferred<number>();
    const active = new ListRefresh(() => pending.promise, clock.environment);
    const read = active.invalidate();
    active.invalidate();
    active.stop();
    pending.resolve(2);
    // Assert
    expect(await read).toBe(2);
    expect(clock.pending()).toBe(0);
  });

  it('rate limits retries after a rejection, including a synchronous port failure', async () => {
    // Arrange
    const clock = listClock();
    let reads = 0;
    const subject = new ListRefresh<number>(() => {
      reads += 1;
      throw new Error('offline');
    }, clock.environment);
    // Act
    await expect(subject.request()).rejects.toThrow('offline');
    const retry = subject.invalidate();
    await clock.advance(LIST_REFRESH_MIN_MS);
    // Assert
    await expect(retry).rejects.toThrow('offline');
    expect(reads).toBe(2);
    subject.stop();
  });

  it('uses the browser clock and cancellable timer by default', async () => {
    // Arrange
    const subject = new ListRefresh(async () => 1);
    await subject.request();
    // Act
    const queued = subject.request();
    subject.stop();
    // Assert
    await expect(queued).rejects.toThrow('cleared');
  });
});
