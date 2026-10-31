import { describe, it } from 'bun:test';
import {
  type AgendaId,
  type AgentToolCall,
  type InputAgentView,
  type InputRaise,
  type InputTargetFacts,
  padInputValue,
} from '@ferretry/protocol';
import should from 'should';
import type { AgentInputPort, AgentToolError } from '../../../src/lib/index.ts';
import { InputRequestError } from '../../../src/lib/input-requests/errors.ts';
import { FACTS, inputRequestService, RAISE } from '../input-requests/support.ts';
import { agent, agentToolWorld, person } from './support.ts';

/** An input port that records what it was asked and answers with whatever the case set. */
class FakeInput implements AgentInputPort {
  readonly raised: { sessionId: string; raise: InputRaise }[] = [];
  readonly waited: { sessionId: string; id: AgendaId; waitMs: number }[] = [];
  readonly pending = new Map<string, AgendaId>();
  view: InputAgentView = { id: 'A7', state: 'pending' };
  failure: unknown;

  async raise(sessionId: string, raise: InputRaise): Promise<InputAgentView> {
    if (this.failure !== undefined) throw this.failure;
    this.raised.push({ sessionId, raise });
    return this.view;
  }
  async agentView(sessionId: string, id: AgendaId, waitMs: number): Promise<InputAgentView> {
    if (this.failure !== undefined) throw this.failure;
    this.waited.push({ sessionId, id, waitMs });
    return this.view;
  }
  pendingOn(_sessionId: string, target: { readonly kind: string; readonly key: string }): AgendaId | undefined {
    return this.pending.get(`${target.kind}:${target.key}`);
  }
  readonly turns: string[] = [];
  async exclusive<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    this.turns.push(sessionId);
    return await work();
  }
}

const refusal = async (work: Promise<unknown>): Promise<AgentToolError> => {
  const error = await work.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  return error as AgentToolError;
};

const worldWith = async (input: FakeInput) => {
  const world = agentToolWorld({ input });
  await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });
  return world;
};

describe('AgentToolService — terminal.request_input', () => {
  it('should raise the request on the named terminal, defaulting submit to offer-owner', async () => {
    // Arrange
    const input = new FakeInput();
    const world = await worldWith(input);

    // Act
    const asked = await world.service.call(agent, {
      tool: 'terminal.request_input',
      name: 'dev',
      prompt: 'sudo password',
      sensitivity: 'secret',
    });

    // Assert
    should(asked.input).deepEqual({ id: 'A7', state: 'pending' });
    should(asked.summary).equal(
      'Asked the owner for the value (!A7) for %terminal:dev. Wait with input.wait; do not type there yourself.',
    );
    should(input.raised).deepEqual([
      {
        sessionId: 's1',
        raise: {
          target: { kind: 'terminal', key: 'dev' },
          prompt: 'sudo password',
          sensitivity: 'secret',
          submit: 'offer-owner',
        },
      },
    ]);
  });

  it('should pass every optional field through', async () => {
    // Arrange
    const input = new FakeInput();
    const world = await worldWith(input);

    // Act
    await world.service.call(agent, {
      tool: 'terminal.request_input',
      name: 'dev',
      prompt: 'otp',
      sensitivity: 'private',
      submit: 'agent',
      expiresInSeconds: 60,
      blocking: true,
      chain: 'A3',
    });

    // Assert
    should(input.raised[0]?.raise).deepEqual({
      target: { kind: 'terminal', key: 'dev' },
      prompt: 'otp',
      sensitivity: 'private',
      submit: 'agent',
      expiresInSeconds: 60,
      blocking: true,
      chain: 'A3',
    });
  });

  it('should refuse a person: they already have the terminal', async () => {
    // Arrange
    const input = new FakeInput();
    const world = await worldWith(input);

    // Act
    const refused = await refusal(
      world.service.call(person, {
        tool: 'terminal.request_input',
        name: 'dev',
        prompt: 'x',
        sensitivity: 'plain',
      }),
    );

    // Assert
    should(refused.code).equal('bad_request');
    should(input.raised).have.length(0);
  });

  it('should be unavailable where no input service is wired', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });

    // Act
    const refused = await refusal(
      world.service.call(agent, {
        tool: 'terminal.request_input',
        name: 'dev',
        prompt: 'x',
        sensitivity: 'plain',
      }),
    );

    // Assert
    should(refused).match({ code: 'unavailable', message: 'Input requests are not available on this machine.' });
  });

  it('should translate the service’s refusals into the tool’s codes, and gone into not_found', async () => {
    // Arrange
    const input = new FakeInput();
    const world = await worldWith(input);
    const ask = () =>
      world.service.call(agent, { tool: 'terminal.request_input', name: 'dev', prompt: 'x', sensitivity: 'plain' });

    // Act
    input.failure = new InputRequestError('capacity', 'too many open requests');
    const capacity = await refusal(ask());
    input.failure = new InputRequestError('gone', 'that request is gone');
    const gone = await refusal(ask());

    // Assert
    should(capacity).match({ code: 'capacity', message: 'too many open requests' });
    should(gone).match({ code: 'not_found', message: 'that request is gone' });
    should(world.audit.entries.at(-1)?.outcome).equal('refused');
  });

  it('should audit the sensitivity and never the prompt', async () => {
    // Arrange
    const world = await worldWith(new FakeInput());

    // Act
    await world.service.call(agent, {
      tool: 'terminal.request_input',
      name: 'dev',
      prompt: 'the prompt text',
      sensitivity: 'secret',
    });

    // Assert
    const detail = world.audit.entries.at(-1)?.detail;
    should(detail).match({ tool: 'terminal.request_input', surface: '%terminal:dev', sensitivity: 'secret' });
    should(JSON.stringify(world.audit.entries)).not.containEql('the prompt text');
  });
});

