import { describe, it } from 'bun:test';
import type { AgentToolResult, SurfaceControlView } from '@ferretry/protocol';
import should from 'should';
import { AgentToolsClient } from '../../../src/lib/agent-tools/client';
import {
  type AgentToolsCommand,
  AgentToolsController,
  renderControlView,
  renderToolResult,
} from '../../../src/lib/agent-tools/controller';

function harness(answers: unknown[] = [], environment = { capability: 'cap-1' }) {
  const said: string[] = [];
  const written: [string, string][] = [];
  const sent: string[] = [];
  let exitCode = 0;
  const port = {
    request: async <T>(path: string, schema: { parse(value: unknown): T }, init?: RequestInit): Promise<T> => {
      sent.push(`${init?.method ?? 'GET'} ${path} ${String(init?.body ?? '')}`);
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return schema.parse(answer ?? { summary: 'ok' });
    },
  };
  const client = new AgentToolsClient({ agent: port, person: port }, environment);
  const controller = new AgentToolsController(
    client,
    {
      success: message => said.push(message),
      warn: message => said.push(`warn: ${message}`),
      error: message => said.push(`error: ${message}`),
      setExitCode: code => {
        exitCode = code;
      },
    },
    { write: async (path, base64) => void written.push([path, base64]) },
  );
  return {
    said,
    written,
    sent,
    exit: () => exitCode,
    run: async (command: AgentToolsCommand) => await controller.run(command),
  };
}

describe('AgentToolsController', () => {
  it('should send a valid call and print what came back', async () => {
    const world = harness([{ summary: 'Opened %terminal:dev.' }]);
    should(await world.run({ kind: 'call', call: { tool: 'terminal.open', name: 'dev' } })).equal(0);
    should(world.said).deepEqual(['Opened %terminal:dev.']);
  });

  it('should refuse an invalid call in the schema’s own words before sending anything', async () => {
    const world = harness();
    should(await world.run({ kind: 'call', call: { tool: 'terminal.open', name: 'Dev' } })).equal(1);
    should(world.said[0]).startWith('error: a name is a lowercase letter');
    should(world.sent).deepEqual([]);
    should(world.exit()).equal(1);
  });

  it('should write a screenshot where it was asked to', async () => {
    const world = harness([{ summary: 'A screenshot of %browser:app.', screenshotBase64: 'iVBORw==' }]);
    await world.run({ kind: 'call', call: { tool: 'browser.screenshot', name: 'app' }, screenshotTo: 'shot.png' });
    should(world.written).deepEqual([['shot.png', 'iVBORw==']]);
    should(world.said).deepEqual(['A screenshot of %browser:app.\nscreenshot written to shot.png']);
  });

  it('should print a screenshot answer as text when no file was named', async () => {
    const world = harness([{ summary: 'A screenshot of %browser:app.', screenshotBase64: 'iVBORw==' }]);
    await world.run({ kind: 'call', call: { tool: 'browser.screenshot', name: 'app' } });
    should(world.written).deepEqual([]);
  });

  it('should exit 1 when a wait times out, and 0 when it is met', async () => {
    const world = harness([
      { summary: 'Still waiting.', matched: false },
      { summary: 'Met.', matched: true },
    ]);
    should(await world.run({ kind: 'wait', wait: { name: 'dev', exit: true, totalMs: 1_000 } })).equal(1);
    should(await world.run({ kind: 'wait', wait: { name: 'dev', text: 'ok', totalMs: 1_000 } })).equal(0);
    should(world.said).deepEqual(['Still waiting.', 'Met.']);
  });

  it('should wait for a page, exiting 1 on a timeout and 0 on a match', async () => {
    const world = harness([
      { summary: 'Not yet.', matched: false },
      { summary: 'There.', matched: true },
    ]);
    const timedOut = await world.run({ kind: 'browser-wait', call: { name: 'app', text: 'Hi' }, totalMs: 1_000 });
    const found = await world.run({ kind: 'browser-wait', call: { name: 'app', text: 'Hi' }, totalMs: 1_000 });
    const none = await world.run({ kind: 'browser-wait', call: { name: 'app' }, totalMs: 1_000 });
    const tooLong = await world.run({ kind: 'browser-wait', call: { name: 'app', text: 'Hi' }, totalMs: 120_001 });

    should([timedOut, found, none, tooLong]).deepEqual([1, 0, 1, 1]);
    should(world.sent).have.length(2);
  });

  it('should refuse a wait budget outside its bounds', async () => {
    const world = harness();
    should(await world.run({ kind: 'wait', wait: { name: 'dev', exit: true, totalMs: 120_001 } })).equal(1);
    should(world.said[0]).equal('error: --timeout must be between 100 and 120000 milliseconds');
  });

  it('should take over and show control state only on a session that was named', async () => {
    // Arrange
    const view: SurfaceControlView = { sessionId: 's1', driving: [], takeovers: [], handed: [], opened: [], asked: [] };
    const world = harness([view, view]);

    // Act
    const unnamed = await world.run({ kind: 'control', surface: 'terminal', action: 'takeover', key: 'dev' });
    const named = await world.run({
      kind: 'control',
      surface: 'terminal',
      action: 'takeover',
      key: 'dev',
      session: 's1',
    });
    const shown = await world.run({ kind: 'view', surface: 'browser', session: 's1' });

    // Assert
    should([unnamed, named, shown]).deepEqual([1, 0, 0]);
    should(world.said[0]).containEql('pass --session <id>');
  });

  it('should report a daemon refusal as itself', async () => {
    const world = harness([new Error('A person has taken over %terminal:dev; wait or ask them.')]);
    await world.run({ kind: 'call', call: { tool: 'terminal.send', name: 'dev', text: 'ls' } });
    should(world.said).deepEqual(['error: A person has taken over %terminal:dev; wait or ask them.']);
  });

  it('should report a thrown non-error as text', async () => {
    const world = harness(['not an object']);
    await world.run({ kind: 'call', call: { tool: 'terminal.list' } });
    should(world.said[0]).startWith('error: ');
  });
});

