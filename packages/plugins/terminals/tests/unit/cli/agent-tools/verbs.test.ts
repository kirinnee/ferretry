import { describe, it } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import should from 'should';
import { TerminalToolsClient, type ToolCaller } from '../../../../cli/lib/agent-tools/client.ts';
import { TerminalVerbs } from '../../../../cli/lib/agent-tools/controller.ts';
import { capturedIo, invocation, type RecordedCall, recordingClient } from '../../../support/cli/doubles.ts';

const OPENED = { text: 'Opened %terminal:dev.', data: { summary: 'Opened %terminal:dev.' } };

function harness(reply: (call: RecordedCall) => unknown = () => OPENED) {
  const { calls, client } = recordingClient(reply);
  const io = capturedIo();
  return { calls, io, sut: new TerminalVerbs(new TerminalToolsClient(client), io) };
}

/** A client that also offers the shell's tool dispatch, recording each tool call. */
function toolHarness(answers: readonly unknown[]) {
  const tools: { name: string; input: unknown }[] = [];
  let next = 0;
  const client: PluginClient & ToolCaller = {
    call: async () => {
      throw new Error('no route expected');
    },
    subscribe: () => () => undefined,
    tool: async (name, input) => {
      tools.push({ name, input });
      return answers[Math.min(next++, answers.length - 1)];
    },
  };
  const io = capturedIo();
  return { tools, io, sut: new TerminalVerbs(new TerminalToolsClient(client), io) };
}

describe('TerminalVerbs on a named ferret (a person acting)', () => {
  it('should open a terminal through the person’s tools route, with the command and the hand-over', async () => {
    // Arrange
    const { sut, calls, io } = harness();

    // Act
    const code = await sut.open(
      invocation(['dev', 'bun', 'test'], { ferret: 'f-1', f: 'packages/cli', ask: 'type the code' }),
    );

    // Assert
    should(code).equal(0);
    should(calls).deepEqual([
      {
        route: 'POST /v1/ferrets/:ferretId/surfaces/terminals/tools',
        params: { ferretId: 'f-1' },
        body: {
          tool: 'terminal_open',
          name: 'dev',
          folder: 'packages/cli',
          command: 'bun test',
          askOwner: 'type the code',
        },
      },
    ]);
    should(io.printed).deepEqual(['Opened %terminal:dev.\n']);
  });

  it('should read `-s` and `--session` as the ferret, as before', async () => {
    // Arrange
    const { sut, calls } = harness();

    // Act
    await sut.list(invocation([], { s: 'f-2' }));
    await sut.list(invocation([], { session: 'f-3' }));

    // Assert
    should(calls.map(call => call.params)).deepEqual([{ ferretId: 'f-2' }, { ferretId: 'f-3' }]);
  });

  it('should send text and every key given, repeated or comma-listed', async () => {
    // Arrange
    const { sut, calls } = harness();

    // Act
    await sut.send(invocation(['dev', 'ls', '-la'], { ferret: 'f-1', k: ['enter', 'tab,escape'] }));

    // Assert
    should(calls[0]?.body).deepEqual({
      tool: 'terminal_send',
      name: 'dev',
      text: 'ls -la',
      keys: ['enter', 'tab', 'escape'],
    });
  });

  it('should refuse a mistyped line count with exit 2, sending nothing', async () => {
    // Arrange
    const { sut, calls, io } = harness();

    // Act
    const code = await sut.read(invocation(['dev'], { ferret: 'f-1', n: 'ten' }));

    // Assert
    should(code).equal(2);
    should(calls).deepEqual([]);
    should(io.errors).deepEqual(['--lines must be a whole number, not "ten"\n']);
  });

  it('should print a refused tool’s answer on stderr and exit 1', async () => {
    // Arrange
    const { sut, io } = harness(() => ({ text: 'dev is taken over by the owner', isError: true }));

    // Act
    const code = await sut.close(invocation(['dev'], { ferret: 'f-1' }));

    // Assert
    should(code).equal(1);
    should(io.errors).deepEqual(['dev is taken over by the owner\n']);
  });

  it('should take a terminal over and show who holds what', async () => {
    // Arrange
    const view = {
      sessionId: 'f-1',
      driving: [],
      takeovers: [
        { surface: 'terminal', id: 't-1', name: 'dev', by: { by: 'local' }, since: '2026-11-07T10:00:00.000Z' },
      ],
      handed: [],
      opened: [],
      asked: [],
    };
    const { sut, calls, io } = harness(() => view);

    // Act
    const code = await sut.takeover(invocation(['dev'], { ferret: 'f-1' }));

    // Assert
    should(code).equal(0);
    should(calls).deepEqual([
      {
        route: 'POST /v1/ferrets/:ferretId/surfaces/terminals/control',
        params: { ferretId: 'f-1' },
        body: { action: 'takeover', key: 'dev' },
      },
    ]);
    should(io.printed).deepEqual(['%terminal:dev  taken over by this computer since 2026-11-07T10:00:00.000Z\n']);
  });

  it('should refuse a takeover without a named ferret, since a ferret cannot take over from itself', async () => {
    // Arrange
    const { sut, calls } = harness();

    // Act
    const code = await sut.takeover(invocation(['dev']));

    // Assert
    should(code).equal(2);
    should(calls).deepEqual([]);
  });
});

