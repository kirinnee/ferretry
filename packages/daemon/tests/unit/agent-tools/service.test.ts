import { describe, it } from 'bun:test';
import should from 'should';
import {
  AGENT_TOOL_POLL_MS,
  AgentToolError,
  BrowserSessionError,
  BrowserTransportError,
  browserUnavailable,
  controlRefusal,
  pageScriptsRefusal,
  TerminalMountError,
} from '../../../src/lib/index.ts';
import { AGENT_TOOL_MAX_OUTPUT_CHARS, type AgentToolCall } from '@ferretry/protocol';
import { agent, agentToolWorld, otherAgent, person, SNAPSHOT } from './support.ts';

const refusal = async (work: Promise<unknown>): Promise<AgentToolError> => {
  const error = await work.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  should(error).be.instanceOf(AgentToolError);
  return error as AgentToolError;
};

describe('AgentToolService — terminals', () => {
  it('should open a named terminal for the agent, record it as the agent’s, and start its command', async () => {
    // Arrange
    const world = agentToolWorld();

    // Act
    const opened = await world.service.call(agent, {
      tool: 'terminal.open',
      name: 'dev',
      folder: 'web',
      command: 'bun dev',
    });
    const listed = await world.service.call(agent, { tool: 'terminal.list' });

    // Assert
    should(opened.summary).equal('Opened %terminal:dev and started the command.');
    should(listed.surfaces).deepEqual([{ id: '000000000001', name: 'dev', title: 'Terminal 1', available: true }]);
    should(listed.summary).equal('1 terminal: %terminal:dev.');
    const terminal = await world.terminals.get('s1', '000000000001');
    should(terminal.openedBy).deepEqual({ by: 'agent', sessionId: 's1' });
    should(world.terminals.folders.get('000000000001')).equal('web');
    should(world.terminals.typed.get('000000000001')).equal('bun dev\r');
  });

  it('should open a person’s terminal as theirs, without a folder or a command', async () => {
    // Arrange
    const world = agentToolWorld();
    const anonymous = { kind: 'person', sessionId: 's1', actor: { kind: 'host' } } as const;

    // Act
    const opened = await world.service.call(person, { tool: 'terminal.open', name: 'shell' });
    await world.service.call(anonymous, { tool: 'terminal.open', name: 'logs' });

    // Assert
    should(opened.summary).equal('Opened %terminal:shell.');
    should((await world.terminals.get('s1', '000000000001')).openedBy).deepEqual({ by: 'human', deviceId: 'phone-1' });
    should(await world.terminals.get('s1', '000000000002')).not.have.property('openedBy');
    should(world.terminals.folders.size).equal(0);
    should(world.terminals.typed.size).equal(0);
  });

  it('should send text and keys, read the screen, and close the terminal by name or by id', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });

    // Act
    const sent = await world.service.call(agent, { tool: 'terminal.send', name: 'dev', text: 'ls', keys: ['enter'] });
    const keysOnly = await world.service.call(agent, { tool: 'terminal.send', name: 'dev', keys: ['ctrl-c'] });
    const textOnly = await world.service.call(agent, { tool: 'terminal.send', name: '000000000001', text: 'x' });
    const read = await world.service.call(agent, { tool: 'terminal.read', name: 'dev', lines: 1 });
    const readDefault = await world.service.call(agent, { tool: 'terminal.read', name: 'dev' });
    const closed = await world.service.call(agent, { tool: 'terminal.close', name: 'dev' });
    const empty = await world.service.call(agent, { tool: 'terminal.list' });

    // Assert
    should(sent.summary).equal('Sent 2 characters and 1 key to %terminal:dev.');
    should(keysOnly.summary).equal('Sent 1 key to %terminal:dev.');
    should(textOnly.summary).equal('Sent 1 character to %terminal:dev.');
    should(read).deepEqual({ summary: 'The last 1 line of %terminal:dev.', output: '$ ls\r\u0003x' });
    should(readDefault.summary).equal('The last 200 lines of %terminal:dev.');
    should(closed.summary).equal('Closed %terminal:dev.');
    should(empty).deepEqual({ summary: 'No terminals are open for you in this session.', surfaces: [] });
  });

  it('should list an unnamed terminal by its id, and act on it by that id', async () => {
    // Arrange — the agent's own, opened without a name through the ordinary route.
    const world = agentToolWorld();
    await world.terminals.create('s1', {}, { by: 'agent', sessionId: 's1' });

    // Act
    const listed = await world.service.call(agent, { tool: 'terminal.list' });
    const read = await world.service.call(agent, { tool: 'terminal.read', name: '000000000001' });

    // Assert
    should(listed.summary).equal('1 terminal: %terminal:000000000001.');
    should(read.summary).equal('The last 200 lines of %terminal:000000000001.');
  });

  it('should wait for text to appear, looking one interval after the call', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });
    world.terminals.screens.set('000000000001', 'VITE ready in 412 ms\n');

    // Act
    const waited = await world.service.call(agent, { tool: 'terminal.wait', name: 'dev', text: 'ready' });

    // Assert
    should(world.slept).deepEqual([AGENT_TOOL_POLL_MS]);
    should(waited).deepEqual({
      summary: 'The text appeared in %terminal:dev.',
      matched: true,
      output: 'VITE ready in 412 ms\n',
    });
  });

  it('should wait for the running command to end, until the shell is back in the foreground', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });
    world.terminals.foregrounds.set('000000000001', ['sleep', 'node', '-zsh']);

    // Act
    const waited = await world.service.call(agent, { tool: 'terminal.wait', name: 'dev', exit: true });

    // Assert
    should(waited.summary).equal('The command ended in %terminal:dev.');
    should(waited.matched).be.true();
    should(world.slept).have.length(3);
  });

  it('should give up at the timeout with the screen as it stands', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });
    world.terminals.foregrounds.set('000000000001', ['sleep']);

    // Act
    const waited = await world.service.call(agent, {
      tool: 'terminal.wait',
      name: 'dev',
      exit: true,
      timeoutMs: 1_000,
    });

    // Assert
    should(waited).deepEqual({
      summary: 'Still waiting on %terminal:dev: the wait timed out.',
      matched: false,
      output: '$ ',
    });
    should(world.slept).deepEqual([250, 250, 250, 250]);
  });

  it('should report a terminal that closed while it was being waited on', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });
    world.terminals.foreground = async () => {
      throw new TerminalMountError('not_found', 'terminal not found');
    };

    // Act
    const waited = await world.service.call(agent, { tool: 'terminal.wait', name: 'dev', exit: true });

    // Assert
    should(waited).deepEqual({ summary: '%terminal:dev closed while waiting.', matched: true });
  });

  it('should pass any other failure while waiting through as the failure it is', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });
    world.terminals.foreground = async () => {
      throw new TerminalMountError('upstream_failed', 'tmux command failed');
    };

    // Act
    const error = await refusal(world.service.call(agent, { tool: 'terminal.wait', name: 'dev', exit: true }));

    // Assert
    should(error).match({ code: 'upstream_failed', message: 'tmux command failed' });
    should(world.audit.entries.at(-1)).match({ outcome: 'failed', detail: { tool: 'terminal.wait' } });
  });

  it('should refuse a second terminal with a name already in use', async () => {
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });
    const error = await refusal(world.service.call(agent, { tool: 'terminal.open', name: 'dev' }));
    should(error).match({ code: 'conflict', message: 'this session already has a terminal named dev' });
  });
});

describe('AgentToolService — an agent reaches its own session only', () => {
  it('should not find another session’s terminal or page by its name or its id', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });

    // Act
    const terminal = await refusal(world.service.call(otherAgent, { tool: 'terminal.send', name: 'dev', text: 'rm' }));
    const byId = await refusal(world.service.call(otherAgent, { tool: 'terminal.read', name: '000000000001' }));
    const page = await refusal(world.service.call(otherAgent, { tool: 'browser.read', name: 'app' }));
    const listed = await world.service.call(otherAgent, { tool: 'terminal.list' });

    // Assert
    should(terminal).match({
      code: 'not_found',
      message:
        'There is no %terminal:dev in this session. List them with terminal.list, or open one with terminal.open.',
    });
    should(byId.code).equal('not_found');
    should(page.message).equal(
      'There is no %browser:app in this session. List them with browser.list, or open one with browser.open.',
    );
    should(listed.surfaces).deepEqual([]);
    should(world.terminals.typed.size).equal(0);
    should(world.browser.acts).deepEqual([]);
  });
});

describe('AgentToolService — what the machine lets agents control', () => {
  it('should refuse an agent a kind the machine switched off, in a sentence naming the setting', async () => {
    // Arrange
    const world = agentToolWorld();
    world.policy.off.add('terminal');

    // Act
    const terminal = await refusal(world.service.call(agent, { tool: 'terminal.open', name: 'dev' }));
    const browser = await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    world.policy.off.add('browser');
    const page = await refusal(world.service.call(agent, { tool: 'browser.list' }));

    // Assert
    should(terminal).match({
      code: 'forbidden',
      message:
        'This machine does not let agents control terminals: "What agents may control › Terminals" is off in this machine\'s settings. Ask the person to turn it on if you need it.',
    });
    should(browser.summary).startWith('Opened %browser:app');
    should(page.message).containEql('"What agents may control › Browsers" is off');
    should(await world.terminals.list('s1')).match({ terminals: [] });
    should(world.audit.entries.map(entry => entry.outcome)).deepEqual(['refused', 'succeeded', 'refused']);
  });

  it('should apply a change to the very next call, without a restart', async () => {
    const world = agentToolWorld();
    world.policy.off.add('terminal');
    await refusal(world.service.call(agent, { tool: 'terminal.list' }));
    world.policy.off.delete('terminal');
    should((await world.service.call(agent, { tool: 'terminal.list' })).surfaces).deepEqual([]);
  });

  it('should never hold a person to the agents’ switches', async () => {
    const world = agentToolWorld();
    world.policy.off.add('terminal');
    should((await world.service.call(person, { tool: 'terminal.open', name: 'dev' })).summary).equal(
      'Opened %terminal:dev.',
    );
  });
});

describe('AgentToolService — take over and hand back', () => {
  it('should refuse the agent a surface a person took over, until they hand it back', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });

    // Act
    const view = await world.service.control(
      's1',
      'terminal',
      { action: 'takeover', key: 'dev' },
      { by: 'human', deviceId: 'phone-1' },
      person,
    );
    const refused = await refusal(world.service.call(agent, { tool: 'terminal.send', name: 'dev', text: 'ls' }));
    const read = await refusal(world.service.call(agent, { tool: 'terminal.read', name: 'dev' }));
    const personSent = await world.service.call(person, { tool: 'terminal.send', name: 'dev', text: 'pwd' });
    await world.service.control('s1', 'terminal', { action: 'handback', key: 'dev' }, { by: 'local' }, person);
    const allowed = await world.service.call(agent, { tool: 'terminal.send', name: 'dev', text: 'ls' });

    // Assert
    should(view.takeovers).deepEqual([
      {
        surface: 'terminal',
        id: '000000000001',
        name: 'dev',
        by: { by: 'human', deviceId: 'phone-1' },
        since: '2026-10-16T10:00:00.000Z',
      },
    ]);
    should(view.driving).deepEqual([]);
    should(refused).match({
      code: 'taken_over',
      message: 'A person has taken over %terminal:dev; wait or ask them.',
    });
    should(read.code).equal('taken_over');
    should(personSent.summary).equal('Sent 3 characters to %terminal:dev.');
    should(allowed.summary).equal('Sent 2 characters to %terminal:dev.');
    should(world.terminals.typed.get('000000000001')).equal('pwdls');
    should((await world.service.controlView('s1', 'terminal')).takeovers).deepEqual([]);
  });

  it('should take over a browser page by name, and say which surface in a refusal of an unnamed one', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    await world.terminals.create('s1', {}, { by: 'agent', sessionId: 's1' });

    // Act
    await world.service.control('s1', 'browser', { action: 'takeover', key: 'app' }, { by: 'local' }, person);
    await world.service.control('s1', 'terminal', { action: 'takeover', key: '000000000001' }, { by: 'local' }, person);
    const page = await refusal(world.service.call(agent, { tool: 'browser.click', name: 'app', selector: 'button' }));
    const terminal = await refusal(world.service.call(agent, { tool: 'terminal.read', name: '000000000001' }));

    // Assert
    should(page.message).equal('A person has taken over %browser:app; wait or ask them.');
    should(terminal.message).equal('A person has taken over %terminal:000000000001; wait or ask them.');
    should(world.browser.acts).deepEqual([]);
  });

  it('should audit a takeover by surface name, and a refused one by the key that was asked for', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });

    // Act
    await world.service.control('s1', 'terminal', { action: 'takeover', key: 'dev' }, { by: 'local' }, person);
    const missing = await refusal(
      world.service.control('s1', 'terminal', { action: 'handback', key: 'ghost' }, { by: 'local' }, person),
    );

    // Assert
    should(missing.code).equal('not_found');
    should(world.audit.entries.slice(-2)).deepEqual([
      {
        event: 'surface.control',
        actor: { kind: 'device', deviceId: 'phone-1' },
        subject: 's1',
        outcome: 'succeeded',
        detail: { action: 'takeover', surface: '%terminal:dev' },
      },
      {
        event: 'surface.control',
        actor: { kind: 'device', deviceId: 'phone-1' },
        subject: 's1',
        outcome: 'refused',
        detail: { action: 'handback', surface: '%terminal:ghost' },
      },
    ]);
  });

  it('should pass a genuine defect during a takeover through as itself', async () => {
    const world = agentToolWorld();
    const defect = new Error('disk on fire');
    world.terminals.list = async () => {
      throw defect;
    };
    const error = await world.service
      .control('s1', 'terminal', { action: 'takeover', key: 'dev' }, { by: 'local' }, person)
      .catch((failure: unknown) => failure);
    should(error).equal(defect);
  });
});

