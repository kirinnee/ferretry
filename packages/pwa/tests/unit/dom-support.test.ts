import { afterEach, describe, expect, it } from 'bun:test';
import '../support/dom.ts';

const OBSERVED_ATTRIBUTE = 'data-mutation-observer-probe';

afterEach(() => {
  document.documentElement.removeAttribute(OBSERVED_ATTRIBUTE);
});

describe('the happy-dom test environment', () => {
  it('keeps a connected MutationObserver delivering after garbage collection', async () => {
    let deliveries = 0;
    const observer = new MutationObserver(() => {
      deliveries += 1;
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [OBSERVED_ATTRIBUTE],
    });

    try {
      document.documentElement.setAttribute(OBSERVED_ATTRIBUTE, 'first');
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(deliveries).toBe(1);

      // happy-dom 20.11.1 used to collect its orphaned internal delivery
      // closure here even though this observer and its target are still live.
      Bun.gc(true);
      document.documentElement.setAttribute(OBSERVED_ATTRIBUTE, 'second');
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(deliveries).toBe(2);
    } finally {
      observer.disconnect();
    }
  });
});
