/**
 * Browser half of the reproducible Tasks-pane benchmark.
 *
 * The Bun controller builds this exact entry twice: once in the current tree and
 * once inside an archive of the historical tree. Both bundles therefore mount
 * their tree's real SessionSearchProvider and SessionTasksSearchSurface. The
 * controller owns the deterministic loopback daemon and request ledger; this
 * page owns only React paint observations and bounded DOM interactions.
 */

import { createRoot, type Root } from 'react-dom/client';
import { SessionSearchProvider, SessionTasksSearchSurface } from '../src/features/session-search/session-search.tsx';
import { daemonConnection } from '../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../src/lib/daemon-scope.ts';

const ROOT_ID = 'tasks-pane-benchmark-root';
const DEVICE_TOKEN = 'tasks-pane-benchmark-token';
const WAIT_TIMEOUT_MS = 10_000;

interface MountOptions {
  readonly sessionId: string;
  readonly expectedTaskIds?: readonly string[];
  readonly unavailable?: boolean;
}

interface MountResult {
  readonly elapsedMs: number;
  readonly taskIds: readonly string[];
  readonly text: string;
}

interface QueryResult {
  readonly elapsedMs: number;
  readonly taskIds: readonly string[];
}

interface SurfaceSnapshot {
  readonly taskIds: readonly string[];
  readonly text: string;
  readonly taskFilterUnavailable: boolean;
  readonly coveragePartial: boolean;
  readonly skipNote: string | null;
  readonly tasksUnavailable: boolean;
}

export interface TasksPaneBenchmarkApi {
  readonly mount: (options: MountOptions) => Promise<MountResult>;
  readonly query: (value: string, expectedTaskIds: readonly string[]) => Promise<QueryResult>;
  readonly setQuery: (value: string) => number;
  readonly waitForTaskIds: (expectedTaskIds: readonly string[]) => Promise<readonly string[]>;
  readonly waitForSelector: (selector: string) => Promise<number>;
  readonly openSearch: () => Promise<void>;
  readonly elapsed: () => number;
  readonly snapshot: () => SurfaceSnapshot;
  readonly unmount: () => void;
}

declare global {
  interface Window {
    __tasksPaneBenchmark: TasksPaneBenchmarkApi;
  }
}

let root: Root | null = null;
let mountedAt = 0;
let fatalError: string | null = null;

const assertBrowserHealthy = (label: string): void => {
  if (fatalError !== null) throw new Error(`browser failure during ${label}: ${fatalError}`);
};

const host = (): HTMLElement => {
  const found = document.getElementById(ROOT_ID);
  if (!(found instanceof HTMLElement)) throw new Error(`missing #${ROOT_ID}`);
  return found;
};

const taskIds = (): readonly string[] =>
  Array.from(host().querySelectorAll<HTMLElement>('[data-task-id]'), row => row.dataset.taskId ?? '');

const assertUniqueTaskIds = (ids: readonly string[]): void => {
  if (ids.some(id => id === '')) throw new Error('the Tasks pane painted a row without a task id');
  if (new Set(ids).size !== ids.length) throw new Error(`the Tasks pane painted duplicate task ids: ${ids.join(', ')}`);
};

const sameIds = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && actual.every((id, index) => id === expected[index]);

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = performance.now() + WAIT_TIMEOUT_MS;
  while (true) {
    assertBrowserHealthy(`wait for ${label}`);
    if (predicate()) {
      assertBrowserHealthy(`completed wait for ${label}`);
      return;
    }
    if (performance.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }
};

/** Two paint turns make the timing boundary a presented row, not a React state mutation. */
const afterPaint = async (label: string): Promise<void> => {
  assertBrowserHealthy(`first paint boundary for ${label}`);
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  assertBrowserHealthy(`second paint boundary for ${label}`);
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  assertBrowserHealthy(`completed paint boundary for ${label}`);
};