describe('AgentToolService — input.wait', () => {
  it('should wait for the request with the default timeout and say where it stands', async () => {
    // Arrange
    const input = new FakeInput();
    const world = agentToolWorld({ input });

    // Act
    const waited = await world.service.call(agent, { tool: 'input.wait', id: 'A7' });

    // Assert
    should(waited.input).deepEqual({ id: 'A7', state: 'pending' });
    should(waited.summary).equal(
      '!A7 is still waiting for the owner. Wait again with input.wait; do not type there yourself.',
    );
    should(input.waited).have.length(1);
    should(input.waited[0]).match({ sessionId: 's1', id: 'A7' });
    should(world.audit.entries.at(-1)?.detail).match({ tool: 'input.wait' });
    should(world.audit.entries.at(-1)?.detail).not.have.property('surface');
  });

  it('should honour the timeout and say each final state in words', async () => {
    // Arrange
    const input = new FakeInput();
    const world = agentToolWorld({ input });
    const say = async (view: InputAgentView) => {
      input.view = view;
      return (await world.service.call(agent, { tool: 'input.wait', id: 'A7', timeoutMs: 250 })).summary;
    };

    // Act
    const delivering = await say({ id: 'A7', state: 'delivering' });
    const typed = await say({ id: 'A7', state: 'delivered' });
    const submitted = await say({ id: 'A7', state: 'delivered', submitted: true });
    const refusedPlain = await say({ id: 'A7', state: 'refused' });
    const refusedWhy = await say({ id: 'A7', state: 'refused', reason: 'target_changed' });
    const expired = await say({ id: 'A7', state: 'expired' });
    const cancelledPlain = await say({ id: 'A7', state: 'cancelled' });
    const cancelledWhy = await say({ id: 'A7', state: 'cancelled', reason: 'owner_declined' });

    // Assert
    should(input.waited[0]?.waitMs).equal(250);
    should(delivering).equal("!A7: the owner's value is being typed now. Wait again with input.wait.");
    should(typed).equal('!A7: the owner typed the value. Read the terminal to see what happened.');
    should(submitted).equal(
      '!A7: the owner typed the value and pressed Enter. Read the terminal to see what happened.',
    );
    should(refusedPlain).startWith('!A7 was refused: the value was not typed.');
    should(refusedWhy).startWith('!A7 was refused (target_changed): the value was not typed.');
    should(expired).equal('!A7 expired without an answer.');
    should(cancelledPlain).equal('!A7 was cancelled.');
    should(cancelledWhy).equal('!A7 was cancelled (owner_declined).');
  });

  it('should refuse a person, and be unavailable where no input service is wired', async () => {
    // Arrange
    const wired = agentToolWorld({ input: new FakeInput() });
    const bare = agentToolWorld();

    // Act
    const byPerson = await refusal(wired.service.call(person, { tool: 'input.wait', id: 'A7' }));
    const unwired = await refusal(bare.service.call(agent, { tool: 'input.wait', id: 'A7' }));

    // Assert
    should(byPerson.code).equal('bad_request');
    should(unwired.code).equal('unavailable');
  });

  it('should not be stopped by the terminal or browser control switches', async () => {
    // Arrange
    const world = agentToolWorld({ input: new FakeInput() });
    world.policy.off.add('terminal');
    world.policy.off.add('browser');

    // Act
    const waited = await world.service.call(agent, { tool: 'input.wait', id: 'A7' });

    // Assert
    should(waited.input?.state).equal('pending');
  });
});

