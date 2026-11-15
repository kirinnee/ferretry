import { describe, expect, it } from 'bun:test';
import { WhatsNewRequests } from '../../../app/lib/whats-new-requests.ts';

describe('the What’s new request line', () => {
  it('holds a request until the panel takes it, and tells every listener on each change', () => {
    const line = new WhatsNewRequests();
    let heard = 0;
    const stop = line.subscribe(() => (heard += 1));
    expect(line.snapshot()).toBe(false);
    line.request();
    expect(line.snapshot()).toBe(true);
    line.take();
    expect(line.snapshot()).toBe(false);
    expect(heard).toBe(2);
    stop();
    line.request();
    expect(heard).toBe(2);
  });
});
