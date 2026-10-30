/**
 * Run as its own process by `happy-dom-gc.test.ts`: registers the unit tier's happy-dom (with its
 * MutationObserver patch), forces a full collection between two attribute changes, and prints how many
 * deliveries the observer heard. A synchronous `Bun.gc(true)` may only run in a process a test can
 * kill — never in the shared test runner (docs/standards/testing).
 */
import '../../support/dom.ts';

const ATTRIBUTE = 'data-mutation-observer-probe';
let deliveries = 0;
const observer = new MutationObserver(() => {
  deliveries += 1;
});
observer.observe(document.documentElement, { attributes: true, attributeFilter: [ATTRIBUTE] });
document.documentElement.setAttribute(ATTRIBUTE, 'first');
await new Promise<void>(resolve => setTimeout(resolve, 0));
const beforeCollection = deliveries;
Bun.gc(true);
document.documentElement.setAttribute(ATTRIBUTE, 'second');
await new Promise<void>(resolve => setTimeout(resolve, 0));
observer.disconnect();
console.log(JSON.stringify({ beforeCollection, afterCollection: deliveries }));
process.exit(0);