describe('AgentToolService — while a request is pending', () => {
  it('should refuse terminal.send on the target, naming the card, and allow it elsewhere', async () => {
    // Arrange
    const input = new FakeInput();
    const world = await worldWith(input);
    await world.service.call(agent, { tool: 'terminal.open', name: 'other' });
    input.pending.set('terminal:dev', 'A7');

    // Act
    const blocked = await refusal(world.service.call(agent, { tool: 'terminal.send', name: 'dev', text: 'ls' }));
    const elsewhere = await world.service.call(agent, { tool: 'terminal.send', name: 'other', text: 'ls' });
    input.pending.clear();
    const after = await world.service.call(agent, { tool: 'terminal.send', name: 'dev', text: 'ls' });

    // Assert
    should(blocked).match({
      code: 'conflict',
      message: 'an input request is pending on %terminal:dev; wait for !A7 (input.wait) and do not type there yourself',
    });
    should(world.terminals.typed.get('000000000001')).equal('ls');
    should(elsewhere.summary).startWith('Sent 2 characters');
    should(after.summary).startWith('Sent 2 characters');
  });
});

describe('AgentToolService — scrubbing what an agent reads', () => {
  const mask = (_sessionId: string, text: string): string => text.replaceAll('hunter2', '••••');

  it('should mask the typed value from terminal.read, terminal.wait and browser.read', async () => {
    // Arrange
    const world = agentToolWorld({ scrub: mask });
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    world.terminals.screens.set('000000000001', 'password: hunter2\n');

    // Act
    const read = await world.service.call(agent, { tool: 'terminal.read', name: 'dev' });
    const waited = await world.service.call(agent, { tool: 'terminal.wait', name: 'dev', text: 'password' });
    const page = await world.service.call(agent, { tool: 'browser.read', name: 'app' });

    // Assert
    should(read.output).equal('password: ••••\n');
    should(waited.output).equal('password: ••••\n');
    should(page.output).equal('Welcome back');
  });

  it('should hand text through unchanged where no mask is wired', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });
    world.terminals.screens.set('000000000001', 'password: hunter2\n');

    // Act
    const read = await world.service.call(agent, { tool: 'terminal.read', name: 'dev' });

    // Assert
    should(read.output).equal('password: hunter2\n');
  });

  it('should mask browser text with the mask the page read comes through', async () => {
    // Arrange
    const world = agentToolWorld({ scrub: (_s, text) => text.replaceAll('Welcome', '•••') });
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });

    // Act
    const page = await world.service.call(agent, { tool: 'browser.read', name: 'app' });

    // Assert
    should(page.output).equal('••• back');
  });
});

describe('AgentToolService — what terminal.wait can learn about a typed value', () => {
  const mask = (_sessionId: string, text: string): string => text.replaceAll('hunter2', '••••');

  it('should never match a guess against the hidden value: the predicate sees scrubbed text', async () => {
    // Arrange
    const world = agentToolWorld({ scrub: mask });
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });
    world.terminals.screens.set('000000000001', 'password: hunter2\n');

    // Act
    const guess = await world.service.call(agent, {
      tool: 'terminal.wait',
      name: 'dev',
      text: 'hunter2',
      timeoutMs: 100,
    });
    const prefix = await world.service.call(agent, {
      tool: 'terminal.wait',
      name: 'dev',
      text: 'hunt',
      timeoutMs: 100,
    });
    const visible = await world.service.call(agent, {
      tool: 'terminal.wait',
      name: 'dev',
      text: '••••',
      timeoutMs: 100,
    });

    // Assert
    should(guess.matched).be.false();
    should(prefix.matched).be.false();
    should(visible.matched).be.true();
    should(JSON.stringify([guess, prefix, visible])).not.containEql('hunter2');
  });
});

