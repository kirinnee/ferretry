import { describe, expect, it } from 'bun:test';
import { requestSearchFocus, subscribeSearchFocus } from '../../src/lib/search-focus.ts';

describe('fleet search focus signal', () => {
  it('notifies every mounted control and stops after unsubscribe', () => {
    let first = 0;
    let second = 0;
    const removeFirst = subscribeSearchFocus(() => first++);
    const removeSecond = subscribeSearchFocus(() => second++);

    requestSearchFocus();
    expect([first, second]).toEqual([1, 1]);

    removeFirst();
    requestSearchFocus();
    expect([first, second]).toEqual([1, 2]);

    removeSecond();
    requestSearchFocus();
    expect([first, second]).toEqual([1, 2]);
  });
});