describe('AgentToolService — the driving marker', () => {
  it('should put the marker up for what an agent changes, not for what it reads, and never for a person', async () => {
    // Arrange
    const world = agentToolWorld();

    // Act
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });
    await world.service.call(agent, { tool: 'terminal.read', name: 'dev' });
    await world.service.call(person, { tool: 'terminal.open', name: 'shell' });
    await world.service.call(person, { tool: 'terminal.send', name: 'shell', text: 'x' });

    // Assert
    should(world.events.published).deepEqual([
      {
        sessionId: 's1',
        type: 'surface.driving',
        data: {
          surface: 'terminal',
          id: '000000000001',
          name: 'dev',
          agentSessionId: 's1',
          agentName: 'Hadi',
          since: '2026-10-16T10:00:00.000Z',
          until: '2026-10-16T10:00:15.000Z',
        },
      },
      {
        sessionId: 's1',
        type: 'surface.opened',
        data: {
          surface: 'terminal',
          id: '000000000001',
          name: 'dev',
          agentSessionId: 's1',
          agentName: 'Hadi',
          at: '2026-10-16T10:00:00.000Z',
        },
      },
    ]);
  });

  it('should not fail an act that happened because the journal could not take its marker', async () => {
    const world = agentToolWorld();
    world.events.failing = true;
    should((await world.service.call(otherAgent, { tool: 'terminal.open', name: 'dev' })).summary).equal(
      'Opened %terminal:dev.',
    );
    should((await world.service.controlView('s2', 'terminal')).driving).have.length(1);
  });

  it('should not fail an open because the journal could not take the ask, but fail an explicit ask', async () => {
    // Arrange
    const world = agentToolWorld();
    world.events.failing = true;

    // Act
    const opened = await world.service.call(agent, { tool: 'terminal.open', name: 'dev', askOwner: 'Type it.' });
    const asked = await world.service.call(agent, { tool: 'terminal.ask_owner', name: 'dev' }).catch((e: unknown) => e);

    // Assert
    should(opened.summary).equal('Opened %terminal:dev and asked the owner to take over (wait for them).');
    should((asked as Error).message).equal('the journal is full');
  });
});

describe('AgentToolService — opening a surface announces it to the owner', () => {
  it('should publish an opened surface for an agent’s open, once, and never for a person’s', async () => {
    // Arrange
    const world = agentToolWorld();

    // Act
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });
    await world.service.call(agent, { tool: 'terminal.send', name: 'dev', text: 'ls' });
    await world.service.call(person, { tool: 'terminal.open', name: 'shell' });
    await world.service.call(agent, {
      tool: 'browser.open',
      name: 'app',
      url: 'https://example.test/',
      incognito: true,
    });
    const terminals = await world.service.controlView('s1', 'terminal');
    const pages = await world.service.controlView('s1', 'browser');

    // Assert
    should(terminals.opened.map(entry => entry.name)).deepEqual(['dev']);
    should(pages.opened.map(entry => [entry.name, entry.incognito, entry.agentName])).deepEqual([
      ['app', true, 'Hadi'],
    ]);
    should(world.events.published.filter(event => event.type === 'surface.opened')).have.length(2);
    should(world.events.published.some(event => event.type === 'surface.asked')).be.false();
  });

  it('should hand a surface to the owner on open, and again on each ask, with what to do', async () => {
    // Arrange
    const world = agentToolWorld();

    // Act
    const terminal = await world.service.call(agent, {
      tool: 'terminal.open',
      name: 'login',
      command: 'gh auth login',
      askOwner: 'Pick GitHub.com and press Enter.',
    });
    const page = await world.service.call(agent, { tool: 'browser.open', name: 'bank', askOwner: true });
    world.clock.ms += 1_000;
    const again = await world.service.call(agent, {
      tool: 'terminal.ask_owner',
      name: 'login',
      message: 'Paste the code.',
    });
    const bare = await world.service.call(agent, { tool: 'browser.ask_owner', name: 'bank' });
    const terminals = await world.service.controlView('s1', 'terminal');
    const pages = await world.service.controlView('s1', 'browser');

    // Assert
    should(terminal.summary).equal(
      'Opened %terminal:login and started the command and asked the owner to take over (wait for them).',
    );
    should(page.summary).startWith('Opened %browser:bank at ');
    should(again.summary).equal(
      'Asked the owner to take over %terminal:login and told them what to do. Wait for them: read the surface to see when they are done.',
    );
    should(bare.summary).equal(
      'Asked the owner to take over %browser:bank. Wait for them: read the surface to see when they are done.',
    );
    should(terminals.asked).deepEqual([
      {
        surface: 'terminal',
        id: '000000000001',
        name: 'login',
        agentSessionId: 's1',
        agentName: 'Hadi',
        message: 'Paste the code.',
        at: '2026-10-16T10:00:01.000Z',
      },
    ]);
    should(pages.asked.map(entry => entry.message)).deepEqual([undefined]);
  });

  it('should clear an ask when a person takes the surface over or hands it back, not when the agent reads', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev', askOwner: true });
    await world.service.call(agent, { tool: 'terminal.open', name: 'two', askOwner: true });

    // Act
    await world.service.call(agent, { tool: 'terminal.read', name: 'dev' });
    const standing = (await world.service.controlView('s1', 'terminal')).asked.length;
    await world.service.control(
      's1',
      'terminal',
      { action: 'takeover', key: 'dev' },
      { by: 'local' },
      {
        kind: 'person',
        sessionId: 's1',
        actor: { kind: 'host' },
      },
    );
    const taken = (await world.service.controlView('s1', 'terminal')).asked.map(entry => entry.name);
    await world.service.control(
      's1',
      'terminal',
      { action: 'handback', key: 'two' },
      { by: 'local' },
      {
        kind: 'person',
        sessionId: 's1',
        actor: { kind: 'host' },
      },
    );
    const handedBack = (await world.service.controlView('s1', 'terminal')).asked.map(entry => entry.name);

    // Assert
    should(standing).equal(2);
    should(taken).deepEqual(['two']);
    should(handedBack).deepEqual([]);
  });

  it('should drop an opened surface and its ask once the surface itself is gone', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev', askOwner: true });
    await world.service.call(agent, { tool: 'browser.open', name: 'app', askOwner: true });

    // Act — closed by a person's hand, outside the tools, so nothing forgot them.
    await world.terminals.close('s1', '000000000001');
    await world.browser.closePage('s1', 'app');
    const terminals = await world.service.controlView('s1', 'terminal');
    const pages = await world.service.controlView('s1', 'browser');
    await world.service.call(agent, { tool: 'terminal.open', name: 'next' });
    const closedByTool = await world.service.call(agent, { tool: 'terminal.close', name: 'next' });

    // Assert
    should([terminals.opened, terminals.asked, pages.opened, pages.asked]).deepEqual([[], [], [], []]);
    should(closedByTool.summary).equal('Closed %terminal:next.');
    should((await world.service.controlView('s1', 'terminal')).opened).deepEqual([]);
  });

  it('should refuse a person the ask tools, and an agent an ask on a surface it may not use', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(person, { tool: 'terminal.open', name: 'shell' });
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });

    // Act
    const byPerson = await refusal(world.service.call(person, { tool: 'terminal.ask_owner', name: 'dev' }));
    const theirs = await refusal(world.service.call(agent, { tool: 'terminal.ask_owner', name: 'shell' }));

    // Assert
    should(byPerson.code).equal('bad_request');
    should(theirs.code).equal('forbidden');
  });

  it('should audit an ask by whether it carried a message, never by the message', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev', askOwner: 'the secret-ish sentence' });
    await world.service.call(agent, { tool: 'terminal.ask_owner', name: 'dev', message: 'the secret-ish sentence' });
    await world.service.call(agent, {
      tool: 'browser.open',
      name: 'app',
      url: 'https://example.test/x',
      askOwner: true,
    });

    // Act
    const details = world.audit.entries.map(entry => entry.detail);

    // Assert
    should(JSON.stringify(details)).not.containEql('secret-ish');
    should(details[0]).have.property('askOwner', true);
    should(details[1]).have.property('message', true);
    should(details[2]).have.property('askOwner', true);
  });
});

describe('AgentToolService — browser pages', () => {
  it('should open, drive, read and close a named page', async () => {
    // Arrange
    const world = agentToolWorld();

    // Act
    const opened = await world.service.call(agent, {
      tool: 'browser.open',
      name: 'app',
      url: 'http://localhost:5173/',
    });
    const navigated = await world.service.call(agent, {
      tool: 'browser.navigate',
      name: 'app',
      url: 'http://localhost:5173/login',
    });
    const clicked = await world.service.call(agent, { tool: 'browser.click', name: 'app', selector: 'button' });
    const typed = await world.service.call(agent, {
      tool: 'browser.type',
      name: 'app',
      selector: '#password',
      text: 'hunter2',
    });
    const text = await world.service.call(agent, { tool: 'browser.read', name: 'app' });
    const tree = await world.service.call(agent, { tool: 'browser.read', name: 'app', mode: 'a11y', selector: 'main' });
    const shot = await world.service.call(agent, { tool: 'browser.screenshot', name: 'app' });
    const listed = await world.service.call(agent, { tool: 'browser.list' });
    const closed = await world.service.call(agent, { tool: 'browser.close', name: 'app' });

    // Assert
    should(opened.summary).equal('Opened %browser:app at http://localhost:5173/.');
    should(navigated.summary).equal('Done on %browser:app (now at http://localhost:5173/).');
    should(clicked.summary).startWith('Done on %browser:app');
    should(typed.summary).startWith('Done on %browser:app');
    should(text).deepEqual({ summary: 'Read %browser:app (now at http://localhost:5173/).', output: 'Welcome back' });
    should(tree.output).equal('- button "Sign in"');
    should(shot).match({ summary: /^A screenshot of %browser:app/u, screenshotBase64: 'iVBORw0KGgo=' });
    should(listed.surfaces).deepEqual([
      { id: 'page-1', name: 'app', title: 'Page at localhost:5173', url: 'http://localhost:5173/', available: true },
    ]);
    should(listed.summary).equal('1 browser page: %browser:app.');
    should(closed.summary).equal('Closed %browser:app.');
    should(world.browser.acts).deepEqual([
      's1:page-1:navigate',
      's1:page-1:click',
      's1:page-1:type',
      's1:page-1:read',
      's1:page-1:read',
      's1:page-1:screenshot',
    ]);
    should((await world.service.call(agent, { tool: 'browser.list' })).summary).equal(
      'No browser pages are open for you in this session.',
    );
  });

  it('should tell the agent plainly, with the fix, when this machine cannot start a browser', async () => {
    // Arrange
    const world = agentToolWorld();
    world.browser.failure = new BrowserSessionError('launch_failed', 'no Chrome executable found\n    at launch');

    // Act
    const error = await refusal(world.service.call(agent, { tool: 'browser.open', name: 'app' }));

    // Assert
    should(error).match({
      code: 'unavailable',
      message:
        'Browser tools could not start a browser on this machine (no Chrome executable found): install Google Chrome or set FY_CHROME_BIN to a Chrome binary, make sure the fyd-browser-worker program is installed beside fyd, then try again.',
    });
    should(browserUnavailable('')).containEql('(no reason given)');
  });

  it('should say a stopped browser has no pages, and pass the browser’s other refusals through', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });

    // Act
    world.browser.failure = new BrowserSessionError('not_running', 'the session browser is not running');
    const stopped = await refusal(world.service.call(agent, { tool: 'browser.list' }));
    world.browser.failure = new BrowserSessionError('capacity', 'this daemon already has 3 session browsers running');
    const full = await refusal(world.service.call(agent, { tool: 'browser.open', name: 'docs' }));
    const taken = await refusal(world.service.call(agent, { tool: 'browser.open', name: 'app' }));

    // Assert
    should(stopped).match({
      code: 'not_found',
      message: 'The browser is not running in this session. Open a page with browser.open.',
    });
    should(full.code).equal('capacity');
    should(taken.code).equal('conflict');
  });
});