describe('AgentToolService — keystrokes and closing are turns in the session', () => {
  it('should run terminal.send and terminal.close through the session’s exclusive turn', async () => {
    // Arrange
    const input = new FakeInput();
    const world = await worldWith(input);

    // Act
    await world.service.call(agent, { tool: 'terminal.send', name: 'dev', text: 'ls' });
    await world.service.call(agent, { tool: 'terminal.close', name: 'dev' });

    // Assert
    should(input.turns).eql(['s1', 's1']);
  });

  it('should not let a send land while a turn holds the session, and refuse it at once when a request is pending', async () => {
    // Arrange
    const input = new FakeInput();
    const world = await worldWith(input);
    input.pending.set('terminal:dev', 'A7');

    // Act
    const blocked = await refusal(world.service.call(agent, { tool: 'terminal.send', name: 'dev', text: 'x' }));

    // Assert
    should(blocked.code).equal('conflict');
    should(world.terminals.typed.size).equal(0);
  });
});

describe('AgentToolService — a terminal the owner just typed a secret into', () => {
  const until = Date.parse('2026-10-16T10:02:00.000Z');
  const held = (_sessionId: string, names: readonly (string | undefined)[]): number | undefined =>
    names.includes('dev') || names.includes('000000000001') ? until : undefined;

  it('should refuse terminal.read and terminal.wait to an agent, by name or by id, and say when it ends', async () => {
    // Arrange
    const world = agentToolWorld({ quarantinedUntil: held });
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });
    world.terminals.screens.set('000000000001', 'password: hunter2\n');

    // Act
    const byName = await refusal(world.service.call(agent, { tool: 'terminal.read', name: 'dev' }));
    const byId = await refusal(world.service.call(agent, { tool: 'terminal.read', name: '000000000001' }));
    const waited = await refusal(world.service.call(agent, { tool: 'terminal.wait', name: 'dev', text: 'password' }));

    // Assert
    for (const error of [byName, byId, waited]) {
      should(error.code).equal('conflict');
      should(error.message).containEql('2026-10-16T10:02:00.000Z');
      should(error.message).not.containEql('hunter2');
    }
  });

  it('should stop a wait that is already running when the quarantine begins mid-wait', async () => {
    // Arrange
    let closed = true;
    const world = agentToolWorld({ quarantinedUntil: () => (closed ? undefined : until) });
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });
    world.onSleep.push(() => {
      closed = false;
    });

    // Act
    const error = await refusal(world.service.call(agent, { tool: 'terminal.wait', name: 'dev', text: 'never' }));

    // Assert
    should(error.code).equal('conflict');
  });

  it('should still let the agent send keys while the terminal is held', async () => {
    // Arrange
    const world = agentToolWorld({ quarantinedUntil: held });
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });

    // Act
    const sent = await world.service.call(agent, { tool: 'terminal.send', name: 'dev', keys: ['ctrl-c'] });

    // Assert
    should(sent.summary).startWith('Sent 1 key');
  });

  it('should refuse the owner’s ordinary terminal tools too, and point at the viewer’s own way to look', async () => {
    // Arrange
    const world = agentToolWorld({ quarantinedUntil: held });
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });
    world.terminals.screens.set('000000000001', 'password: hunter2\n');

    // Act
    const read = await refusal(world.service.call(person, { tool: 'terminal.read', name: 'dev' }));
    const waited = await refusal(world.service.call(person, { tool: 'terminal.wait', name: 'dev', text: 'password' }));

    // Assert
    for (const error of [read, waited]) {
      should(error.code).equal('conflict');
      should(error.message).containEql('Show anyway');
      should(error.message).not.containEql('hunter2');
    }
  });

  describe('when the quarantine begins while a read is already in flight', () => {
    const racing = async () => {
      let quarantined = false;
      const world = agentToolWorld({ quarantinedUntil: () => (quarantined ? until : undefined) });
      await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });
      const calls: number[] = [];
      const text = world.terminals.text.bind(world.terminals);
      world.terminals.text = async (...args: Parameters<typeof text>) => {
        calls.push(calls.length);
        const captured = await text(...args);
        if (flipOn.has(calls.length)) quarantined = true;
        return `${captured}password: hunt`;
      };
      return world;
    };
    const flipOn = new Set<number>();

    it('should not return a screen read before the secret was typed (terminal.read)', async () => {
      flipOn.clear();
      flipOn.add(1);
      const world = await racing();

      const error = await refusal(world.service.call(agent, { tool: 'terminal.read', name: 'dev' }));

      should(error.code).equal('conflict');
      should(error.message).not.containEql('hunt');
    });

    it('should not match against, or report on, a screen read before the secret was typed (terminal.wait predicate)', async () => {
      flipOn.clear();
      flipOn.add(1);
      const world = await racing();

      const error = await refusal(world.service.call(agent, { tool: 'terminal.wait', name: 'dev', text: 'hunt' }));

      should(error.code).equal('conflict');
    });

    it('should not return the tail of a matched wait when the quarantine began during it (terminal.wait tail)', async () => {
      flipOn.clear();
      flipOn.add(2);
      const world = await racing();

      const error = await refusal(world.service.call(agent, { tool: 'terminal.wait', name: 'dev', text: 'hunt' }));

      should(error.code).equal('conflict');
    });

    it('should not return the tail of a wait that timed out when the quarantine began during it', async () => {
      flipOn.clear();
      flipOn.add(2);
      const world = await racing();

      const error = await refusal(
        world.service.call(agent, { tool: 'terminal.wait', name: 'dev', text: 'never', timeoutMs: 1 }),
      );

      should(error.code).equal('conflict');
    });
  });

  it('should not hand back a screen when the quarantine began while its audit record was being written', async () => {
    // Arrange
    let quarantined = false;
    const world = agentToolWorld({ quarantinedUntil: () => (quarantined ? until : undefined) });
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });
    world.terminals.screens.set('000000000001', 'password: hunter2\n');
    world.audit.during = async () => {
      await Promise.resolve();
      quarantined = true;
    };

    // Act
    const error = await refusal(world.service.call(agent, { tool: 'terminal.read', name: 'dev' }));

    // Assert
    should(error.code).equal('conflict');
    should(error.message).not.containEql('hunter2');
  });

  it('should read normally once the quarantine is gone', async () => {
    // Arrange
    const world = agentToolWorld({ quarantinedUntil: () => undefined });
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });

    // Act
    const read = await world.service.call(agent, { tool: 'terminal.read', name: 'dev' });

    // Assert
    should(read.summary).startWith('The last');
  });
});

