import { afterEach, beforeEach } from 'bun:test';
import { unitClock } from '../../../daemon/tests/support/unit-clock.ts';

/**
 * A TEST LEAVES NOTHING BEHIND. Preloaded by `bunfig.unit.toml` after `unit-determinism.ts`.
 *
 * `bun test` runs the 447 files of the `pwa-features` group in ONE process, and happy-dom's `document`
 * is process-wide. A screen one test mounts and never unmounts stays in `document.body` for every later
 * file, which then reads someone else's alert ("Could not verify the agenda") through a whole-page
 * query and fails far from its cause (#1209). This guard stops that at the source, in two steps, after
 * every test and after the file's own `afterEach` hooks:
 *
 * 1. CLEAN UP. Every root that `mount` (dom.ts) or `render` (react.ts) made and the test did not
 *    unmount is unmounted inside `act`, so the effects, intervals and portals it started stop with it.
 *    A test that forgets `unmount()` therefore costs the next file nothing.
 * 2. FAIL WHAT SURVIVES, in a group with `"leakGuard": true` in config/test-groups.json (scripts/ci/test.sh
 *    then sets FY_DOM_LEAK_GUARD=enforce; a group not yet cleaned of leaks only gets step 1). A test fails, naming itself, when it still leaves
 *    - nodes in `document.body` (a node the test appended by hand, a portal nothing owns), or
 *    - a `setInterval` of ours still running on the unit clock (a component that never cleared it keeps
 *      ticking through every later file, which is how the undo toast's 250 ms tick outlived its screen).
 *      A one-shot `setTimeout` is not judged: it fires once and is gone.
 *    The body is swept afterwards either way, so one leak is ONE red test, not a cascade.
 *
 * A running interval is not swept: the unit clock rebases it onto the next test, and what it would do
 * there is the thing worth failing for.
 */

let intervalsBefore: readonly string[] = [];

/** The intervals `after` runs beyond what `before` already ran, matched by where they were set. */
const newIntervals = (before: readonly string[], after: readonly string[]): string[] => {
  const remaining = [...before];
  return after.filter(site => {
    const index = remaining.indexOf(site);
    if (index === -1) return true;
    remaining.splice(index, 1);
    return false;
  });
};

const describeNode = (node: Element): string => {
  const markup = node.outerHTML.replace(/\s+/gu, ' ');
  return markup.length > 160 ? `${markup.slice(0, 160)}…` : markup;
};

beforeEach(() => {
  intervalsBefore = unitClock.ownIntervals;
});

afterEach(async () => {
  const live = (globalThis as { __ferretryLiveMounts?: Set<() => Promise<void>> }).__ferretryLiveMounts;
  for (const unmount of [...(live ?? [])]) await unmount();

  const leaked = typeof document === 'undefined' ? [] : [...document.body.children];
  const intervals = newIntervals(intervalsBefore, unitClock.ownIntervals);
  if (typeof document !== 'undefined') document.body.replaceChildren();

  if (process.env.FY_DOM_LEAK_GUARD !== 'enforce') return;
  if (leaked.length === 0 && intervals.length === 0) return;

  const problems = [
    leaked.length > 0
      ? `${leaked.length} node(s) left in document.body (remove what the test appends, in an afterEach): ${leaked.map(describeNode).join(' | ')}`
      : '',
    intervals.length > 0
      ? `${intervals.length} interval(s) still running on the unit clock (clear it when the component unmounts): ${intervals.join(' | ')}`
      : '',
  ].filter(problem => problem !== '');

  throw new Error(
    `this test leaked into the shared process: ${problems.join('; ')}. (packages/pwa/tests/support/dom-leak-guard.ts)`,
  );
});