describe('AgentToolService — refs, points and what a page shows', () => {
  it('should hand the browser each act exactly as the agent named it: a ref, a point, history, a snapshot', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app', url: 'https://app.test/' });

    // Act
    await world.service.call(agent, {
      tool: 'browser.click',
      name: 'app',
      ref: 'e4',
      double: true,
      button: 'right',
      modifiers: ['Shift'],
    });
    await world.service.call(agent, { tool: 'browser.click', name: 'app', x: 120, y: 340 });
    await world.service.call(agent, {
      tool: 'browser.type',
      name: 'app',
      ref: 'e5',
      text: 'hadi',
      submit: true,
      slowly: true,
    });
    await world.service.call(agent, { tool: 'browser.read', name: 'app', find: 'Sign in' });
    await world.service.call(agent, { tool: 'browser.read', name: 'app', mode: 'snapshot', ref: 'e3', depth: 2 });
    await world.service.call(agent, { tool: 'browser.navigate', name: 'app', history: 'back' });
    const shot = await world.service.call(agent, {
      tool: 'browser.screenshot',
      name: 'app',
      fullPage: true,
      format: 'jpeg',
    });

    // Assert
    should(world.browser.actions).deepEqual([
      { action: 'click', ref: 'e4', button: 'right', double: true, modifiers: ['Shift'] },
      { action: 'click', x: 120, y: 340 },
      { action: 'type', ref: 'e5', text: 'hadi', submit: true, slowly: true },
      { action: 'read', mode: 'snapshot', find: 'Sign in' },
      { action: 'read', ref: 'e3', mode: 'snapshot', depth: 2 },
      { action: 'back' },
      { action: 'screenshot', fullPage: true, format: 'jpeg' },
    ]);
    should(shot).match({ screenshotBase64: '/9j/4AAQ', screenshotFormat: 'jpeg' });
  });

  it('should hand back a snapshot with its refs, and tell the agent to act on them', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });

    // Act
    const snapshot = await world.service.call(agent, { tool: 'browser.read', name: 'app', mode: 'snapshot' });
    const found = await world.service.call(agent, { tool: 'browser.read', name: 'app', find: 'sign in' });
    const nothing = await world.service.call(agent, { tool: 'browser.read', name: 'app', find: 'checkout' });

    // Assert
    should(snapshot.output).equal(SNAPSHOT);
    should(snapshot.summary).equal(
      'Read %browser:app (now at https://blank.test/). Pass a ref from it (ref: "e12") to any browser tool instead of a selector.',
    );
    should(found.output).equal('- button "Sign in" [ref=e4]');
    should(nothing).deepEqual({
      summary: 'Nothing in the snapshot of %browser:app contains that text (now at https://blank.test/).',
      output: '',
    });
  });

  it('should keep the top of a snapshot too long for one answer, and say how to read less', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    const lines = Array.from(
      { length: 5_000 },
      (_, index) => `- listitem "row ${String(index)}" [ref=e${String(index)}]`,
    );
    world.browser.readText = lines.join('\n');

    // Act
    const snapshot = await world.service.call(agent, { tool: 'browser.read', name: 'app', mode: 'snapshot' });
    const text = await world.service.call(agent, { tool: 'browser.read', name: 'app' });

    // Assert
    should(snapshot.output?.startsWith(lines[0] ?? '')).be.true();
    should(snapshot.output?.length).be.belowOrEqual(AGENT_TOOL_MAX_OUTPUT_CHARS);
    should(snapshot.output?.endsWith(']')).be.true();
    should(snapshot.summary).containEql('It was clipped to fit');
    // Visible text keeps its tail, as it always has.
    should(text.output?.endsWith(lines.at(-1) ?? '')).be.true();
  });

  it('should mask every vault secret a page shows, in its text and in its address, before anyone reads it', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    world.redactor.values.set('sk_live_51Hx', 'STRIPE_KEY');
    world.browser.readText = 'Your API key is sk_live_51Hx — keep it safe.';
    world.browser.actedUrl = 'https://dash.test/keys?reveal=sk_live_51Hx';

    // Act
    const read = await world.service.call(agent, { tool: 'browser.read', name: 'app' });
    const clicked = await world.service.call(agent, { tool: 'browser.click', name: 'app', ref: 'e2' });
    const byPerson = await world.service.call(person, { tool: 'browser.read', name: 'app' });

    // Assert
    should(read.output).equal('Your API key is [redacted:STRIPE_KEY] — keep it safe.');
    should(read.summary).containEql('reveal=[redacted:STRIPE_KEY]');
    should(clicked.summary).containEql('reveal=[redacted:STRIPE_KEY]');
    should(byPerson.output).equal('Your API key is [redacted:STRIPE_KEY] — keep it safe.');
    should(JSON.stringify([read, clicked, byPerson])).not.containEql('sk_live_51Hx');
  });

  it('should hand the agent the worker’s own sentence when an act is refused, as a tool refusal', async () => {
    // Arrange — what the worker answers for a ref the page no longer knows (verified against a real Chrome).
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    world.browser.failure = new BrowserTransportError(
      'upstream_failed',
      'browser action failed: e4 is not on the page\'s latest snapshot (it changed, or was never read): read the page again with mode "snapshot" and use a fresh ref',
      502,
    );

    // Act
    const stale = await refusal(world.service.call(agent, { tool: 'browser.click', name: 'app', ref: 'e4' }));
    world.browser.failure = new BrowserTransportError('profile_busy', 'the agent profile is in use', 409);
    const busy = await refusal(world.service.call(agent, { tool: 'browser.click', name: 'app', ref: 'e4' }));
    world.browser.failure = new BrowserTransportError('launch_failed', 'browser worker did not become ready', 503);
    const unstarted = await refusal(world.service.call(agent, { tool: 'browser.click', name: 'app', ref: 'e4' }));
    world.browser.failure = new BrowserTransportError('not_running', 'the browser worker is closed', 409);
    const gone = await refusal(world.service.call(agent, { tool: 'browser.click', name: 'app', ref: 'e4' }));

    // Assert
    should(stale.code).equal('upstream_failed');
    should(stale.message).startWith("e4 is not on the page's latest snapshot");
    should(busy).match({ code: 'conflict', message: 'the agent profile is in use' });
    should(unstarted).match({
      code: 'unavailable',
      message: browserUnavailable('browser worker did not become ready'),
    });
    should(gone).match({
      code: 'not_found',
      message: 'The browser is not running in this session. Open a page with browser.open.',
    });
    should(world.audit.entries.slice(-4).map(entry => entry.outcome)).deepEqual([
      'failed',
      'refused',
      'refused',
      'refused',
    ]);
  });

  it('should withhold what a page shows, rather than serve it unmasked, when the vault cannot be opened', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    world.redactor.locked = true;

    // Act
    const error = await refusal(world.service.call(agent, { tool: 'browser.read', name: 'app' }));

    // Assert
    should(error.code).equal('unavailable');
    should(error.message).containEql('could not open its secret store');
    should(world.browser.acts).deepEqual(['s1:page-1:read']);
    should(world.audit.entries.at(-1)).match({ outcome: 'refused', detail: { tool: 'browser.read' } });
  });

  it('should audit refs, points and options by what they were, never by the text typed or searched for', async () => {
    // Arrange
    const world = agentToolWorld();
    const secret = 'correct-horse-battery-staple';
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });

    // Act
    await world.service.call(agent, {
      tool: 'browser.click',
      name: 'app',
      ref: 'e4',
      double: true,
      modifiers: ['Alt'],
    });
    await world.service.call(agent, { tool: 'browser.click', name: 'app', x: 1, y: 2, button: 'middle' });
    await world.service.call(agent, { tool: 'browser.type', name: 'app', ref: 'e5', text: secret, submit: true });
    await world.service.call(agent, { tool: 'browser.read', name: 'app', find: secret, depth: 3 });
    await world.service.call(agent, { tool: 'browser.navigate', name: 'app', history: 'reload' });
    await world.service.call(agent, { tool: 'browser.screenshot', name: 'app', ref: 'e4', format: 'jpeg' });

    // Assert
    should(JSON.stringify(world.audit.entries)).not.containEql(secret);
    should(world.audit.entries.slice(1).map(entry => entry.detail)).deepEqual([
      { tool: 'browser.click', by: 'agent', surface: '%browser:app', ref: 'e4', double: true, modifiers: 1 },
      { tool: 'browser.click', by: 'agent', surface: '%browser:app', point: true, button: 'middle' },
      {
        tool: 'browser.type',
        by: 'agent',
        surface: '%browser:app',
        ref: 'e5',
        textLength: secret.length,
        submit: true,
      },
      {
        tool: 'browser.read',
        by: 'agent',
        surface: '%browser:app',
        mode: 'snapshot',
        findLength: secret.length,
        depth: 3,
      },
      { tool: 'browser.navigate', by: 'agent', surface: '%browser:app', history: 'reload' },
      { tool: 'browser.screenshot', by: 'agent', surface: '%browser:app', ref: 'e4', format: 'jpeg' },
    ]);
  });
});