describe('rendering', () => {
  it('should list surfaces under the summary, then the output', () => {
    const result: AgentToolResult = {
      summary: '2 browser pages: %browser:app, %browser:page-2.',
      surfaces: [
        { id: 'page-1', name: 'app', title: 'App', url: 'http://localhost:5173/' },
        { id: 'page-2', title: '' },
      ],
      output: 'tail',
    };
    should(renderToolResult(result)).equal(
      '2 browser pages: %browser:app, %browser:page-2.\n  app  App  http://localhost:5173/\n  page-2  \ntail',
    );
    should(renderToolResult({ summary: 'Read.', output: '' })).equal('Read.');
  });

  it('should show a popup’s opener and a page that is not the agent’s', () => {
    const result: AgentToolResult = {
      summary: '2 pages.',
      surfaces: [
        { id: 'page-2', title: 'Pay', url: 'https://pay.test/', openerId: 'page-1', available: true },
        { id: 'page-3', title: 'Ad', openerId: 'page-9', available: false },
      ],
    };
    should(renderToolResult(result)).equal(
      '2 pages.\n  page-2  Pay  https://pay.test/  (popup of page-1)\n  page-3  Ad  (popup of page-9)  [not yours]',
    );
  });

  it('should say who drives what and who holds what', () => {
    should(
      renderControlView({
        sessionId: 's1',
        driving: [
          {
            surface: 'terminal',
            id: 'a1b2c3d4e5f6',
            name: 'dev',
            agentSessionId: 's1',
            agentName: 'Hadi',
            since: 'a',
            until: 'b',
          },
          { surface: 'browser', id: 'page-1', agentSessionId: 's1', since: 'a', until: 'c' },
        ],
        takeovers: [
          { surface: 'browser', id: 'page-2', name: 'app', by: { by: 'human', deviceId: 'phone' }, since: 'd' },
          { surface: 'terminal', id: 'a1b2c3d4e5f6', by: { by: 'local' }, since: 'e' },
        ],
        handed: [
          { surface: 'terminal', id: 'b1b2c3d4e5f6', name: 'mine', by: { by: 'local' }, at: 'f' },
          { surface: 'browser', id: 'page-3', by: { by: 'human', deviceId: 'phone' }, at: 'g' },
        ],
      } as unknown as SurfaceControlView),
    ).equal(
      [
        '%terminal:dev  driven by Hadi until b',
        '%browser:page-1  driven by s1 until c',
        '%browser:app  taken over by device phone since d',
        '%terminal:a1b2c3d4e5f6  taken over by this computer since e',
        '%terminal:mine  handed to the agent by this computer',
        '%browser:page-3  handed to the agent by device phone',
      ].join('\n'),
    );
    should(renderControlView({ sessionId: 's1', driving: [], takeovers: [], handed: [], opened: [], asked: [] })).equal(
      'no agent is driving anything in s1, and nothing is taken over',
    );
  });
});