const setInputValue = (value: string): void => {
  assertBrowserHealthy('query input update');
  const input = host().querySelector<HTMLInputElement>('[data-current-session-search] input');
  if (input === null) throw new Error('the Tasks pane has no current-session search input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter === undefined) throw new Error('this browser has no native input value setter');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  assertBrowserHealthy('query input dispatch');
};

const snapshot = (): SurfaceSnapshot => {
  assertBrowserHealthy('surface snapshot');
  const container = host();
  const ids = taskIds();
  assertUniqueTaskIds(ids);
  return {
    taskIds: ids,
    text: container.textContent ?? '',
    taskFilterUnavailable: container.querySelector('[data-task-filter-unavailable]') !== null,
    coveragePartial: container.querySelector('[data-search-coverage]') !== null,
    skipNote: container.querySelector('[data-search-skips]')?.textContent?.trim() ?? null,
    tasksUnavailable: Array.from(container.querySelectorAll('[role="alert"]')).some(alert =>
      (alert.textContent ?? '').includes('Tasks are unavailable'),
    ),
  };
};

const unmount = (): void => {
  const recordedFailure = fatalError;
  const cleanupFailures: string[] = [];
  try {
    root?.unmount();
  } catch (reason) {
    cleanupFailures.push(`React root: ${String(reason)}`);
  }
  root = null;
  mountedAt = 0;
  const finalFailure = fatalError ?? recordedFailure;
  fatalError = null;
  try {
    host().replaceChildren();
  } catch (reason) {
    cleanupFailures.push(`host: ${String(reason)}`);
  }
  if (finalFailure !== null) cleanupFailures.unshift(`browser: ${finalFailure}`);
  if (cleanupFailures.length > 0) throw new Error(`benchmark unmount failed: ${cleanupFailures.join('; ')}`);
};

const mount = async (options: MountOptions): Promise<MountResult> => {
  if (options.sessionId.trim() === '') throw new Error('sessionId must not be empty');
  if (options.unavailable !== true && options.expectedTaskIds === undefined)
    throw new Error('a normal mount needs expectedTaskIds');
  unmount();

  const connection = daemonConnection({
    daemonId: 'tasks-pane-benchmark-daemon',
    baseUrl: window.location.origin,
    deviceToken: DEVICE_TOKEN,
  });
  const scope = daemonSessionScope(connection, options.sessionId);
  mountedAt = performance.now();
  root = createRoot(host());
  root.render(
    <SessionSearchProvider connection={connection} focusSignal={0} scope={scope}>
      <SessionTasksSearchSurface />
    </SessionSearchProvider>,
  );

  if (options.unavailable === true) {
    await waitFor(() => snapshot().tasksUnavailable, 'the visible Tasks-unavailable state');
  } else {
    const expected = options.expectedTaskIds as readonly string[];
    await waitFor(() => sameIds(taskIds(), expected), `task rows ${expected.join(', ')}`);
  }
  await afterPaint('mounted task rows');
  const state = snapshot();
  if (options.unavailable !== true && !sameIds(state.taskIds, options.expectedTaskIds as readonly string[]))
    throw new Error(`the task rows changed before paint: ${state.taskIds.join(', ')}`);
  if (options.unavailable === true && state.text.includes('No matching tasks'))
    throw new Error('a failed initial task read was presented as an empty match');
  return { elapsedMs: performance.now() - mountedAt, taskIds: state.taskIds, text: state.text };
};

const waitForTaskIds = async (expectedTaskIds: readonly string[]): Promise<readonly string[]> => {
  await waitFor(() => sameIds(taskIds(), expectedTaskIds), `task rows ${expectedTaskIds.join(', ')}`);
  await afterPaint('filtered task rows');
  const ids = taskIds();
  assertUniqueTaskIds(ids);
  if (!sameIds(ids, expectedTaskIds)) throw new Error(`the task rows changed before paint: ${ids.join(', ')}`);
  return ids;
};

const setQuery = (value: string): number => {
  const startedAt = performance.now();
  setInputValue(value);
  return startedAt;
};

const query = async (value: string, expectedTaskIds: readonly string[]): Promise<QueryResult> => {
  const startedAt = setQuery(value);
  const ids = await waitForTaskIds(expectedTaskIds);
  return { elapsedMs: performance.now() - startedAt, taskIds: ids };
};

const waitForSelector = async (selector: string): Promise<number> => {
  const startedAt = performance.now();
  await waitFor(() => host().querySelector(selector) !== null, selector);
  await afterPaint(selector);
  return performance.now() - startedAt;
};

const openSearch = async (): Promise<void> => {
  const input = host().querySelector<HTMLInputElement>('[data-current-session-search] input');
  if (input === null) throw new Error('the Tasks pane has no current-session search input');
  input.focus();
  await waitFor(() => input.getAttribute('aria-expanded') === 'true', 'the search popup to open');
  await afterPaint('open search popup');
};

const elapsed = (): number => {
  assertBrowserHealthy('elapsed-time read');
  return mountedAt === 0 ? 0 : performance.now() - mountedAt;
};

window.addEventListener('error', event => {
  fatalError = event.error instanceof Error ? (event.error.stack ?? event.error.message) : event.message;
});
window.addEventListener('unhandledrejection', event => {
  fatalError = event.reason instanceof Error ? (event.reason.stack ?? event.reason.message) : String(event.reason);
});

window.__tasksPaneBenchmark = {
  mount,
  query,
  setQuery,
  waitForTaskIds,
  waitForSelector,
  openSearch,
  elapsed,
  snapshot,
  unmount,
};