describe('AgentToolService — pointer and keys', () => {
  it('should hand each pointer tool to the browser as the action that carries it', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });

    // Act
    await world.service.call(agent, { tool: 'browser.hover', name: 'app', ref: 'e2' });
    await world.service.call(agent, { tool: 'browser.hover', name: 'app', x: 3, y: 4 });
    await world.service.call(agent, { tool: 'browser.drag', name: 'app', fromRef: 'e2', toSelector: '#bin' });
    await world.service.call(agent, {
      tool: 'browser.drag',
      name: 'app',
      fromX: 1,
      fromY: 2,
      toX: 90,
      toY: 2,
      steps: 5,
    });
    await world.service.call(agent, { tool: 'browser.mouse', name: 'app', action: 'wheel', deltaY: 400 });
    await world.service.call(agent, { tool: 'browser.press', name: 'app', keys: ['Control+a', 'Delete'], ref: 'e4' });
    await world.service.call(agent, { tool: 'browser.scroll', name: 'app', text: 'Terms' });
    await world.service.call(agent, { tool: 'browser.scroll', name: 'app', pages: -2 });
    await world.service.call(agent, { tool: 'browser.select', name: 'app', ref: 'e4', values: ['uk'] });
    await world.service.call(agent, { tool: 'browser.check', name: 'app', ref: 'e5', checked: false });
    await world.service.call(agent, {
      tool: 'browser.fill_form',
      name: 'app',
      fields: [
        { ref: 'e4', text: 'hadi' },
        { selector: '#tos', checked: true },
      ],
    });
    await world.service.call(agent, { tool: 'browser.highlight', name: 'app', ref: 'e2' });
    await world.service.call(agent, { tool: 'browser.highlight', name: 'app', clear: true });

    // Assert
    should(world.browser.actions).deepEqual([
      { action: 'hover', ref: 'e2' },
      { action: 'hover', x: 3, y: 4 },
      { action: 'drag', fromRef: 'e2', toSelector: '#bin' },
      { action: 'drag', fromX: 1, fromY: 2, toX: 90, toY: 2, steps: 5 },
      { action: 'mouse', mouseAction: 'wheel', deltaY: 400 },
      { action: 'press', keys: ['Control+a', 'Delete'], ref: 'e4' },
      { action: 'scroll', text: 'Terms' },
      { action: 'scroll', pages: -2 },
      { action: 'select', ref: 'e4', values: ['uk'] },
      { action: 'check', ref: 'e5', checked: false },
      {
        action: 'fill-form',
        fields: [
          { ref: 'e4', text: 'hadi' },
          { selector: '#tos', checked: true },
        ],
      },
      { action: 'highlight', ref: 'e2' },
      { action: 'highlight', clear: true },
    ]);
  });

  it('should refuse every pointer tool on a page a person took over, and touch nothing', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    await world.service.control('s1', 'browser', { action: 'takeover', key: 'app' }, { by: 'local' }, person);
    const calls: AgentToolCall[] = [
      { tool: 'browser.hover', name: 'app', ref: 'e1' },
      { tool: 'browser.drag', name: 'app', fromRef: 'e1', toRef: 'e2' },
      { tool: 'browser.mouse', name: 'app', action: 'up' },
      { tool: 'browser.press', name: 'app', keys: ['Enter'] },
      { tool: 'browser.scroll', name: 'app', pages: 1 },
      { tool: 'browser.select', name: 'app', ref: 'e1', values: ['a'] },
      { tool: 'browser.check', name: 'app', ref: 'e1', checked: true },
      { tool: 'browser.fill_form', name: 'app', fields: [{ ref: 'e1', text: 'a' }] },
      { tool: 'browser.highlight', name: 'app', clear: true },
    ];

    // Act
    const refused = await Promise.all(calls.map(call => refusal(world.service.call(agent, call))));

    // Assert
    should(refused.map(error => error.code)).deepEqual(calls.map(() => 'taken_over'));
    should(world.browser.acts).deepEqual([]);
  });

  it('should audit counts, lengths, refs and flags, never typed text, key names, options or values', async () => {
    // Arrange
    const world = agentToolWorld();
    const secret = 'correct-horse-battery-staple';
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });

    // Act
    await world.service.call(agent, { tool: 'browser.hover', name: 'app', ref: 'e2' });
    await world.service.call(agent, {
      tool: 'browser.drag',
      name: 'app',
      fromX: 1,
      fromY: 2,
      toX: 3,
      toY: 4,
      steps: 8,
    });
    await world.service.call(agent, { tool: 'browser.mouse', name: 'app', action: 'down', button: 'right' });
    await world.service.call(agent, {
      tool: 'browser.press',
      name: 'app',
      keys: [secret.slice(0, 1), 'Control+Shift+K'],
    });
    await world.service.call(agent, { tool: 'browser.scroll', name: 'app', text: secret });
    await world.service.call(agent, { tool: 'browser.scroll', name: 'app', ref: 'e9' });
    await world.service.call(agent, { tool: 'browser.scroll', name: 'app', deltaY: 600 });
    await world.service.call(agent, {
      tool: 'browser.select',
      name: 'app',
      ref: 'e4',
      values: [secret, 'United States'],
    });
    await world.service.call(agent, { tool: 'browser.check', name: 'app', ref: 'e5', checked: false });
    await world.service.call(agent, {
      tool: 'browser.fill_form',
      name: 'app',
      fields: [
        { ref: 'e4', text: secret },
        { ref: 'e5', option: secret },
        { ref: 'e6', value: secret },
      ],
    });
    await world.service.call(agent, { tool: 'browser.highlight', name: 'app', clear: true });

    // Assert
    should(JSON.stringify(world.audit.entries)).not.containEql(secret);
    should(JSON.stringify(world.audit.entries)).not.containEql('Control+Shift+K');
    should(JSON.stringify(world.audit.entries)).not.containEql('United States');
    should(world.audit.entries.slice(1).map(entry => entry.detail)).deepEqual([
      { tool: 'browser.hover', by: 'agent', surface: '%browser:app', ref: 'e2' },
      { tool: 'browser.drag', by: 'agent', surface: '%browser:app', from: 'point', to: 'point', steps: 8 },
      { tool: 'browser.mouse', by: 'agent', surface: '%browser:app', mouse: 'down', button: 'right' },
      { tool: 'browser.press', by: 'agent', surface: '%browser:app', keys: 2 },
      { tool: 'browser.scroll', by: 'agent', surface: '%browser:app', scroll: 'text', textLength: secret.length },
      { tool: 'browser.scroll', by: 'agent', surface: '%browser:app', scroll: 'element', ref: 'e9' },
      { tool: 'browser.scroll', by: 'agent', surface: '%browser:app', scroll: 'distance' },
      { tool: 'browser.select', by: 'agent', surface: '%browser:app', ref: 'e4', values: 2 },
      { tool: 'browser.check', by: 'agent', surface: '%browser:app', ref: 'e5', checked: false },
      { tool: 'browser.fill_form', by: 'agent', surface: '%browser:app', fields: 3, textLength: secret.length },
      { tool: 'browser.highlight', by: 'agent', surface: '%browser:app', clear: true },
    ]);
  });

  describe('who a page is signing in (&B137, secrev-1331 M4)', () => {
    /** A world whose identity store records every call, in order, by what it did and with what. */
    async function signingIn() {
      const events: string[] = [];
      const world = agentToolWorld({
        typedIdentities: {
          typed: (_session, pageId, host, text) => void events.push(`typed ${pageId} ${host} ${text}`),
          seen: (_session, pageId, host) => void events.push(`seen ${pageId} ${host ?? '-'}`),
          cleared: (_session, pageId) => void events.push(`cleared ${pageId}`),
          forget: () => void events.push('forget'),
        },
      });
      await world.service.call(agent, { tool: 'browser.open', name: 'app' });
      const listed = await world.service.call(agent, { tool: 'browser.list' });
      const pageId = (listed.surfaces ?? [])[0]?.id as string;
      return { world, events, pageId };
    }

    it('should keep a type into an email box, keyed by the DAEMON’s page id, and clear on a type anywhere else', async () => {
      // Arrange
      const { world, events, pageId } = await signingIn();
      world.browser.identifierHost = 'accounts.google.com';

      // Act
      await world.service.call(agent, {
        tool: 'browser.type',
        name: 'app',
        selector: '#id',
        text: 'ernest@atomi.tech',
      });
      world.browser.identifierHost = undefined;
      await world.service.call(agent, { tool: 'browser.type', name: 'app', selector: '#q', text: 'search' });
      world.browser.passwordField = true;
      await world.service.call(agent, { tool: 'browser.type', name: 'app', selector: '#pw', text: 'not-a-username' });

      // Assert: the same id browser.list gives (the one the input target checks a card's facts against)
      should(events).deepEqual([
        `typed ${pageId} accounts.google.com ernest@atomi.tech`,
        `cleared ${pageId}`,
        `cleared ${pageId}`,
      ]);
    });

    it('should keep a fill into ONE identifier box, and clear on two, on a password, or on none', async () => {
      // Arrange
      const { world, events, pageId } = await signingIn();
      const fill = async (fields: { selector: string; text: string }[]) =>
        await world.service.call(agent, { tool: 'browser.fill_form', name: 'app', fields });

      // Act
      world.browser.identifierFields = [{ index: 1, host: 'login.example.com' }];
      await fill([
        { selector: '#name', text: 'Ernest' },
        { selector: '#email', text: 'e@x.com' },
      ]);
      world.browser.identifierFields = [
        { index: 0, host: 'login.example.com' },
        { index: 1, host: 'login.example.com' },
      ];
      await fill([
        { selector: '#a', text: 'a@x.com' },
        { selector: '#b', text: 'b@x.com' },
      ]);
      world.browser.identifierFields = undefined;
      await fill([{ selector: '#name', text: 'Ernest' }]);

      // Assert
      should(events).deepEqual([`typed ${pageId} login.example.com e@x.com`, `cleared ${pageId}`, `cleared ${pageId}`]);
    });

    it('should keep the account tile a click chose, keep a plain click, and clear a click at a bare point', async () => {
      // Arrange
      const { world, events, pageId } = await signingIn();

      // Act
      world.browser.clickedIdentity = { host: 'accounts.google.com', username: 'ernest@atomi.tech' };
      await world.service.call(agent, { tool: 'browser.click', name: 'app', selector: '#tile' });
      world.browser.clickedIdentity = undefined;
      world.browser.actedUrl = 'https://accounts.google.com/v3/signin/challenge/pwd';
      await world.service.call(agent, { tool: 'browser.click', name: 'app', selector: '#next' });
      await world.service.call(agent, { tool: 'browser.click', name: 'app', x: 10, y: 10 });

      // Assert
      should(events).deepEqual([
        `typed ${pageId} accounts.google.com ernest@atomi.tech`,
        `seen ${pageId} accounts.google.com`,
        `cleared ${pageId}`,
      ]);
    });

    it('should keep through Enter, a read or a scroll, and clear on a key that types, a navigation or raw mouse', async () => {
      // Arrange
      const { world, events, pageId } = await signingIn();
      world.browser.actedUrl = 'not a url';

      // Act
      await world.service.call(agent, { tool: 'browser.press', name: 'app', keys: ['Enter'] });
      await world.service.call(agent, { tool: 'browser.read', name: 'app' });
      await world.service.call(agent, { tool: 'browser.press', name: 'app', keys: ['Tab', 'a'] });
      await world.service.call(agent, {
        tool: 'browser.navigate',
        name: 'app',
        url: 'https://accounts.google.com/AddSession',
      });
      await world.service.call(agent, { tool: 'browser.mouse', name: 'app', action: 'move', x: 1, y: 1 });

      // Assert: an address that cannot be read is no host, so even a kept act forgets on it.
      should(events).deepEqual([
        `seen ${pageId} -`,
        `seen ${pageId} -`,
        `cleared ${pageId}`,
        `cleared ${pageId}`,
        `cleared ${pageId}`,
      ]);
    });

    it('should forget every page of the session when a page script runs: it may have typed anywhere', async () => {
      // Arrange
      const { world, events } = await signingIn();
      world.browser.scriptAnswer = '1';

      // Act
      await world.service.call(agent, { tool: 'browser.eval', name: 'app', function: '() => 1' });

      // Assert
      should(events).deepEqual(['forget']);
    });

    it('should clear for a PERSON’s act on the page, whatever it typed, and keep through their read', async () => {
      // Arrange
      const { world, events, pageId } = await signingIn();
      world.browser.identifierHost = 'accounts.google.com';

      // Act
      await world.service.call(person, { tool: 'browser.type', name: 'app', selector: '#id', text: 'owner@x.com' });
      await world.service.call(person, { tool: 'browser.read', name: 'app' });

      // Assert
      should(events[0]).equal(`cleared ${pageId}`);
      should(events.join()).not.containEql('owner@x.com');
    });
  });

  it('should say a password field was filled, tell the agent to hand secrets to the owner, and audit the flag', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    world.browser.passwordField = true;

    // Act
    const typed = await world.service.call(agent, {
      tool: 'browser.type',
      name: 'app',
      selector: '#password',
      text: 'hunter2',
    });
    const filled = await world.service.call(agent, {
      tool: 'browser.fill_form',
      name: 'app',
      fields: [{ selector: '#password', text: 'hunter2' }],
    });

    // Assert
    for (const answer of [typed, filled]) {
      should(answer.summary).containEql('password field');
      should(answer.summary).containEql('browser_ask_owner');
    }
    should(filled.summary).containEql('filled');
    should(JSON.stringify(world.audit.entries)).not.containEql('hunter2');
    should(world.audit.entries.slice(-2).map(entry => entry.detail?.passwordField)).deepEqual([true, true]);
  });

  it('should not mention a password field, or flag the audit, when none was written to', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });

    // Act
    const answer = await world.service.call(agent, {
      tool: 'browser.fill_form',
      name: 'app',
      fields: [{ ref: 'e4', text: 'hadi' }],
    });

    // Assert
    should(answer.summary).not.containEql('password');
    should(world.audit.entries.at(-1)?.detail).not.have.property('passwordField');
  });

  it('should mask a vault secret in the address a pointer act reports', async () => {
    // Arrange
    const world = agentToolWorld();
    world.redactor.values.set('sk_live_51Hx', 'STRIPE_KEY');
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    world.browser.actedUrl = 'https://example.test/?key=sk_live_51Hx';

    // Act
    const answer = await world.service.call(agent, { tool: 'browser.scroll', name: 'app', pages: 1 });

    // Assert
    should(answer.summary).containEql('key=[redacted:STRIPE_KEY]');
    should(answer.summary).not.containEql('sk_live_51Hx');
  });
});