describe('AgentToolService — a nested input view is sealed where it is published', () => {
  const CANARY = 'pane-consumer-CANARY';
  const OWNER = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' } as const;
  const facts: InputTargetFacts = {
    ...FACTS,
    foreground: { ...FACTS.foreground, comm: CANARY },
    promptLine: 'pane-prompt-CANARY',
  };

  /** The real input service behind the tools, on a terminal whose foreground command is a canary. */
  const realWorld = async () => {
    const built = inputRequestService({ facts, session: 's1', names: ['dev', '000000000001'] });
    const world = agentToolWorld({
      input: built.service,
      quarantinedUntil: (session, names) => built.service.quarantinedUntil(session, names),
    });
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });
    return { ...built, world };
  };

  /** Suspends the call's audit record, lets the owner type a secret, then resumes it. */
  const deliveredDuring = async (built: Awaited<ReturnType<typeof realWorld>>, call: AgentToolCall) => {
    let entered!: () => void;
    let resume!: () => void;
    const reached = new Promise<void>(resolve => (entered = resolve));
    const gate = new Promise<void>(resolve => (resume = resolve));
    built.world.audit.during = async () => {
      entered();
      await gate;
    };
    const pending = built.world.service.call(agent, call);
    await reached;
    const [open] = await built.service.list(OWNER, 's1');
    await built.service.deliver(
      's1',
      open?.id ?? '',
      {
        deliveryId: crypto.randomUUID(),
        observedDigest: open?.observedDigest ?? '',
        padded: padInputValue('x'),
        submit: true,
      },
      OWNER,
    );
    should(built.service.quarantinedUntil('s1', ['dev'])).not.be.undefined();
    resume();
    return await pending;
  };

  it('should not hand back the foreground command when the owner typed a secret while terminal.request_input was audited', async () => {
    const built = await realWorld();

    const result = await deliveredDuring(built, {
      tool: 'terminal.request_input',
      name: 'dev',
      prompt: 'password',
      sensitivity: 'secret',
    });

    should(JSON.stringify(result)).not.containEql(CANARY);
  });

  it('should not hand back the foreground command when the owner typed a secret while input.wait was audited', async () => {
    const built = await realWorld();
    const raised = await built.service.raise('s1', { ...RAISE, target: { kind: 'terminal', key: 'dev' } });

    const result = await deliveredDuring(built, { tool: 'input.wait', id: raised.id, timeoutMs: 0 });

    should(JSON.stringify(result)).not.containEql(CANARY);
  });

  it('should show the foreground command while nothing is quarantined, and name no pane it cannot bind', async () => {
    const built = await realWorld();
    const raised = await built.service.raise('s1', { ...RAISE, target: { kind: 'terminal', key: 'dev' } });

    const waited = await built.world.service.call(agent, { tool: 'input.wait', id: raised.id, timeoutMs: 0 });
    const stray = await built.world.service
      .call(agent, { tool: 'input.wait', id: 'A99' as AgendaId, timeoutMs: 0 })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );

    should(waited.input?.observed?.consumer).equal(CANARY);
    should(stray).not.be.undefined();
  });

  it('should publish a result again at the transport, and pass through one that read no pane', async () => {
    const built = await realWorld();
    const raised = await built.service.raise('s1', { ...RAISE, target: { kind: 'terminal', key: 'dev' } });
    const waited = await built.world.service.call(agent, { tool: 'input.wait', id: raised.id, timeoutMs: 0 });
    const listed = await built.world.service.call(agent, { tool: 'terminal.list' });

    built.quarantine.begin('s1', ['dev', '000000000001'], 'late');

    should(JSON.stringify(built.world.service.publish(waited))).not.containEql(CANARY);
    should(built.world.service.publish(listed)).equal(listed);
  });

  it('should drop the view of a pending request it cannot bind to a terminal', async () => {
    const input = new FakeInput();
    input.view = { id: 'A7', state: 'pending', observed: { consumer: CANARY, echo: 'off', recognised: true } };
    const world = await worldWith(input);

    const result = await world.service.call(agent, { tool: 'input.wait', id: 'A7' });

    should(JSON.stringify(result)).not.containEql(CANARY);
    should(result.input?.state).equal('pending');
  });

  it('should bind a pending request to the terminal known by its id as well as by its name', async () => {
    const input = new FakeInput();
    input.view = { id: 'A7', state: 'pending', observed: { consumer: CANARY, echo: 'off', recognised: true } };
    input.pending.set('terminal:000000000001', 'A7');
    const world = await worldWith(input);

    const result = await world.service.call(agent, { tool: 'input.wait', id: 'A7' });

    should(result.input?.observed?.consumer).equal(CANARY);
  });
});

