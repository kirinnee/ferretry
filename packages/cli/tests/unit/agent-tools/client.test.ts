import { describe, it } from 'bun:test';
import type { z } from 'zod';
import should from 'should';
import { AgentToolsClient, AgentToolsCommandError } from '../../../src/lib/agent-tools/client';

interface Sent {
  readonly path: string;
  readonly init: RequestInit | undefined;
  readonly timeoutMs: number | undefined;
}

/** Records every request and answers each from a queue, parsed by the schema the client passed. */
function gateway(answers: unknown[] = []) {
  const sent: Sent[] = [];
  return {
    sent,
    request: async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit, timeoutMs?: number): Promise<T> => {
      sent.push({ path, init, timeoutMs });
      return schema.parse(answers.shift() ?? { summary: 'ok' });
    },
  };
}

const headers = (sent: Sent | undefined): Record<string, string> =>
  Object.fromEntries(new Headers(sent?.init?.headers).entries());

describe('AgentToolsClient', () => {
  it('should act as the agent session it runs inside, presenting that session’s credential', async () => {
    // Arrange
    const port = gateway();
    const client = new AgentToolsClient(port, { capability: 'cap-1', ownSessionId: 's1' });

    // Act
    await client.call({ tool: 'terminal.send', name: 'dev', text: 'ls' });

    // Assert
    should(port.sent[0]).match({ path: '/v1/agent/tools', timeoutMs: 60_000, init: { method: 'POST' } });
    should(JSON.parse(String(port.sent[0]?.init?.body))).deepEqual({ tool: 'terminal.send', name: 'dev', text: 'ls' });
    should(headers(port.sent[0])).deepEqual({ 'content-type': 'application/json', 'x-fy-session-capability': 'cap-1' });
  });

  it('should refuse to act as an agent with no credential, naming the way out', async () => {
    const client = new AgentToolsClient(gateway(), { capability: '  ' });
    const error = await client.call({ tool: 'terminal.list' }).catch((failure: unknown) => failure);
    should(error).be.instanceOf(AgentToolsCommandError);
    should((error as Error).message).containEql('pass --session <id>');
  });

  it('should act as a person on a named session, identifying itself and the pane it runs in', async () => {
    // Arrange
    const port = gateway();
    const inPane = new AgentToolsClient(port, { ownSessionId: 's2' });
    const outside = new AgentToolsClient(port, {});

    // Act
    await inPane.call({ tool: 'terminal.list' }, 'a/b');
    await outside.call({ tool: 'browser.list' }, 's1');

    // Assert
    should(port.sent.map(sent => sent.path)).deepEqual([
      '/v1/sessions/a%2Fb/surfaces/terminals/tools',
      '/v1/sessions/s1/surfaces/browser/tools',
    ]);
    should(headers(port.sent[0])).deepEqual({
      'content-type': 'application/json',
      'x-ferretry-client': 'cli',
      'x-ferretry-session-id': 's2',
    });
    should(headers(port.sent[1])).deepEqual({ 'content-type': 'application/json', 'x-ferretry-client': 'cli' });
  });

  it('should wait in slices the daemon can hold open, stopping when the condition is met', async () => {
    // Arrange
    const port = gateway([
      { summary: 'still', matched: false },
      { summary: 'done', matched: true },
    ]);
    const client = new AgentToolsClient(port, { capability: 'cap-1' });

    // Act
    const result = await client.wait({ name: 'dev', exit: true, totalMs: 60_000 });

    // Assert
    should(result).deepEqual({ summary: 'done', matched: true });
    should(port.sent.map(sent => JSON.parse(String(sent.init?.body)))).deepEqual([
      { tool: 'terminal.wait', name: 'dev', exit: true, timeoutMs: 25_000 },
      { tool: 'terminal.wait', name: 'dev', exit: true, timeoutMs: 25_000 },
    ]);
  });

  it('should give up when the total budget is spent, and never ask for less than the daemon accepts', async () => {
    // Arrange
    const port = gateway([
      { summary: 'still', matched: false },
      { summary: 'still', matched: false },
    ]);
    const client = new AgentToolsClient(port, {});

    // Act
    const result = await client.wait({ name: 'dev', text: 'ready', totalMs: 25_050 }, 's1');

    // Assert
    should(result.matched).be.false();
    should(port.sent.map(sent => JSON.parse(String(sent.init?.body)).timeoutMs)).deepEqual([25_000, 100]);
    should(port.sent.map(sent => sent.path)).deepEqual([
      '/v1/sessions/s1/surfaces/terminals/tools',
      '/v1/sessions/s1/surfaces/terminals/tools',
    ]);
  });

  it('should take over, hand back and read control state on a person’s routes', async () => {
    // Arrange
    const view = { sessionId: 's1', driving: [], takeovers: [] };
    const port = gateway([view, view, view]);
    const client = new AgentToolsClient(port, {});

    // Act
    await client.control('terminal', 'takeover', 'dev', 's1');
    await client.control('browser', 'handback', 'app', 's1');
    await client.view('s1');

    // Assert
    should(port.sent.map(sent => [sent.init?.method, sent.path])).deepEqual([
      ['POST', '/v1/sessions/s1/surfaces/terminals/control'],
      ['POST', '/v1/sessions/s1/surfaces/browser/control'],
      ['GET', '/v1/sessions/s1/surfaces/control'],
    ]);
    should(JSON.parse(String(port.sent[1]?.init?.body))).deepEqual({ action: 'handback', key: 'app' });
  });
});