describe('AgentToolService — page scripts (owner-gated browser.eval)', () => {
  it('should run the agent’s script on its page, with its element and timeout, and hand back what it returned', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app', url: 'https://app.test/' });
    world.browser.scriptAnswer = '{"items":3}';

    // Act
    const ran = await world.service.call(agent, {
      tool: 'browser.eval',
      name: 'app',
      function: '(list) => ({ items: list.children.length })',
      ref: 'e3',
      timeoutMs: 2_000,
    });

    // Assert
    should(world.browser.scripts).deepEqual([
      { source: '(list) => ({ items: list.children.length })', target: { kind: 'ref', ref: 'e3' }, timeoutMs: 2_000 },
    ]);
    should(ran).deepEqual({
      summary: 'Ran your script on %browser:app (now at https://app.test/).',
      output: '{"items":3}',
    });
  });

  it('should refuse it, for an agent and a person alike, with every way the owner can turn it on, while Page scripts is off', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    world.policy.off.add('scripts');
    const secret = 'document.cookie';

    // Act
    const byAgent = await refusal(
      world.service.call(agent, { tool: 'browser.eval', name: 'app', function: `() => ${secret}` }),
    );
    const byPerson = await refusal(
      world.service.call(person, { tool: 'browser.eval', name: 'app', function: `() => ${secret}` }),
    );

    // Assert
    should(byAgent.code).equal('forbidden');
    should(byAgent.message).equal(pageScriptsRefusal('fy'));
    should(byAgent.message).containEql('fy machine set agent-control scripts on');
    should(byAgent.message).containEql('Settings › this machine › What agents may control › Page scripts');
    should(byAgent.message).containEql('sign-ins on the shared profile');
    should(byPerson.message).equal(byAgent.message);
    should(world.browser.scripts).deepEqual([]);
    should(world.audit.entries.slice(-2).map(entry => entry.outcome)).deepEqual(['refused', 'refused']);
    should(JSON.stringify(world.audit.entries)).not.containEql(secret);
  });

  it('should still need the Browsers switch, and say that one first', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    world.policy.off.add('browser');

    // Act
    const refused = await refusal(
      world.service.call(agent, { tool: 'browser.eval', name: 'app', function: '() => 1' }),
    );

    // Assert
    should(refused.message).equal(controlRefusal('browser'));
  });

  it('should refuse a script queued when a person takes the page over, from inside the browser’s queue', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    const original = world.browser.scriptOnPage.bind(world.browser);
    world.browser.scriptOnPage = async (sessionId, key, script, guard) => {
      await world.control.takeover('s1', { surface: 'browser', id: 'page-1' }, { by: 'local' });
      return await original(sessionId, key, script, guard);
    };

    // Act
    const raced = await refusal(world.service.call(agent, { tool: 'browser.eval', name: 'app', function: '() => 1' }));

    // Assert
    should(raced.code).equal('taken_over');
    should(world.browser.scripts).deepEqual([]);
  });

  it('should mask every vault secret in what the script returned, and clip a long answer from its start', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    world.redactor.values.set('sk_live_51Hx', 'STRIPE_KEY');
    world.browser.scriptAnswer = '"key: sk_live_51Hx"';

    // Act
    const masked = await world.service.call(agent, { tool: 'browser.eval', name: 'app', function: '() => 1' });
    world.browser.scriptAnswer = `"${'x'.repeat(AGENT_TOOL_MAX_OUTPUT_CHARS + 100)}"`;
    const long = await world.service.call(agent, { tool: 'browser.eval', name: 'app', function: '() => 1' });

    // Assert
    should(masked.output).equal('"key: [redacted:STRIPE_KEY]"');
    should(long.output?.length).equal(AGENT_TOOL_MAX_OUTPUT_CHARS);
    should(long.output?.startsWith('"xxx')).be.true();
    should(long.summary).containEql('It was clipped to fit');
  });

  it('should audit a script by its length, its target and the length of its answer — never the text of either', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    world.browser.scriptAnswer = '"the-page-token-9f2c"';
    const source = '() => localStorage.getItem("token")';

    // Act
    await world.service.call(agent, {
      tool: 'browser.eval',
      name: 'app',
      function: source,
      selector: '#app',
      timeoutMs: 500,
    });

    // Assert
    should(world.audit.entries.at(-1)?.detail).deepEqual({
      tool: 'browser.eval',
      by: 'agent',
      surface: '%browser:app',
      functionLength: source.length,
      selector: '#app',
      timeoutMs: 500,
      resultLength: '"the-page-token-9f2c"'.length,
    });
    should(JSON.stringify(world.audit.entries)).not.containEql('localStorage');
    should(JSON.stringify(world.audit.entries)).not.containEql('9f2c');
  });

  it('should say a dialog the script opened is waiting, as every act does', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    world.browser.pendingDialog = { type: 'alert', message: 'Saved' };

    // Act
    const ran = await world.service.call(agent, {
      tool: 'browser.eval',
      name: 'app',
      function: '() => alert("Saved")',
    });

    // Assert
    should(ran.summary).containEql('A alert dialog is waiting on this page: "Saved"');
  });
});

describe('AgentToolService — the audit record', () => {
  it('should record every call by tool and surface name, with lengths and never the typed text', async () => {
    // Arrange
    const world = agentToolWorld();
    const secret = 'correct-horse-battery-staple';

    // Act
    await world.service.call(agent, {
      tool: 'terminal.open',
      name: 'dev',
      folder: '/srv',
      command: `export T=${secret}`,
    });
    await world.service.call(agent, { tool: 'terminal.send', name: 'dev', text: secret, keys: ['enter'] });
    await world.service.call(agent, { tool: 'terminal.read', name: 'dev', lines: 5 });
    await world.service.call(agent, { tool: 'terminal.wait', name: 'dev', text: secret, timeoutMs: 500 });
    await world.service.call(agent, { tool: 'terminal.wait', name: 'dev', exit: true });
    await world.service.call(agent, {
      tool: 'browser.open',
      name: 'app',
      url: `https://example.test/?token=${secret}`,
    });
    await world.service.call(agent, { tool: 'browser.open', name: 'docs' });
    await world.service.call(agent, { tool: 'browser.navigate', name: 'app', url: `https://login.test/#${secret}` });
    await world.service.call(agent, { tool: 'browser.click', name: 'app', selector: `button.${'x'.repeat(200)}` });
    await world.service.call(agent, { tool: 'browser.type', name: 'app', selector: '#password', text: secret });
    await world.service.call(agent, { tool: 'browser.read', name: 'app', mode: 'a11y' });
    await world.service.call(agent, { tool: 'browser.screenshot', name: 'app' });
    await world.service.call(agent, { tool: 'terminal.list' });
    await world.service.call(agent, { tool: 'terminal.close', name: 'dev' });

    // Assert
    should(JSON.stringify(world.audit.entries)).not.containEql(secret);
    should(world.audit.entries.every(entry => entry.event === 'agent.tool' && entry.subject === 's1')).be.true();
    should(world.audit.entries.every(entry => entry.actor.kind === 'host' && entry.detail?.by === 'agent')).be.true();
    should(world.audit.entries.map(entry => entry.detail)).deepEqual([
      { tool: 'terminal.open', by: 'agent', surface: '%terminal:dev', folder: true, command: true },
      { tool: 'terminal.send', by: 'agent', surface: '%terminal:dev', textLength: secret.length, keys: 1 },
      { tool: 'terminal.read', by: 'agent', surface: '%terminal:dev', lines: 5 },
      { tool: 'terminal.wait', by: 'agent', surface: '%terminal:dev', waitFor: 'text', timeoutMs: 500 },
      { tool: 'terminal.wait', by: 'agent', surface: '%terminal:dev', waitFor: 'exit', timeoutMs: 10_000 },
      { tool: 'browser.open', by: 'agent', surface: '%browser:app', host: 'example.test' },
      { tool: 'browser.open', by: 'agent', surface: '%browser:docs' },
      { tool: 'browser.navigate', by: 'agent', surface: '%browser:app', host: 'login.test' },
      { tool: 'browser.click', by: 'agent', surface: '%browser:app', selector: `button.${'x'.repeat(110)}...` },
      { tool: 'browser.type', by: 'agent', surface: '%browser:app', selector: '#password', textLength: secret.length },
      { tool: 'browser.read', by: 'agent', surface: '%browser:app', mode: 'a11y' },
      { tool: 'browser.screenshot', by: 'agent', surface: '%browser:app' },
      { tool: 'terminal.list', by: 'agent' },
      { tool: 'terminal.close', by: 'agent', surface: '%terminal:dev' },
    ]);
  });

  it('should record a person as themselves, and a refusal by the name that was asked for', async () => {
    // Arrange
    const world = agentToolWorld();

    // Act
    await refusal(world.service.call(person, { tool: 'terminal.read', name: 'ghost' }));
    await world.service.call(person, { tool: 'browser.read', name: 'app' }).catch(() => undefined);

    // Assert
    should(world.audit.entries).deepEqual([
      {
        event: 'agent.tool',
        actor: { kind: 'device', deviceId: 'phone-1' },
        subject: 's1',
        outcome: 'refused',
        detail: { tool: 'terminal.read', by: 'person', surface: '%terminal:ghost', lines: 200 },
      },
      {
        event: 'agent.tool',
        actor: { kind: 'device', deviceId: 'phone-1' },
        subject: 's1',
        outcome: 'refused',
        detail: { tool: 'browser.read', by: 'person', surface: '%browser:app', mode: 'text' },
      },
    ]);
  });

  it('should record a defect as failed and let it surface as itself', async () => {
    // Arrange
    const world = agentToolWorld();
    const defect = new Error('disk on fire');
    world.terminals.list = async () => {
      throw defect;
    };

    // Act
    const error = await world.service.call(agent, { tool: 'terminal.list' }).catch((failure: unknown) => failure);

    // Assert
    should(error).equal(defect);
    should(world.audit.entries).match([{ outcome: 'failed', detail: { tool: 'terminal.list' } }]);
  });
});

