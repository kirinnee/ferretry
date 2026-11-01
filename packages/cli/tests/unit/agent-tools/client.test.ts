import { describe, it } from 'bun:test';
import should from 'should';
import type { z } from 'zod';
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

/** One recording gateway standing in for both ways to the daemon. */
const both = <T>(port: T) => ({ agent: port, person: port });

const headers = (sent: Sent | undefined): Record<string, string> =>
  Object.fromEntries(new Headers(sent?.init?.headers).entries());

describe('AgentToolsClient', () => {
  it('should act as the agent session it runs inside, presenting that session’s credential', async () => {
    // Arrange
    const port = gateway();
    const client = new AgentToolsClient(both(port), { capability: 'cap-1', ownSessionId: 's1' });

    // Act
    await client.call({ tool: 'terminal.send', name: 'dev', text: 'ls' });

    // Assert
    should(port.sent[0]).match({ path: '/v1/agent/tools', timeoutMs: 60_000, init: { method: 'POST' } });
    should(JSON.parse(String(port.sent[0]?.init?.body))).deepEqual({ tool: 'terminal.send', name: 'dev', text: 'ls' });
    should(headers(port.sent[0])).deepEqual({ 'content-type': 'application/json', 'x-fy-session-capability': 'cap-1' });
  });

  it('should refuse to act as an agent with no credential, naming the way out', async () => {
    const client = new AgentToolsClient(both(gateway()), { capability: '  ' });
    const error = await client.call({ tool: 'terminal.list' }).catch((failure: unknown) => failure);
    should(error).be.instanceOf(AgentToolsCommandError);
    should((error as Error).message).containEql('pass --session <id>');
  });

  it('should act as a person on a named session, identifying itself and the pane it runs in', async () => {
    // Arrange
    const port = gateway();
    const inPane = new AgentToolsClient(both(port), { ownSessionId: 's2' });
    const outside = new AgentToolsClient(both(port), {});

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
    const client = new AgentToolsClient(both(port), { capability: 'cap-1' });

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
    const client = new AgentToolsClient(both(port), {});

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

  it('should wait for a page in slices, stop when it matches, and sleep a time wait only once', async () => {
    // Arrange
    const port = gateway([
      { summary: 'still', matched: false },
      { summary: 'still', matched: false },
      { summary: 'there', matched: true },
      { summary: 'slept' },
    ]);
    const client = new AgentToolsClient(both(port), { capability: 'cap-1' });
    const call = { tool: 'browser.wait_for', name: 'app', text: 'Welcome' } as const;

    // Act
    const found = await client.browserWait({ call, totalMs: 120_000 }, 's1');
    const slept = await client.browserWait({
      call: { tool: 'browser.wait_for', name: 'app', time: 3_000 },
      totalMs: 120_000,
    });

    // Assert
    should(found.matched).be.true();
    should(slept.summary).equal('slept');
    should(port.sent.map(sent => JSON.parse(String(sent.init?.body)))).deepEqual([
      { ...call, timeoutMs: 25_000 },
      { ...call, timeoutMs: 25_000 },
      { ...call, timeoutMs: 25_000 },
      { tool: 'browser.wait_for', name: 'app', time: 3_000 },
    ]);
  });

  it('should give a page wait up after its total budget, whatever the slices', async () => {
    // Arrange
    const port = gateway(Array.from({ length: 8 }, () => ({ summary: 'still', matched: false })));
    const client = new AgentToolsClient(both(port), { capability: 'cap-1' });

    // Act
    const result = await client.browserWait({
      call: { tool: 'browser.wait_for', name: 'app', url: '/done' },
      totalMs: 60_000,
    });

    // Assert
    should(result.matched).be.false();
    should(port.sent.map(sent => JSON.parse(String(sent.init?.body)).timeoutMs)).deepEqual([25_000, 25_000, 10_000]);
  });

  it('should take over, hand back and read control state on a person’s routes', async () => {
    // Arrange
    const view = { sessionId: 's1', driving: [], takeovers: [], handed: [], opened: [], asked: [] };
    const port = gateway([view, view, view, view]);
    const client = new AgentToolsClient(both(port), {});

    // Act
    await client.control('terminal', 'takeover', 'dev', 's1');
    await client.control('browser', 'handback', 'app', 's1');
    await client.view('terminal', 's1');
    await client.view('browser', 's1');

    // Assert
    should(port.sent.map(sent => [sent.init?.method, sent.path])).deepEqual([
      ['POST', '/v1/sessions/s1/surfaces/terminals/control'],
      ['POST', '/v1/sessions/s1/surfaces/browser/control'],
      ['GET', '/v1/sessions/s1/surfaces/terminals/control'],
      ['GET', '/v1/sessions/s1/surfaces/browser/control'],
    ]);
    should(JSON.parse(String(port.sent[1]?.init?.body))).deepEqual({ action: 'handback', key: 'app' });
  });
});

describe('AgentToolsClient — two authorities', () => {
  it('should send an agent call only through the agent gateway, and a person call only through the person one', async () => {
    // Arrange
    const agent = gateway();
    const person = gateway();
    const client = new AgentToolsClient({ agent, person }, { capability: 'cap-1' });

    // Act
    await client.call({ tool: 'terminal.list' });
    await client.call({ tool: 'terminal.list' }, 's1');

    // Assert
    should(agent.sent.map(sent => sent.path)).deepEqual(['/v1/agent/tools']);
    should(person.sent.map(sent => sent.path)).deepEqual(['/v1/sessions/s1/surfaces/terminals/tools']);
  });
});

describe('AgentToolsClient — config tools', () => {
  it('should dial POST /v1/agent/config as the agent, with the session capability and never the person gateway', async () => {
    // Arrange
    const agent = gateway([{ summary: 'Read 1 file.', etag: 'e1' }]);
    const person = gateway();
    const client = new AgentToolsClient({ agent, person }, { capability: 'cap-1', ownSessionId: 's1' });

    // Act
    const result = await client.config({ tool: 'config.write', path: 'voice.yaml', text: '', etag: 'e0' });

    // Assert
    should(result).deepEqual({ summary: 'Read 1 file.', etag: 'e1' });
    should(agent.sent[0]).match({ path: '/v1/agent/config', timeoutMs: 60_000, init: { method: 'POST' } });
    should(JSON.parse(String(agent.sent[0]?.init?.body))).deepEqual({
      tool: 'config.write',
      path: 'voice.yaml',
      text: '',
      etag: 'e0',
    });
    should(headers(agent.sent[0])).deepEqual({
      'content-type': 'application/json',
      'x-fy-session-capability': 'cap-1',
    });
    should(person.sent).be.empty();
  });

  it('should refuse with no capability, naming the way out', async () => {
    const agent = gateway();
    const client = new AgentToolsClient({ agent, person: gateway() }, { capability: ' ' });
    const error = await client.config({ tool: 'config.read' }).catch((failure: unknown) => failure);
    should(error).be.instanceOf(AgentToolsCommandError);
    should((error as Error).message).containEql('pass --session <id>');
    should(agent.sent).be.empty();
  });
});

describe('AgentToolsClient — lessons', () => {
  it('should dial POST /v1/agent/lessons as the agent, with the session capability and never the person gateway', async () => {
    // Arrange
    const agent = gateway([{ summary: 'filed as a new lesson', outcome: 'filed' }]);
    const person = gateway();
    const client = new AgentToolsClient({ agent, person }, { capability: 'cap-1', ownSessionId: 's1' });

    // Act
    const result = await client.lessons({
      tool: 'lessons.suggest',
      rule: 'Run bun install inside the target package.',
      scope: 'global',
    });

    // Assert
    should(result).deepEqual({ summary: 'filed as a new lesson', outcome: 'filed' });
    should(agent.sent[0]).match({ path: '/v1/agent/lessons', timeoutMs: 60_000, init: { method: 'POST' } });
    should(JSON.parse(String(agent.sent[0]?.init?.body))).deepEqual({
      tool: 'lessons.suggest',
      rule: 'Run bun install inside the target package.',
      scope: 'global',
    });
    should(headers(agent.sent[0])).deepEqual({
      'content-type': 'application/json',
      'x-fy-session-capability': 'cap-1',
    });
    should(person.sent).be.empty();
  });

  it('should search the shared work as the person, leaving out the filters it was not given', async () => {
    const empty = { hits: [], total: 0, indexed: { tasks: 0, agenda: 0 } };
    const person = gateway([empty, empty]);
    const agent = gateway();
    const client = new AgentToolsClient({ agent, person }, { ownSessionId: 's2' });

    const bare = await client.search({ q: 'relay', open: false });
    await client.search({ q: 'a b', kind: 'agenda', open: true });

    should(bare.total).equal(0);
    should(person.sent.map(sent => sent.path)).deepEqual([
      '/v1/search?q=relay',
      '/v1/search?q=a+b&kind=agenda&open=true',
    ]);
    should(person.sent[0]?.init?.method).equal('GET');
    should(headers(person.sent[0])).containEql({ 'x-ferretry-session-id': 's2' });
    should(agent.sent).be.empty();
  });

  it('should refuse with no capability, naming the way out', async () => {
    const agent = gateway();
    const client = new AgentToolsClient({ agent, person: gateway() }, { capability: '' });
    const error = await client
      .lessons({ tool: 'lessons.suggest', rule: 'a rule', scope: 'global' })
      .catch((failure: unknown) => failure);
    should(error).be.instanceOf(AgentToolsCommandError);
    should((error as Error).message).containEql('pass --session <id>');
    should(agent.sent).be.empty();
  });
});
