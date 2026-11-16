import { expect, test } from 'bun:test';
import { lookAtPaneProcesses } from '../../../../../daemon/lib/session/observer/liveness.ts';
import type { PaneProcess } from '../../../../../daemon/lib/session/peers/warden.ts';

const processes: readonly PaneProcess[] = [{ pid: 10, argv: 'sleep 30' }];

test('a pane whose process tree could not be observed adds no evidence either way', () => {
  expect(lookAtPaneProcesses(undefined, () => ({ toolCommand: true, leftoverBrowser: true }))).toEqual({});
});

test('a running tool command is kept with its key, and a leftover browser is kept when there is one', () => {
  const seen: (readonly PaneProcess[])[] = [];
  const look = lookAtPaneProcesses(processes, observed => {
    seen.push(observed);
    return { toolCommand: true, commandKey: 'sleep:10', leftoverBrowser: true };
  });
  expect(look).toEqual({ children: true, commandKey: 'sleep:10', leftoverBrowser: true });
  expect(seen).toEqual([processes]);
});

test('an idle pane says no tool command runs, with no key and no browser', () => {
  expect(lookAtPaneProcesses(processes, () => ({ toolCommand: false, leftoverBrowser: false }))).toEqual({
    children: false,
  });
});
