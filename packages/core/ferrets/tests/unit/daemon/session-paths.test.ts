import { expect, test } from 'bun:test';
import { createFoundationPaths, createSessionPaths } from '../../../daemon/lib/paths.ts';
import { parseSessionId } from '../../../daemon/lib/session-id.ts';
import { parseAbsoluteHome } from '../../../daemon/lib/state-home.ts';

test('a session keeps every one of its files inside its own directory under the sessions root', () => {
  const foundation = createFoundationPaths(parseAbsoluteHome('/tmp/fy-paths-test-home', 'test'));
  const paths = createSessionPaths(foundation, parseSessionId('ses-1'));
  const directory = `${foundation.sessions}/ses-1`;
  expect(paths).toEqual({
    directory,
    marker: `${directory}/session-version`,
    config: `${directory}/config.json`,
    state: `${directory}/state.json`,
    events: `${directory}/events.jsonl`,
    lastSnapshot: `${directory}/last-snapshot.txt`,
    terminalPane: `${directory}/terminal-pane.json`,
    media: `${directory}/media`,
    questionAsked: `${directory}/question-asked.json`,
  });
});