describe('AgentToolService — a takeover holds one tab, and only that tab', () => {
  it('should refuse the agent the tab a person holds, and let it keep working on every other', async () => {
    // Arrange — two pages; the person takes `login` to type a password.
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    await world.service.call(agent, { tool: 'browser.open', name: 'login' });

    // Act
    await world.service.control('s1', 'browser', { action: 'takeover', key: 'login' }, { by: 'local' }, person);
    world.browser.acts.length = 0;
    const onHeld = await Promise.all(
      [
        { tool: 'browser.read', name: 'login' },
        { tool: 'browser.type', name: 'login', selector: '#password', text: 'x' },
        { tool: 'browser.close', name: 'login' },
      ].map(async call => (await refusal(world.service.call(agent, call as never))).code),
    );
    const elsewhere = await world.service.call(agent, { tool: 'browser.click', name: 'app', selector: 'a' });
    const opened = await world.service.call(agent, { tool: 'browser.open', name: 'more' });

    // Assert
    should(onHeld).deepEqual(['taken_over', 'taken_over', 'taken_over']);
    should(elsewhere.summary).startWith('Done on %browser:app');
    should(opened.summary).startWith('Opened %browser:more');
    should(world.browser.acts).deepEqual(['s1:page-1:click']);
  });

  it('should open an incognito page, mark it, and record that it was incognito — never its contents', async () => {
    // Arrange
    const world = agentToolWorld();

    // Act
    const opened = await world.service.call(agent, {
      tool: 'browser.open',
      name: 'private',
      url: 'https://bank.test/?session=secret',
      incognito: true,
    });
    const listed = await world.service.call(agent, { tool: 'browser.list' });
    await world.service.call(agent, { tool: 'browser.type', name: 'private', selector: '#pin', text: '1234' });

    // Assert
    should(opened.summary).equal('Opened an incognito page, %browser:private at https://bank.test/?session=secret.');
    should(listed.surfaces?.[0]).match({ name: 'private', incognito: true, available: true });
    should(world.events.published[0]?.data).match({ name: 'private', incognito: true });
    should(world.audit.entries[0]?.detail).deepEqual({
      tool: 'browser.open',
      by: 'agent',
      surface: '%browser:private',
      host: 'bank.test',
      incognito: true,
    });
    should(JSON.stringify(world.audit.entries)).not.containEql('1234');
  });

  it('should refuse an act already queued when the takeover lands, from inside the browser’s queue', async () => {
    // Arrange — the guard runs where the real service runs it; a takeover between the agent's checks
    // and its turn in the queue still wins.
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    const original = world.browser.actOnPage.bind(world.browser);
    world.browser.actOnPage = async (sessionId, key, action, guard) => {
      await world.control.takeover('s1', { surface: 'browser', id: 'page-1' }, { by: 'local' });
      return await original(sessionId, key, action, guard);
    };

    // Act
    const raced = await refusal(world.service.call(agent, { tool: 'browser.click', name: 'app', selector: 'a' }));

    // Assert
    should(raced.code).equal('taken_over');
    should(world.browser.acts).deepEqual([]);
  });

  it('should tell an agent that a page is asking for a human check, and that the owner solves it', async () => {
    // Arrange — the page the agent acted on appears to show a captcha.
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    const original = world.browser.actOnPage.bind(world.browser);
    world.browser.actOnPage = async (sessionId, key, action, guard) => {
      const answer = await original(sessionId, key, action, guard);
      if (!('result' in answer)) return answer;
      const pages = answer.result.pages.map(page => ({ ...page, challenge: { provider: 'cloudflare' as const } }));
      return { ...answer, result: { ...answer.result, pages } };
    };

    // Act
    const navigated = await world.service.call(agent, {
      tool: 'browser.navigate',
      name: 'app',
      url: 'https://shop.test/',
    });
    const read = await world.service.call(agent, { tool: 'browser.read', name: 'app' });
    const shot = await world.service.call(agent, { tool: 'browser.screenshot', name: 'app' });

    // Assert
    for (const result of [navigated, read, shot]) {
      should(result.summary).containEql('appears to be showing a human check');
      should(result.summary).containEql('ask your owner to take the page over');
    }
  });

  it('should stop an agent’s wait the moment a person takes the terminal over', async () => {
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });
    world.terminals.foregrounds.set('000000000001', ['sleep']);
    world.onSleep.push(async () => {
      await world.service.control('s1', 'terminal', { action: 'takeover', key: 'dev' }, { by: 'local' }, person);
    });
    const stopped = await refusal(world.service.call(agent, { tool: 'terminal.wait', name: 'dev', exit: true }));
    should(stopped.code).equal('taken_over');
    should(world.slept).have.length(1);
  });
});

describe('AgentToolService — an agent acts only on what it opened, or was handed', () => {
  it('should refuse the agent a terminal and a page a person opened, and say how to get one', async () => {
    // Arrange — the person's own shell, in the agent's session (say, for sudo), and their own page.
    const world = agentToolWorld();
    await world.service.call(person, { tool: 'terminal.open', name: 'mine' });
    await world.terminals.create('s1', {});
    await world.service.call(person, { tool: 'browser.open', name: 'bank' });

    // Act
    const read = await refusal(world.service.call(agent, { tool: 'terminal.read', name: 'mine' }));
    const typed = await refusal(world.service.call(agent, { tool: 'terminal.send', name: 'mine', text: 'id' }));
    const unrecorded = await refusal(world.service.call(agent, { tool: 'terminal.read', name: '000000000002' }));
    const page = await refusal(world.service.call(agent, { tool: 'browser.screenshot', name: 'bank' }));
    const terminals = await world.service.call(agent, { tool: 'terminal.list' });
    const pages = await world.service.call(person, { tool: 'browser.list' });

    // Assert
    should(read).match({
      code: 'forbidden',
      message:
        "%terminal:mine is a person's, not yours: you may use it only if they hand it to you. Ask them, or open your own.",
    });
    should([typed.code, unrecorded.code, page.code]).deepEqual(['forbidden', 'forbidden', 'forbidden']);
    should(world.terminals.typed.size).equal(0);
    should(world.browser.acts).deepEqual([]);
    // The agent's listing does not so much as name a surface it may not use.
    should(terminals).deepEqual({ summary: 'No terminals are open for you in this session.', surfaces: [] });
    // A person's own listing carries no availability: it is all theirs.
    should(pages.surfaces?.[0]).not.have.property('available');
  });

  it('should let the agent use a surface a person handed to it, once, recorded and journaled', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(person, { tool: 'terminal.open', name: 'mine' });
    await world.service.call(person, { tool: 'browser.open', name: 'bank' });

    // Act
    const view = await world.service.control(
      's1',
      'terminal',
      { action: 'handover', key: 'mine' },
      { by: 'local' },
      person,
    );
    await world.service.control('s1', 'terminal', { action: 'handover', key: 'mine' }, { by: 'local' }, person);
    await world.service.control('s1', 'browser', { action: 'handover', key: 'bank' }, { by: 'local' }, person);
    const sent = await world.service.call(agent, { tool: 'terminal.send', name: 'mine', text: 'ls' });
    const shot = await world.service.call(agent, { tool: 'browser.screenshot', name: 'bank' });
    const listed = await world.service.call(agent, { tool: 'terminal.list' });

    // Assert
    should(view.handed).deepEqual([
      { surface: 'terminal', id: '000000000001', name: 'mine', by: { by: 'local' }, at: '2026-10-16T10:00:00.000Z' },
    ]);
    should(sent.summary).equal('Sent 2 characters to %terminal:mine.');
    should(shot.screenshotBase64).equal('iVBORw0KGgo=');
    should(listed.surfaces?.[0]?.available).be.true();
    should(world.events.published.filter(event => event.type === 'surface.handed')).have.length(2);
    should(world.audit.entries.filter(entry => entry.detail?.action === 'handover')).have.length(3);
  });
});

describe('AgentToolService — what an agent may see', () => {
  it("should keep a person's page — its name, URL and title — out of the agent's list until it is handed over", async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'docs', url: 'https://docs.example.test/' });
    await world.service.call(person, { tool: 'browser.open', name: 'bank', url: 'https://bank.example.test/acct' });
    const personView = await world.service.call(person, { tool: 'browser.list' });
    const secret = personView.surfaces?.find(surface => surface.name === 'bank');

    // Act
    const before = await world.service.call(agent, { tool: 'browser.list' });
    await world.service.control('s1', 'browser', { action: 'handover', key: 'bank' }, { by: 'local' }, person);
    const after = await world.service.call(agent, { tool: 'browser.list' });

    // Assert
    should(secret).match({ url: 'https://bank.example.test/acct' });
    const hidden = JSON.stringify(before);
    should(hidden).not.containEql('bank');
    should(hidden).not.containEql(secret?.url ?? 'unset');
    should(hidden).not.containEql(secret?.id ?? 'unset');
    should(secret?.title).equal('Page at bank.example.test');
    should(hidden).not.containEql(secret?.title ?? 'unset');
    should(before.summary).equal('1 browser page: %browser:docs.');
    should(after.surfaces?.map(surface => surface.name)).deepEqual(['docs', 'bank']);
    should(after.surfaces?.find(surface => surface.name === 'bank')).match({
      url: 'https://bank.example.test/acct',
      available: true,
    });
  });
});

describe('AgentToolService — takeovers and hand-overs outlive a restart', () => {
  it('should rebuild them from the session journal the first time the session is asked about', async () => {
    // Arrange — a previous daemon run took `dev` over, took and handed back `old`, and handed `mine` on.
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });
    await world.service.call(person, { tool: 'terminal.open', name: 'mine' });
    const fresh = agentToolWorld();
    fresh.terminals.create = world.terminals.create.bind(world.terminals);
    fresh.terminals.list = world.terminals.list.bind(world.terminals);
    fresh.terminals.write = world.terminals.write.bind(world.terminals);
    fresh.events.earlier.set('s1', [
      {
        type: 'surface.asked',
        data: {
          surface: 'terminal',
          id: '000000000001',
          name: 'dev',
          agentSessionId: 's1',
          at: '2026-10-16T09:00:00.000Z',
        },
      },
      { type: 'surface.takeover', data: { surface: 'terminal', id: '000000000001', by: { by: 'local' }, since: 'x' } },
      {
        type: 'surface.takeover',
        data: {
          surface: 'terminal',
          id: '000000000001',
          name: 'dev',
          by: { by: 'local' },
          since: '2026-10-16T09:00:00.000Z',
        },
      },
      {
        type: 'surface.takeover',
        data: { surface: 'terminal', id: 'abc', by: { by: 'local' }, since: '2026-10-16T09:00:00.000Z' },
      },
      { type: 'surface.handback', data: { surface: 'terminal', id: 'abc', at: '2026-10-16T09:01:00.000Z' } },
      { type: 'surface.handback', data: { id: 'abc' } },
      {
        type: 'surface.handed',
        data: { surface: 'terminal', id: '000000000002', by: { by: 'local' }, at: '2026-10-16T09:02:00.000Z' },
      },
      { type: 'surface.handed', data: 'nonsense' },
      { type: 'surface.driving', data: {} },
      {
        type: 'surface.opened',
        data: {
          surface: 'terminal',
          id: '000000000001',
          name: 'dev',
          agentSessionId: 's1',
          at: '2026-10-16T09:00:00.000Z',
        },
      },
      { type: 'surface.opened', data: 'nonsense' },
      {
        type: 'surface.asked',
        data: {
          surface: 'terminal',
          id: '000000000002',
          name: 'mine',
          agentSessionId: 's1',
          at: '2026-10-16T09:00:00.000Z',
        },
      },
      { type: 'surface.asked', data: 7 },
    ]);
    fresh.events.unreadable = 1;

    // Act — the first read of the journal fails and is retried, never remembered as empty.
    const unreadable = await fresh.service
      .call(agent, { tool: 'terminal.send', name: 'dev', text: 'ls' })
      .catch((error: unknown) => error);
    const held = await refusal(fresh.service.call(agent, { tool: 'terminal.send', name: 'dev', text: 'ls' }));
    const handed = await fresh.service.call(agent, { tool: 'terminal.send', name: 'mine', text: 'ls' });
    const view = await fresh.service.controlView('s1', 'terminal');

    // Assert
    should((unreadable as Error).message).equal('the journal could not be read');
    should(held.code).equal('taken_over');
    should(handed.summary).equal('Sent 2 characters to %terminal:mine.');
    should(view.takeovers.map(takeover => takeover.id)).deepEqual(['000000000001']);
    // The ask on `dev` ended with the takeover that followed it; the one on `mine` still stands.
    should(view.opened.map(entry => entry.id)).deepEqual(['000000000001']);
    should(view.asked.map(entry => entry.id)).deepEqual(['000000000002']);
    should(fresh.events.reads).equal(2);
  });
});

