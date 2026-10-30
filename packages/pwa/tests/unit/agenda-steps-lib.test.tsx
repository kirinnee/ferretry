import { describe, expect, test } from 'bun:test';
import should from 'should';
import { Markdown } from '../../src/components/markdown.tsx';
import { DaemonAgendaClient } from '../../src/lib/agenda-client.ts';
import { historyLine, tickedSteps } from '../../src/lib/agenda-inbox.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { mount } from '../support/dom.ts';

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });
const scope = daemonSessionScope(daemon, 'same/session');

describe('Markdown with a Copy writer', () => {
  test('wraps every code span and fenced block in a Copy button carrying its own text', async () => {
    const written: string[] = [];
    const view = await mount(
      <Markdown
        copyable={async text => {
          written.push(text);
        }}
        text={'Run `fy secret list` first.\n\n```\nfy relay status\nfy relay status --watch\n```\n'}
      />,
    );
    expect(view.container.querySelectorAll('.md-copy-span').length).toBe(1);
    expect(view.container.querySelectorAll('.md-copy-fence-button').length).toBeGreaterThan(0);
    expect(view.container.textContent).toContain('fy relay status --watch');
    await view.unmount();
  });
});

describe('the attention client', () => {
  test('posts a progress tick and a needs-info request as board actions', async () => {
    const bodies: unknown[] = [];
    const client = new DaemonAgendaClient(undefined, async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          v: 1,
          sessionId: 'same/session',
          items: [],
          resolved: [],
          count: 0,
          parseErrors: 0,
          updatedAt: '2026-07-31T00:00:00.000Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    await client.progress(daemon, scope, 'A8', 2, true);
    await client.needsInfo(daemon, scope, 'A8', 'which key?');
    await client.needsInfo(daemon, scope, 'A8');
    await client.discuss(daemon, scope, 'A8', 'is the premise right?');
    await client.discuss(daemon, scope, 'A8');
    should(bodies).deepEqual([
      { action: 'progress', id: 'A8', step: 2, done: true },
      { action: 'needs-info', id: 'A8', note: 'which key?' },
      { action: 'needs-info', id: 'A8' },
      { action: 'discuss', id: 'A8', note: 'is the premise right?' },
      { action: 'discuss', id: 'A8' },
    ]);
  });
});

describe('steps and history helpers', () => {
  test('lays pending ticks over the confirmed ones, in both directions', () => {
    const item = { steps: ['a', 'b', 'c'], stepsDone: [0, 1] };
    expect(
      [
        ...tickedSteps(
          item,
          new Map([
            [2, true],
            [0, false],
          ]),
        ),
      ].sort(),
    ).toEqual([1, 2]);
    expect([...tickedSteps(item)].sort()).toEqual([0, 1]);
  });

  test('reads the history in local time, asked and updated', () => {
    const line = historyLine(
      [
        { at: '2026-08-01T10:42:00.000Z', kind: 'needs-info' },
        { at: '2026-08-01T10:44:00.000Z', kind: 'updated' },
      ],
      'UTC',
    );
    expect(line).toContain('You asked for more info');
    expect(line).toContain('updated');
    expect(historyLine(undefined)).toBeNull();
    expect(historyLine([])).toBeNull();
  });
});
