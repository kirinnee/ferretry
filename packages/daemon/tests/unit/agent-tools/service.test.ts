import { describe, it } from 'bun:test';
import should from 'should';
import {
  AGENT_TOOL_POLL_MS,
  AgentToolError,
  BrowserSessionError,
  browserUnavailable,
  TerminalMountError,
} from '../../../src/lib/index.ts';
import { agent, agentToolWorld, otherAgent, person } from './support.ts';

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
    should(listed.surfaces).deepEqual([{ id: '000000000001', name: 'dev', title: 'Terminal 1' }]);
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
    should(empty).deepEqual({ summary: 'No terminals are open in this session.', surfaces: [] });
  });

  it('should list an unnamed terminal by its id, and act on it by that id', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.terminals.create('s1', {});

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
    should(world.service.controlView('s1').takeovers).deepEqual([]);
  });

  it('should take over a browser page by name, and say which surface in a refusal of an unnamed one', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    await world.terminals.create('s1', {});

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
    ]);
  });

  it('should not fail an act that happened because the journal could not take its marker', async () => {
    const world = agentToolWorld();
    world.events.failing = true;
    should((await world.service.call(otherAgent, { tool: 'terminal.open', name: 'dev' })).summary).equal(
      'Opened %terminal:dev.',
    );
    should(world.service.controlView('s2').driving).have.length(1);
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
    should(listed.surfaces).deepEqual([{ id: 'page-1', name: 'app', title: '', url: 'http://localhost:5173/' }]);
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
      'No browser pages are open in this session.',
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