describe('AgentToolService — a page’s dialogs', () => {
  it('should answer the dialog, say which kind it was, and audit it by kind and answer — never what was typed', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    world.browser.lifecycleReplies.push({
      reply: { text: 'accepted the prompt dialog: Your name?', dialogType: 'prompt' },
    });

    // Act
    const answered = await world.service.call(agent, {
      tool: 'browser.dialog',
      name: 'app',
      action: 'accept',
      promptText: 'correct-horse-battery',
    });

    // Assert
    should(answered.summary).equal('On %browser:app: accepted the prompt dialog: Your name?.');
    should(world.browser.lifecycles).deepEqual([
      { op: 'dialog', action: 'accept', promptText: 'correct-horse-battery' },
    ]);
    should(world.audit.entries.at(-1)?.detail).deepEqual({
      tool: 'browser.dialog',
      by: 'agent',
      surface: '%browser:app',
      action: 'accept',
      promptTextLength: 21,
      dialogType: 'prompt',
      accepted: true,
    });
    should(JSON.stringify(world.audit.entries)).not.containEql('correct-horse-battery');
  });

  it('should audit a dismiss, and leave the answer out when the browser did not say what kind it was', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });

    // Act
    await world.service.call(agent, { tool: 'browser.dialog', name: 'app', action: 'dismiss' });

    // Assert
    should(world.browser.lifecycles).deepEqual([{ op: 'dialog', action: 'dismiss' }]);
    should(world.audit.entries.at(-1)?.detail).deepEqual({
      tool: 'browser.dialog',
      by: 'agent',
      surface: '%browser:app',
      action: 'dismiss',
    });
  });

  it('should mask a vault secret in a dialog message, in the answer and in a dialog that is still waiting', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    world.redactor.values.set('sk_live_51Hx', 'STRIPE_KEY');
    world.browser.lifecycleReplies.push({
      reply: { text: 'dismissed the alert dialog: key sk_live_51Hx', dialogType: 'alert' },
      dialog: { type: 'confirm', message: 'Use sk_live_51Hx?' },
    });

    // Act
    const answered = await world.service.call(agent, { tool: 'browser.dialog', name: 'app', action: 'dismiss' });

    // Assert
    should(answered.summary).containEql('key [redacted:STRIPE_KEY]');
    should(answered.summary).containEql('A confirm dialog is waiting on this page: "Use [redacted:STRIPE_KEY]?".');
    should(JSON.stringify(answered)).not.containEql('sk_live_51Hx');
  });

  it('should report a waiting dialog in the result of every act on that page, scrubbed, with the way out', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    world.redactor.values.set('hunter2', 'PW');
    world.browser.pendingDialog = { type: 'confirm', message: 'Delete hunter2?' };

    // Act
    const clicked = await world.service.call(agent, { tool: 'browser.click', name: 'app', selector: 'button' });
    const read = await world.service.call(agent, { tool: 'browser.read', name: 'app' });

    // Assert
    for (const result of [clicked, read]) {
      should(result.summary).containEql('A confirm dialog is waiting on this page: "Delete [redacted:PW]?".');
      should(result.summary).containEql('use browser.dialog with accept or dismiss');
    }
    should(JSON.stringify([clicked, read])).not.containEql('hunter2');
  });

  it('should say nothing of dialogs when the page has none', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });

    // Act
    const clicked = await world.service.call(agent, { tool: 'browser.click', name: 'app', selector: 'button' });

    // Assert
    should(clicked.summary).not.containEql('dialog');
  });
});

describe('AgentToolService — waiting on a page', () => {
  const open = async () => {
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    return world;
  };

  it('should stop at once when the condition holds, and ask the browser for one slice of it', async () => {
    // Arrange
    const world = await open();
    world.browser.lifecycleReplies.push({ reply: { text: 'condition met', matched: true } });

    // Act
    const result = await world.service.call(agent, { tool: 'browser.wait_for', name: 'app', text: 'Welcome' });

    // Assert
    should(result).deepEqual({ summary: 'The wait on %browser:app is over: it happened.', matched: true });
    should(world.browser.lifecycles).deepEqual([
      { op: 'wait', condition: { kind: 'text', text: 'Welcome' }, timeoutMs: 1_000 },
    ]);
  });

  it('should ask for each kind of condition in the shape the browser knows', async () => {
    // Arrange
    const world = await open();
    for (let call = 0; call < 6; call += 1)
      world.browser.lifecycleReplies.push({ reply: { text: 'condition met', matched: true } });

    // Act
    await world.service.call(agent, { tool: 'browser.wait_for', name: 'app', ref: 'e3', state: 'hidden' });
    await world.service.call(agent, { tool: 'browser.wait_for', name: 'app', selector: '#go' });
    await world.service.call(agent, { tool: 'browser.wait_for', name: 'app', textGone: 'Loading' });
    await world.service.call(agent, { tool: 'browser.wait_for', name: 'app', url: '/home' });
    await world.service.call(agent, { tool: 'browser.wait_for', name: 'app', load: 'networkidle' });

    // Assert
    should(world.browser.lifecycles.map(request => (request.op === 'wait' ? request.condition : undefined))).deepEqual([
      { kind: 'element', target: { kind: 'ref', ref: 'e3' }, state: 'hidden' },
      { kind: 'element', target: { kind: 'selector', selector: '#go' }, state: 'visible' },
      { kind: 'textGone', text: 'Loading' },
      { kind: 'url', url: '/home' },
      { kind: 'load', state: 'networkidle' },
    ]);
  });

  it('should wait a second at a time, and give up with the whole timeout told', async () => {
    // Arrange
    const world = await open();
    for (let call = 0; call < 3; call += 1)
      world.browser.lifecycleReplies.push({ reply: { text: 'condition not met yet', matched: false } });

    // Act
    const result = await world.service.call(agent, {
      tool: 'browser.wait_for',
      name: 'app',
      text: 'Never',
      timeoutMs: 2_500,
    });

    // Assert
    should(result.matched).be.false();
    should(result.summary).equal('Still waiting on %browser:app: the wait timed out after 2500 ms.');
    should(world.browser.lifecycles.map(request => (request.op === 'wait' ? request.timeoutMs : 0))).deepEqual([
      1_000, 1_000, 500,
    ]);
  });

  it('should stop a wait when the clock says the time is up, even if slices are still coming back', async () => {
    // Arrange
    const world = await open();
    world.browser.beforeLifecycle.push(() => {
      world.clock.ms += 60_000;
    });

    // Act
    const result = await world.service.call(agent, {
      tool: 'browser.wait_for',
      name: 'app',
      text: 'Never',
      timeoutMs: 5_000,
    });

    // Assert
    should(result.matched).be.false();
    should(world.browser.lifecycles).have.length(1);
  });

  it('should end a wait when a dialog blocks the page, and say what it asks', async () => {
    // Arrange
    const world = await open();
    world.browser.lifecycleReplies.push({
      reply: { text: 'condition not met yet', matched: false },
      dialog: { type: 'alert', message: 'Session expired' },
    });

    // Act
    const result = await world.service.call(agent, { tool: 'browser.wait_for', name: 'app', text: 'Never' });

    // Assert
    should(result.matched).be.false();
    should(result.summary).containEql('the page is blocked by a dialog');
    should(result.summary).containEql('"Session expired"');
    should(world.browser.lifecycles).have.length(1);
  });

  it('should sleep a plain wait here, a second at a time', async () => {
    // Arrange
    const world = await open();

    // Act
    const result = await world.service.call(agent, { tool: 'browser.wait_for', name: 'app', time: 2_500 });

    // Assert
    should(result).deepEqual({ summary: 'Waited 2500 ms on %browser:app.', matched: true });
    should(world.slept).deepEqual([1_000, 1_000, 500]);
    should(world.browser.lifecycles).deepEqual([]);
  });

  it('should stop a plain wait the moment a person takes the page over', async () => {
    // Arrange
    const world = await open();
    world.onSleep.push(async () => {
      await world.service.control('s1', 'browser', { action: 'takeover', key: 'app' }, { by: 'local' }, person);
    });

    // Act
    const stopped = await refusal(world.service.call(agent, { tool: 'browser.wait_for', name: 'app', time: 5_000 }));

    // Assert
    should(stopped.code).equal('taken_over');
    should(world.slept).have.length(1);
  });

  it('should stop a wait between slices the moment a person takes the page over', async () => {
    // Arrange
    const world = await open();
    world.browser.lifecycleReplies.push({ reply: { text: 'condition not met yet', matched: false } });
    world.browser.beforeLifecycle.push(
      async () => undefined,
      async () => {
        await world.service.control('s1', 'browser', { action: 'takeover', key: 'app' }, { by: 'local' }, person);
      },
    );

    // Act
    const stopped = await refusal(
      world.service.call(agent, { tool: 'browser.wait_for', name: 'app', text: 'Never', timeoutMs: 5_000 }),
    );

    // Assert
    should(stopped.code).equal('taken_over');
    should(world.browser.lifecycles).have.length(1);
  });

  it('should audit a wait by what it waited for and how long, never by the text or address', async () => {
    // Arrange
    const world = await open();
    const secret = 'correct-horse-battery';
    for (let call = 0; call < 3; call += 1)
      world.browser.lifecycleReplies.push({ reply: { text: 'condition met', matched: true } });

    // Act
    await world.service.call(agent, { tool: 'browser.wait_for', name: 'app', text: secret, timeoutMs: 3_000 });
    await world.service.call(agent, { tool: 'browser.wait_for', name: 'app', url: `/${secret}` });
    await world.service.call(agent, { tool: 'browser.wait_for', name: 'app', selector: `#${secret}` });

    // Assert
    should(world.audit.entries.slice(-3).map(entry => entry.detail)).deepEqual([
      { tool: 'browser.wait_for', by: 'agent', surface: '%browser:app', waitKind: 'text', timeoutMs: 3_000 },
      { tool: 'browser.wait_for', by: 'agent', surface: '%browser:app', waitKind: 'url', timeoutMs: 10_000 },
      { tool: 'browser.wait_for', by: 'agent', surface: '%browser:app', waitKind: 'element', timeoutMs: 10_000 },
    ]);
    should(JSON.stringify(world.audit.entries)).not.containEql(secret);
  });
});