describe('TerminalVerbs as the ferret itself', () => {
  it('should call its own agent tool when the shell offers tool dispatch', async () => {
    // Arrange
    const { sut, tools } = toolHarness([OPENED]);

    // Act
    const code = await sut.ask(invocation(['dev', 'sign', 'in', 'please']));

    // Assert
    should(code).equal(0);
    should(tools).deepEqual([{ name: 'terminal_ask_owner', input: { name: 'dev', message: 'sign in please' } }]);
  });

  it('should say how to act instead when this build has no tool dispatch', async () => {
    // Arrange
    const { sut, io, calls } = harness();

    // Act
    const code = await sut.list(invocation([]));

    // Assert
    should(code).equal(1);
    should(calls).deepEqual([]);
    should(io.errors[0]).match(/--ferret <id>/u);
  });

  it('should wait in slices until the text appears, exiting 0 once matched', async () => {
    // Arrange
    const { sut, tools } = toolHarness([
      { text: 'not yet', data: { summary: 'not yet', matched: false } },
      { text: 'ready', data: { summary: 'ready', matched: true } },
    ]);

    // Act
    const code = await sut.wait(invocation(['dev'], { text: 'ready', t: '40000' }));

    // Assert
    should(code).equal(0);
    should(tools.map(call => call.input)).deepEqual([
      { name: 'dev', text: 'ready', timeoutMs: 25_000 },
      { name: 'dev', text: 'ready', timeoutMs: 15_000 },
    ]);
  });

  it('should exit 1 when the wait runs out unmatched', async () => {
    // Arrange
    const { sut } = toolHarness([{ text: 'still running', data: { summary: 'still running', matched: false } }]);

    // Act
    const code = await sut.wait(invocation([], { exit: 'dev', t: '200' }));

    // Assert
    should(code).equal(1);
  });

  it('should refuse a wait for both text and exit', async () => {
    // Arrange
    const { sut, tools } = toolHarness([OPENED]);

    // Act
    const code = await sut.wait(invocation(['dev'], { text: 'ready', exit: true }));

    // Assert
    should(code).equal(2);
    should(tools).deepEqual([]);
  });
});

describe('TerminalVerbs on mistyped words', () => {
  const noName: [string, string][] = [
    ['open', 'open needs a name: a lowercase letter, then letters, digits or dashes'],
    ['send', 'send needs the terminal’s name or id'],
    ['read', 'read needs the terminal’s name or id'],
    ['wait', 'wait needs the terminal’s name or id'],
    ['close', 'close needs the terminal’s name or id'],
    ['ask', 'ask needs the terminal’s name or id'],
  ];
  for (const [verb, sentence] of noName)
    it(`should refuse ${verb} without a terminal, sending nothing`, async () => {
      const { sut, calls, io } = harness();
      const code = await (sut as unknown as Record<string, (i: ReturnType<typeof invocation>) => Promise<number>>)[
        verb
      ]!(invocation([], { ferret: 'f-1', text: 'x' }));
      should(code).equal(2);
      should(calls).deepEqual([]);
      should(io.errors).deepEqual([`${sentence}\n`]);
    });

  it('should refuse a wait timeout outside what the daemon can hold', async () => {
    const { sut, calls, io } = harness();
    should(await sut.wait(invocation(['dev'], { ferret: 'f-1', text: 'x', timeout: '50' }))).equal(2);
    should(await sut.wait(invocation(['dev'], { ferret: 'f-1', text: 'x', timeout: '999999' }))).equal(2);
    should(calls).deepEqual([]);
    should(io.errors[0]).match(/--timeout must be between 100 and 120000 milliseconds/u);
  });

  it('should open with a bare --ask as a switch, and with no folder or command', async () => {
    const { sut, calls } = harness();
    should(await sut.open(invocation(['dev'], { ferret: 'f-1', ask: true }))).equal(0);
    should(calls[0]?.body).deepEqual({ tool: 'terminal_open', name: 'dev', askOwner: true });
  });
});

describe('TerminalVerbs on who holds a terminal', () => {
  const VIEW = {
    sessionId: 'f-1',
    driving: [],
    takeovers: [],
    handed: [],
    opened: [],
    asked: [],
  };

  it('should show who drives or holds what for a named ferret', async () => {
    const { sut, calls, io } = harness(() => VIEW);
    should(await sut.control(invocation([], { ferret: 'f-1' }))).equal(0);
    should(calls[0]?.route).equal('GET /v1/ferrets/:ferretId/surfaces/terminals/control');
    should(io.printed).deepEqual(['no ferret is driving a terminal in f-1, and none is taken over\n']);
  });

  it('should refuse to show it without a named ferret', async () => {
    const { sut, calls, io } = harness(() => VIEW);
    should(await sut.control(invocation([]))).equal(2);
    should(calls).deepEqual([]);
    should(io.errors[0]).match(/pass --ferret <id>/u);
  });

  it('should hand a terminal back or over, and refuse either without a terminal', async () => {
    const { sut, calls } = harness(() => VIEW);
    should(await sut.handback(invocation(['dev'], { ferret: 'f-1' }))).equal(0);
    should(await sut.handover(invocation(['dev'], { ferret: 'f-1' }))).equal(0);
    should(calls.map(call => (call.body as { action: string }).action)).deepEqual(['handback', 'handover']);
    const none = harness(() => VIEW);
    should(await none.sut.handback(invocation([], { ferret: 'f-1' }))).equal(2);
    should(none.io.errors).deepEqual(['handback needs the terminal’s name or id\n']);
  });
});