describe('AgentToolService — browser.request_input', () => {
  const login: AgentToolCall = {
    tool: 'browser.request_input',
    name: 'app',
    prompt: 'Google login for the console',
    fields: [
      { id: 'email', label: 'Email', sensitivity: 'plain', selector: '#identifierId' },
      { id: 'password', sensitivity: 'secret', ref: 'e12' },
    ],
  };

  it('should raise one card for the page, each field naming its element, defaulting submit to offer-owner', async () => {
    // Arrange
    const input = new FakeInput();
    const world = agentToolWorld({ input });
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });

    // Act
    const asked = await world.service.call(agent, login);

    // Assert
    should(asked.summary).equal(
      'Asked the owner for 2 values (!A7) for %browser:app. Wait with input.wait; do not type into those fields yourself.',
    );
    should(input.raised).deepEqual([
      {
        sessionId: 's1',
        raise: {
          target: { kind: 'browser', key: 'app' },
          prompt: 'Google login for the console',
          fields: [
            {
              id: 'email',
              label: 'Email',
              sensitivity: 'plain',
              element: { kind: 'selector', selector: '#identifierId' },
            },
            { id: 'password', sensitivity: 'secret', element: { kind: 'ref', ref: 'e12' } },
          ],
          submit: 'offer-owner',
        },
      },
    ]);
  });

  it('should refuse a person: they already have the page', async () => {
    // Arrange
    const input = new FakeInput();
    const world = agentToolWorld({ input });
    await world.service.call(person, { tool: 'browser.open', name: 'app' });

    // Act
    const error = await refusal(world.service.call(person, login));

    // Assert
    should(error.code).equal('bad_request');
    should(input.raised).deepEqual([]);
  });

  it('should label a terminal value when the agent names one', async () => {
    // Arrange
    const input = new FakeInput();
    const world = await worldWith(input);

    // Act
    await world.service.call(agent, {
      tool: 'terminal.request_input',
      name: 'dev',
      prompt: 'the key passphrase',
      sensitivity: 'secret',
      label: 'Passphrase',
    });

    // Assert
    should(input.raised[0]?.raise.fields).deepEqual([{ id: 'value', label: 'Passphrase', sensitivity: 'secret' }]);
    should(input.raised[0]?.raise.sensitivity).be.undefined();
  });
});