describe('AgentToolService — a page’s console, requests and device', () => {
  const open = async () => {
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    return world;
  };

  it('should hand back the console, scrubbed, with the level and position asked for', async () => {
    // Arrange
    const world = await open();
    world.redactor.values.set('sk_live_51Hx', 'STRIPE_KEY');
    world.browser.lifecycleReplies.push({
      reply: { text: '#4 [error] failed with sk_live_51Hx\nlast entry #4: ask with since: 4 for what comes after' },
    });

    // Act
    const result = await world.service.call(agent, {
      tool: 'browser.console',
      name: 'app',
      level: 'error',
      since: 3,
      limit: 20,
    });

    // Assert
    should(result.summary).equal('The console of %browser:app.');
    should(result.output).containEql('#4 [error] failed with [redacted:STRIPE_KEY]');
    should(JSON.stringify(result)).not.containEql('sk_live_51Hx');
    should(world.browser.lifecycles).deepEqual([{ op: 'console', level: 'error', since: 3, limit: 20 }]);
    should(world.audit.entries.at(-1)?.detail).deepEqual({
      tool: 'browser.console',
      by: 'agent',
      surface: '%browser:app',
      level: 'error',
      since: 3,
      limit: 20,
    });
  });

  it('should ask for the whole console when nothing narrows it', async () => {
    // Arrange
    const world = await open();

    // Act
    await world.service.call(agent, { tool: 'browser.console', name: 'app' });

    // Assert
    should(world.browser.lifecycles).deepEqual([{ op: 'console' }]);
  });

  it('should list requests and show one, scrubbed, auditing the filter by its length only', async () => {
    // Arrange
    const world = await open();
    world.redactor.values.set('sk_live_51Hx', 'STRIPE_KEY');
    world.browser.lifecycleReplies.push(
      { reply: { text: 'r1 GET 200 fetch 1.0KB 12ms https://api.test/keys?k=sk_live_51Hx' } },
      { reply: { text: 'r1 GET 200 fetch 1.0KB 12ms https://api.test/keys\n\n{"key":"sk_live_51Hx"}' } },
    );

    // Act
    const listed = await world.service.call(agent, {
      tool: 'browser.network',
      name: 'app',
      action: 'list',
      filter: 'api.test',
      types: ['fetch', 'xhr'],
    });
    const shown = await world.service.call(agent, { tool: 'browser.network', name: 'app', action: 'get', id: 'r1' });

    // Assert
    should(listed.summary).equal('The requests of %browser:app.');
    should(listed.output).containEql('k=[redacted:STRIPE_KEY]');
    should(shown.summary).equal('Request r1 of %browser:app.');
    should(shown.output).containEql('{"key":"[redacted:STRIPE_KEY]"}');
    should(JSON.stringify([listed, shown])).not.containEql('sk_live_51Hx');
    should(world.browser.lifecycles).deepEqual([
      { op: 'network', action: 'list', filter: 'api.test', types: ['fetch', 'xhr'] },
      { op: 'network', action: 'get', id: 'r1' },
    ]);
    should(world.audit.entries.slice(-2).map(entry => entry.detail)).deepEqual([
      { tool: 'browser.network', by: 'agent', surface: '%browser:app', action: 'list', filterLength: 8, types: 2 },
      { tool: 'browser.network', by: 'agent', surface: '%browser:app', action: 'get' },
    ]);
  });

  it('should emulate only what was asked, and audit the names of the fields and none of their values', async () => {
    // Arrange
    const world = await open();
    world.browser.lifecycleReplies.push({ reply: { text: 'Emulating: viewport 390x844; locale de-DE' } });

    // Act
    const result = await world.service.call(agent, {
      tool: 'browser.emulate',
      name: 'app',
      viewport: { width: 390, height: 844 },
      locale: 'de-DE',
    });
    await world.service.call(agent, { tool: 'browser.emulate', name: 'app', reset: true });

    // Assert
    should(result.summary).equal('Emulating: viewport 390x844; locale de-DE on %browser:app.');
    should(world.browser.lifecycles).deepEqual([
      { op: 'emulate', emulation: { viewport: { width: 390, height: 844 }, locale: 'de-DE' } },
      { op: 'emulate', emulation: { reset: true } },
    ]);
    should(world.audit.entries.slice(-2).map(entry => entry.detail)).deepEqual([
      { tool: 'browser.emulate', by: 'agent', surface: '%browser:app', fields: 'viewport,locale' },
      { tool: 'browser.emulate', by: 'agent', surface: '%browser:app', fields: 'reset' },
    ]);
  });

  it('should refuse each lifecycle tool on a page a person holds, and never reach the browser', async () => {
    // Arrange
    const world = await open();
    await world.service.control('s1', 'browser', { action: 'takeover', key: 'app' }, { by: 'local' }, person);

    // Act
    const codes = await Promise.all(
      [
        { tool: 'browser.dialog', name: 'app', action: 'dismiss' },
        { tool: 'browser.wait_for', name: 'app', text: 'x' },
        { tool: 'browser.wait_for', name: 'app', time: 100 },
        { tool: 'browser.console', name: 'app' },
        { tool: 'browser.network', name: 'app', action: 'list' },
        { tool: 'browser.emulate', name: 'app', reset: true },
      ].map(async call => (await refusal(world.service.call(agent, call as never))).code),
    );

    // Assert
    should(codes).deepEqual(Array(6).fill('taken_over'));
    should(world.browser.lifecycles).deepEqual([]);
  });

  it('should refuse each lifecycle tool on a page a person opened, and let the person use them on their own', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(person, { tool: 'browser.open', name: 'bank' });

    // Act
    const refused = await refusal(world.service.call(agent, { tool: 'browser.console', name: 'bank' }));
    const mine = await world.service.call(person, { tool: 'browser.console', name: 'bank' });

    // Assert
    should(refused.code).equal('forbidden');
    should(mine.summary).equal('The console of %browser:bank.');
    should(world.browser.lifecycles).have.length(1);
  });

  it('should refuse the tools when the machine’s browser control is switched off', async () => {
    // Arrange
    const world = await open();
    world.policy.off.add('browser');

    // Act
    const refused = await refusal(world.service.call(agent, { tool: 'browser.emulate', name: 'app', reset: true }));

    // Assert
    should(refused.code).equal('forbidden');
    should(world.browser.lifecycles).deepEqual([]);
  });

  it('should withhold a log, rather than serve it unmasked, when the vault cannot be opened', async () => {
    // Arrange
    const world = await open();
    world.redactor.locked = true;

    // Act
    const refused = await refusal(world.service.call(agent, { tool: 'browser.console', name: 'app' }));

    // Assert
    should(refused.code).equal('unavailable');
  });
});

describe('AgentToolService — popups and tabs', () => {
  const opened = async () => {
    const world = agentToolWorld();
    const app = await world.browser.openPage('s1', 'app', { openedBy: { by: 'agent', sessionId: 's1' } });
    return { world, app };
  };

  it('should let the agent use a popup its own page opened, with the opener recorded by the browser', async () => {
    // Arrange
    const { world, app } = await opened();
    world.browser.popup('s1', app.id);

    // Act
    const read = await world.service.call(agent, { tool: 'browser.read', name: 'popup-1' });
    const listed = await world.service.call(agent, { tool: 'browser.list' });

    // Assert
    should(read.output).not.be.undefined();
    should(listed.surfaces?.find(row => row.id === 'popup-1')).match({ openerId: app.id, available: true });
  });

  it('should follow a chain of popups back to a page the agent opened, and stop at one it did not', async () => {
    // Arrange
    const { world, app } = await opened();
    world.browser.popup('s1', app.id, 'popup-1');
    world.browser.popup('s1', 'popup-1', 'popup-2');
    world.browser.popup('s1', 'popup-9', 'popup-3');
    world.browser.popup('s1', 'popup-3', 'popup-4');

    // Act
    const deep = await world.service.call(agent, { tool: 'browser.read', name: 'popup-2' });
    const orphan = await refusal(world.service.call(agent, { tool: 'browser.read', name: 'popup-4' }));

    // Assert
    should(deep.output).not.be.undefined();
    should(orphan.code).equal('forbidden');
  });

  it('should refuse a popup of a page a person opened, until the person hands that page over', async () => {
    // Arrange
    const world = agentToolWorld();
    const bank = await world.browser.openPage('s1', 'bank', { openedBy: { by: 'human', deviceId: 'phone-1' } });
    world.browser.popup('s1', bank.id);

    // Act
    const refused = await refusal(world.service.call(agent, { tool: 'browser.read', name: 'popup-1' }));
    await world.service.control('s1', 'browser', { action: 'handover', key: 'bank' }, { by: 'local' }, person);
    const allowed = await world.service.call(agent, { tool: 'browser.read', name: 'popup-1' });

    // Assert
    should(refused.code).equal('forbidden');
    should(allowed.output).not.be.undefined();
  });

  it('should not follow an opener chain deeper than eight pages', async () => {
    // Arrange
    const { world, app } = await opened();
    let opener = app.id;
    for (let depth = 1; depth <= 10; depth += 1) {
      world.browser.popup('s1', opener, `popup-${String(depth)}`);
      opener = `popup-${String(depth)}`;
    }

    // Act
    const near = await world.service.call(agent, { tool: 'browser.read', name: 'popup-8' });
    const far = await refusal(world.service.call(agent, { tool: 'browser.read', name: 'popup-10' }));

    // Assert
    should(near.output).not.be.undefined();
    should(far.code).equal('forbidden');
  });

  it('should list tabs and tell the agent which popups have no name yet, and how to take one', async () => {
    // Arrange
    const { world, app } = await opened();
    world.browser.popup('s1', app.id);

    // Act
    const listed = await world.service.call(agent, { tool: 'browser.tabs', action: 'list' });
    const quiet = await world.service.call(agent, { tool: 'browser.list' });

    // Assert
    should(listed.surfaces).have.length(2);
    should(listed.summary).containEql('Popups with no name yet: popup-1');
    should(listed.summary).containEql('browser.tabs');
    should(quiet.summary).not.containEql('Popups with no name yet');
    should(world.audit.entries.at(-2)?.detail).deepEqual({ tool: 'browser.tabs', by: 'agent', action: 'list' });
  });

  it('should list tabs plainly when there is no popup', async () => {
    // Arrange
    const { world } = await opened();

    // Act
    const listed = await world.service.call(agent, { tool: 'browser.tabs', action: 'list' });

    // Assert
    should(listed.summary).not.containEql('Popups');
  });

  it('should adopt a popup under a name, credit the agent with it, announce it and then use it by that name', async () => {
    // Arrange
    const { world, app } = await opened();
    world.browser.popup('s1', app.id);

    // Act
    const adopted = await world.service.call(agent, {
      tool: 'browser.tabs',
      action: 'adopt',
      id: 'popup-1',
      as: 'checkout',
    });
    const read = await world.service.call(agent, { tool: 'browser.read', name: 'checkout' });

    // Assert
    should(adopted.summary).equal(
      'Adopted the popup popup-1 (opened by page-1) as %browser:checkout. Use it by that name.',
    );
    should(world.browser.adopted).deepEqual([
      { id: 'popup-1', name: 'checkout', openedBy: { by: 'agent', sessionId: 's1' } },
    ]);
    should(read.output).not.be.undefined();
    should(world.events.published.some(event => event.type === 'surface.opened')).be.true();
    should(world.audit.entries.find(entry => entry.detail?.tool === 'browser.tabs')?.detail).deepEqual({
      tool: 'browser.tabs',
      by: 'agent',
      surface: '%browser:checkout',
      action: 'adopt',
    });
  });

  it('should refuse to adopt a page that is not a popup, one that is named, or a popup that is not the agent’s', async () => {
    // Arrange
    const { world, app } = await opened();
    world.browser.popup('s1', app.id);
    await world.browser.adoptPage('s1', 'popup-1', 'taken');
    world.browser.popup('s1', 'person-page', 'popup-2');

    // Act
    const notPopup = await refusal(
      world.service.call(agent, { tool: 'browser.tabs', action: 'adopt', id: app.id, as: 'again' }),
    );
    const named = await refusal(
      world.service.call(agent, { tool: 'browser.tabs', action: 'adopt', id: 'popup-1', as: 'other' }),
    );
    const foreign = await refusal(
      world.service.call(agent, { tool: 'browser.tabs', action: 'adopt', id: 'popup-2', as: 'mine' }),
    );
    const unknown = await refusal(
      world.service.call(agent, { tool: 'browser.tabs', action: 'adopt', id: 'nowhere', as: 'mine' }),
    );

    // Assert
    should(notPopup).match({ code: 'bad_request', message: /is not a popup/u });
    should(named.code).equal('conflict');
    should(foreign.code).equal('forbidden');
    should(unknown.code).equal('not_found');
  });

  it('should let a person adopt a popup as their own', async () => {
    // Arrange
    const world = agentToolWorld();
    const bank = await world.browser.openPage('s1', 'bank');
    world.browser.popup('s1', bank.id);

    // Act
    const adopted = await world.service.call(person, {
      tool: 'browser.tabs',
      action: 'adopt',
      id: 'popup-1',
      as: 'pay',
    });

    // Assert
    should(adopted.summary).containEql('%browser:pay');
    should(world.browser.adopted).deepEqual([
      { id: 'popup-1', name: 'pay', openedBy: { by: 'human', deviceId: 'phone-1' } },
    ]);
  });
});
