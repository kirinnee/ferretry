import { describe, it } from 'bun:test';
import should from 'should';
import {
  AGENT_TOOL_POLL_MS,
  AgentToolError,
  BrowserSessionError,
  BrowserTransportError,
  browserUnavailable,
  TerminalMountError,
} from '../../../src/lib/index.ts';
import { AGENT_TOOL_MAX_OUTPUT_CHARS } from '@ferretry/protocol';
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
