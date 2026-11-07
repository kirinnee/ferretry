import { describe, it } from 'bun:test';
import type { AgentToolCall, InputRaise } from '@ferretry/protocol';
import should from 'should';
import {
  type AgentInputPort,
  type AgentToolError,
  EphemeralValues,
  PageCopyRecords,
  type SecretChildOutcome,
  SecureCopyService,
} from '../../../src/lib/index.ts';
import { agent, agentToolWorld, ManualClock, person } from './support.ts';

const TOKEN = 'vcp_AGENT-NEVER-SEES-9c1d';

function copyWorld(options: { readonly transcript?: 'found' | 'clean' | 'unknown' } = {}) {
  const clock = new ManualClock();
  const masking = new EphemeralValues(clock);
  const ran: (readonly string[])[] = [];
  const answer: { outcome: SecretChildOutcome } = {
    outcome: { outcome: 'exited', exitCode: 0, stdout: `${TOKEN}\n`, stderr: '', truncated: false },
  };
  const copies = new SecureCopyService({
    clock,
    runner: {
      run: async spec => {
        ran.push(spec.command);
        return answer.outcome;
      },
    },
    folders: { folderOf: async () => '/work' },
    exposure: { transcriptHolds: async () => options.transcript ?? 'clean' },
    masking,
    redact: async text => text,
  });
  const tools = agentToolWorld({ copy: copies, scrub: (sessionId, text) => masking.scrub(sessionId, text) });
  return { ...tools, copies, masking, ran, answer };
}

const COPY: AgentToolCall = {
  tool: 'secure.copy',
  name: 'vercel',
  source: { kind: 'command', argv: ['vercel', 'tokens', 'create', '--secret-arg'] },
};

const refused = async (work: Promise<unknown>): Promise<AgentToolError> =>
  (await work.then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: unknown) => error,
  )) as AgentToolError;

describe('the secure.* agent tools', () => {
  it('should seal what a command prints and tell the agent only the handle, its length and its expiry', async () => {
    const world = copyWorld();

    const result = await world.service.call(agent, COPY);

    should(result.summary).equal(
      `Sealed ${String(TOKEN.length)} characters from vercel as sealed:vercel, until 2026-10-16T11:00:00.000Z. You cannot read it; paste it by handle.`,
    );
    should(result.copies?.map(copy => copy.handle)).eql(['sealed:vercel']);
    should(result.command).eql({ outcome: 'exited', exitCode: 0 });
    should(world.ran).eql([['vercel', 'tokens', 'create', '--secret-arg']]);
  });

  it("should mask the copy from the agent's next terminal read", async () => {
    const world = copyWorld();
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });
    world.terminals.screens.set('000000000001', `$ echo ${TOKEN}\n${TOKEN}\n`);
    await world.service.call(agent, COPY);

    const read = await world.service.call(agent, { tool: 'terminal.read', name: 'dev' });

    should(read.output).containEql('[sealed:vercel]');
    should(read.output).not.containEql(TOKEN);
  });

  it('should warn the agent when the value was already in its transcript', async () => {
    const world = copyWorld({ transcript: 'found' });

    const result = await world.service.call(agent, COPY);

    should(result.summary).containEql('already in your transcript before it was sealed, so it is NOT protected');
  });

  it('should list and discard copies', async () => {
    const world = copyWorld();
    await world.service.call(agent, COPY);

    const listed = await world.service.call(agent, { tool: 'secure.list' });
    const discarded = await world.service.call(agent, { tool: 'secure.discard', handle: 'vercel' });
    const after = await world.service.call(agent, { tool: 'secure.list' });

    should(listed.summary).equal('This session holds 1 live copy.');
    should(discarded.summary).equal('sealed:vercel is discarded: its value is gone from the daemon.');
    should(after.copies?.map(copy => copy.state)).eql(['discarded']);
    should(world.copies.heldCount()).equal(0);
    should((await world.service.call(agent, { tool: 'secure.list' })).summary).equal(
      'This session holds 0 live copies.',
    );
  });

  it("should keep one session's copies from another", async () => {
    const world = copyWorld();
    await world.service.call(agent, COPY);

    const other = await world.service.call({ kind: 'agent', sessionId: 's2' }, { tool: 'secure.list' });
    const error = await refused(
      world.service.call({ kind: 'agent', sessionId: 's2' }, { tool: 'secure.discard', handle: 'vercel' }),
    );

    should(other.summary).equal('This session holds no copies.');
    should(error.code).equal('not_found');
    should(world.copies.heldCount('s1')).equal(1);
  });

  it('should need the terminal switch to copy from a command, and refuse with nothing run when it is off', async () => {
    const world = copyWorld();
    world.policy.off.add('terminal');

    const error = await refused(world.service.call(agent, COPY));

    should(error.code).equal('forbidden');
    should(world.ran).eql([]);
    should((await world.service.call(agent, { tool: 'secure.list' })).copies).eql([]);
  });

  it('should hand the agent a refusal in words it can act on', async () => {
    const world = copyWorld();
    world.answer.outcome = {
      outcome: 'exited',
      exitCode: 1,
      stdout: TOKEN,
      stderr: `bad token ${TOKEN}`,
      truncated: false,
    };

    const error = await refused(world.service.call(agent, COPY));

    should(error.code).equal('upstream_failed');
    should(error.message).equal(
      'The command exited with 1; nothing was copied. It said on stderr: bad token [sealed:vercel]',
    );
  });

  it('should audit the copy by handle, source and argument count, never the arguments or the value', async () => {
    const world = copyWorld();
    await world.service.call(agent, COPY);
    await world.service.call(agent, { tool: 'secure.discard', handle: 'sealed:vercel' });

    const records = world.audit.entries.filter(entry => String(entry.detail?.tool).startsWith('secure.'));
    should(records.map(entry => entry.detail)).eql([
      {
        tool: 'secure.copy',
        by: 'agent',
        copy: 'sealed:vercel',
        source: 'command',
        args: 3,
        copyLength: TOKEN.length,
        transcript: 'clean',
        program: 'vercel',
      },
      { tool: 'secure.discard', by: 'agent', copy: 'sealed:vercel' },
    ]);
    should(JSON.stringify(world.audit.entries)).not.containEql('--secret-arg');
  });

  it('should never put the value in a result, an audit record or a journal event', async () => {
    const world = copyWorld();
    world.answer.outcome = {
      outcome: 'exited',
      exitCode: 0,
      stdout: TOKEN,
      stderr: `minted ${TOKEN}`,
      truncated: false,
    };

    const results = [
      await world.service.call(agent, COPY),
      await world.service.call(agent, { tool: 'secure.list' }),
      await world.service.call(person, { tool: 'secure.list' }),
      await world.service.call(agent, { tool: 'secure.discard', handle: 'vercel' }),
    ];

    should(JSON.stringify(results)).not.containEql(TOKEN);
    should(JSON.stringify(world.audit.entries)).not.containEql(TOKEN);
    should(JSON.stringify(world.events.published)).not.containEql(TOKEN);
  });

  it('should refuse the tools on a daemon with no secure copy wired', async () => {
    const world = agentToolWorld();

    const error = await refused(world.service.call(agent, { tool: 'secure.list' }));

    should(error.code).equal('unavailable');
  });
});

/** An input port that records each raise and answers what the case set. */
function recordingInput(state: 'pending' | 'delivered' = 'pending', lockSeconds?: number) {
  const raised: { sessionId: string; raise: InputRaise }[] = [];
  const input: AgentInputPort = {
    raise: async (sessionId, raise) => {
      raised.push({ sessionId, raise });
      return {
        id: 'A7',
        state,
        ...(state === 'delivered' ? { source: 'sealed' as const, submitted: true } : {}),
        ...(lockSeconds === undefined ? {} : { lockSeconds }),
      };
    },
    agentView: async () => ({ id: 'A7', state }),
    pendingOn: () => undefined,
    exclusive: async (_sessionId, work) => await work(),
  };
  return { input, raised };
}

const PASTE: AgentToolCall = {
  tool: 'secure.paste',
  handle: 'sealed:vercel',
  to: { kind: 'terminal', name: 'dev' },
  prompt: 'the deploy token',
};

describe('the secure.paste and secure.preapprove agent tools', () => {
  it("should raise a paste on the agent's own terminal as a secret whose value is the copy", async () => {
    const { input, raised } = recordingInput();
    const world = agentToolWorld({ input });
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });

    const result = await world.service.call(agent, PASTE);

    should(raised).eql([
      {
        sessionId: 's1',
        raise: {
          target: { kind: 'terminal', key: 'dev' },
          prompt: 'the deploy token',
          sensitivity: 'secret',
          submit: 'offer-owner',
          source: { kind: 'sealed', name: 'vercel' },
        },
      },
    ]);
    should(result.summary).equal(
      'Asked the owner to allow pasting sealed:vercel into %terminal:dev (!A7). Wait with input.wait; do not type there yourself.',
    );
  });

  it('should say a paste a rule allowed went through at once', async () => {
    const { input } = recordingInput('delivered');
    const world = agentToolWorld({ input });
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });

    const result = await world.service.call(agent, PASTE);

    should(result.summary).startWith(
      'Pasted sealed:vercel into %terminal:dev under a rule the owner approved in advance',
    );
    should(result.summary).endWith('The terminal is unreadable for about two minutes.');
  });

  it('should say how long the terminal is unreadable when the daemon chose a short lock', async () => {
    const { input } = recordingInput('delivered', 10);
    const world = agentToolWorld({ input });
    await world.service.call(agent, { tool: 'terminal.open', name: 'dev' });

    const result = await world.service.call(agent, PASTE);

    should(result.summary).endWith('The terminal is unreadable for 10 seconds.');
  });

  it('should raise a paste saved as a secret with no terminal of its own, and say how to use it once saved', async () => {
    const asking = recordingInput();
    const saving = recordingInput('delivered');
    const INTO_STORE = { ...PASTE, to: { kind: 'secret', name: 'VERCEL_TOKEN' } } as AgentToolCall;

    const pending = await agentToolWorld({ input: asking.input }).service.call(agent, INTO_STORE);
    const saved = await agentToolWorld({ input: saving.input }).service.call(agent, INTO_STORE);

    should(asking.raised).eql([
      {
        sessionId: 's1',
        raise: {
          target: { kind: 'secret', key: 'VERCEL_TOKEN' },
          prompt: 'the deploy token',
          sensitivity: 'secret',
          submit: 'agent',
          source: { kind: 'sealed', name: 'vercel' },
        },
      },
    ]);
    should(pending.summary).equal(
      'Asked the owner to allow saving sealed:vercel as the secret VERCEL_TOKEN (!A7). Wait with input.wait.',
    );
    should(saved.summary).equal(
      'Saved sealed:vercel as the secret VERCEL_TOKEN under a rule the owner approved in advance (!A7). Use it as ${secret:VERCEL_TOKEN}.',
    );
  });

  it("should raise a paste into one field of the agent's own page as a secret whose value is the copy", async () => {
    const asking = recordingInput();
    const pasted = recordingInput('delivered');
    const INTO_PAGE = { ...PASTE, to: { kind: 'browser', name: 'app', ref: 'e3' } } as AgentToolCall;
    const first = agentToolWorld({ input: asking.input });
    await first.service.call(agent, { tool: 'browser.open', name: 'app' });
    const second = agentToolWorld({ input: pasted.input });
    await second.service.call(agent, { tool: 'browser.open', name: 'app' });

    const pending = await first.service.call(agent, INTO_PAGE);
    const delivered = await second.service.call(agent, {
      ...INTO_PAGE,
      to: { kind: 'browser', name: 'app', selector: '#token' },
    } as AgentToolCall);

    should(asking.raised).eql([
      {
        sessionId: 's1',
        raise: {
          target: { kind: 'browser', key: 'app' },
          prompt: 'the deploy token',
          fields: [{ id: 'value', sensitivity: 'secret', element: { kind: 'ref', ref: 'e3' } }],
          submit: 'offer-owner',
          source: { kind: 'sealed', name: 'vercel' },
        },
      },
    ]);
    should(pasted.raised[0]?.raise.fields).eql([
      { id: 'value', sensitivity: 'secret', element: { kind: 'selector', selector: '#token' } },
    ]);
    should(pending.summary).equal(
      'Asked the owner to allow pasting sealed:vercel into a field on %browser:app (!A7). Wait with input.wait; do not type there yourself.',
    );
    should(delivered.summary).startWith('Pasted sealed:vercel into a field on %browser:app under a rule');
  });

  it("should refuse a paste into a person's page and with the browser switch off, but not for the terminal switch", async () => {
    const { input, raised } = recordingInput();
    const world = agentToolWorld({ input });
    await world.service.call(person, { tool: 'browser.open', name: 'theirs' });
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    const into = (name: string) => ({ ...PASTE, to: { kind: 'browser', name, ref: 'e3' } }) as AgentToolCall;

    const theirs = await refused(world.service.call(agent, into('theirs')));
    world.policy.off.add('terminal');
    await world.service.call(agent, into('app'));
    world.policy.off.add('browser');
    const switchedOff = await refused(world.service.call(agent, into('app')));

    should([theirs.code, switchedOff.code]).eql(['forbidden', 'forbidden']);
    should(raised).have.length(1);
  });

  it('should refuse a paste into a terminal a person opened, a person pasting, and the terminal switch off', async () => {
    const { input, raised } = recordingInput();
    const world = agentToolWorld({ input });
    await world.service.call(person, { tool: 'terminal.open', name: 'dev' });

    const theirs = await refused(world.service.call(agent, PASTE));
    const byPerson = await refused(world.service.call(person, PASTE));
    world.policy.off.add('terminal');
    const switchedOff = await refused(world.service.call(agent, PASTE));

    should([theirs.code, byPerson.code, switchedOff.code]).eql(['forbidden', 'bad_request', 'forbidden']);
    should(raised).eql([]);
  });
});

describe('the secure tools and the switches', () => {
  it('should need the browser switch to copy from a page or its clipboard', async () => {
    const world = copyWorld();
    world.policy.off.add('browser');

    const error = await refused(
      world.service.call(agent, { tool: 'secure.copy', name: 'gh', source: { kind: 'clipboard', key: 'app' } }),
    );

    should(error.code).equal('forbidden');
  });

  it('should tell the agent a delivered paste was pasted when it waits on it', async () => {
    const input: AgentInputPort = {
      raise: async () => ({ id: 'A7', state: 'pending' }),
      agentView: async () => ({ id: 'A7', state: 'delivered', source: 'sealed', submitted: true }),
      pendingOn: () => undefined,
      exclusive: async (_sessionId, work) => await work(),
    };
    const world = agentToolWorld({ input });

    const result = await world.service.call(agent, { tool: 'input.wait', id: 'A7' });

    should(result.summary).equal(
      '!A7: the secure copy was pasted and Enter pressed. Read the terminal once its quarantine allows.',
    );
  });
});

describe('a person and secure.copy', () => {
  it('should refuse a person sealing a value, running nothing', async () => {
    const world = copyWorld();

    const error = await refused(world.service.call(person, COPY));

    should(error.code).equal('bad_request');
    should(world.ran).eql([]);
  });
});

describe('copying from a page the agent opened', () => {
  /** The copy service and the page records over a fake page whose document the case moves on. */
  function pageWorld(options: { readonly heldByOwner?: boolean } = {}) {
    const clock = new ManualClock();
    const masking = new EphemeralValues(clock);
    const records = new PageCopyRecords(clock);
    const page = { document: 'loader-1', asked: [] as string[] };
    const copies = new SecureCopyService({
      clock,
      runner: {
        run: async () => {
          throw new Error('a page copy runs no command');
        },
      },
      folders: { folderOf: async () => '/work' },
      exposure: { transcriptHolds: async () => 'clean' },
      masking,
      redact: async text => text,
      pages: {
        // As the page's queue runs it: the guard, the read, the seal.
        read: async (_sessionId, key, _target, _part, _attribute, queue) => {
          await queue.guard?.({ document: async () => page.document });
          page.asked.push(key);
          const found = {
            ok: true as const,
            value: TOKEN,
            pageId: 'page-1',
            origin: 'https://github.com',
            frameOrigin: 'https://github.com',
            navigationId: page.document,
          };
          queue.seal(found);
          return found;
        },
      },
      pageHolds: records,
    });
    const input: AgentInputPort = {
      raise: async () => {
        throw new Error('no request here');
      },
      agentView: async () => ({ id: 'A1', state: 'pending' }),
      pendingOn: () => undefined,
      exclusive: async (_sessionId, work) => await work(),
      pageDocument: async () => page.document,
      // The owner's value was just typed into the page: its text is not read while it shows that document.
      ...(options.heldByOwner === true
        ? { pageHeld: () => ({ until: Date.parse('2026-10-31T12:02:00.000Z'), documents: ['loader-1'] }) }
        : {}),
    };
    const tools = agentToolWorld({
      copy: copies,
      copyPages: records,
      input,
      scrub: (sessionId, text) => masking.scrub(sessionId, text),
    });
    return { ...tools, copies, records, page };
  }
  const FROM_PAGE: AgentToolCall = {
    tool: 'secure.copy',
    name: 'gh',
    source: { kind: 'browser', key: 'app', ref: 'e12', read: 'text' },
  };
  const SHOT: AgentToolCall = { tool: 'browser.screenshot', name: 'app' };

  it('should seal an element of its own page, by the name the page is known by, and say where it came from', async () => {
    const w = pageWorld();
    await w.service.call(agent, { tool: 'browser.open', name: 'app' });

    const result = await w.service.call(agent, FROM_PAGE);

    should(w.page.asked).eql(['app']);
    should(result.copies?.[0]).match({ from: { kind: 'browser', origin: 'https://github.com', surface: 'app' } });
    should(JSON.stringify(result)).not.containEql(TOKEN);
  });

  it("should refuse a copy from a person's page, and with the browser switch off, reading nothing", async () => {
    const w = pageWorld();
    await w.service.call(person, { tool: 'browser.open', name: 'theirs' });
    await w.service.call(agent, { tool: 'browser.open', name: 'app' });

    const theirs = await refused(
      w.service.call(agent, { ...FROM_PAGE, source: { kind: 'browser', key: 'theirs', ref: 'e1', read: 'text' } }),
    );
    w.policy.off.add('browser');
    const switchedOff = await refused(w.service.call(agent, FROM_PAGE));

    should([theirs.code, switchedOff.code]).eql(['forbidden', 'forbidden']);
    should(w.page.asked).eql([]);
  });

  it('should not picture the page while it shows the copied document, read its text, and picture it once it moved on', async () => {
    const w = pageWorld();
    await w.service.call(agent, { tool: 'browser.open', name: 'app' });
    await w.service.call(agent, FROM_PAGE);

    const held = await refused(w.service.call(agent, SHOT));
    const text = await w.service.call(agent, { tool: 'browser.read', name: 'app' });
    // The page navigated: the browser and the input bridge both see the new document.
    w.page.document = 'loader-2';
    w.browser.document = 'loader-2';
    const moved = await w.service.call(agent, SHOT);

    should(held.code).equal('conflict');
    should(held.message).containEql('still shows the page a secure copy was read from');
    should(text.summary).not.be.empty();
    should(moved.screenshotBase64).not.be.undefined();
  });

  it('should not picture it for a person either, pointing them at the browser view', async () => {
    const w = pageWorld();
    await w.service.call(agent, { tool: 'browser.open', name: 'app' });
    await w.service.call(agent, FROM_PAGE);

    const held = await refused(w.service.call(person, SHOT));

    should(held.code).equal('conflict');
    should(held.message).containEql('Look at it in the browser view.');
  });

  it('should mask the copied value anywhere in a page result as it leaves, the page address included', async () => {
    const w = pageWorld();
    await w.service.call(agent, { tool: 'browser.open', name: 'app' });
    await w.service.call(agent, FROM_PAGE);
    w.browser.readText = `Your new token: ${TOKEN}`;
    w.browser.actedUrl = `https://github.com/settings/tokens?created=${TOKEN}`;

    const read = await w.service.call(agent, { tool: 'browser.read', name: 'app' });

    should(JSON.stringify(read)).not.containEql(TOKEN);
    should(read.summary).containEql('created=[sealed:gh]');
  });

  it("should refuse a copy inside the page's queue while the owner's value holds the page, reading nothing", async () => {
    const w = pageWorld({ heldByOwner: true });
    await w.service.call(agent, { tool: 'browser.open', name: 'app' });

    const refusal = await refused(w.service.call(agent, FROM_PAGE));

    should(refusal.code).equal('conflict');
    should(w.page.asked).eql([]);
    should(w.copies.list('s1')).eql([]);
  });

  it('should not count the copy itself as the agent reading the page', async () => {
    const w = pageWorld();
    await w.service.call(agent, { tool: 'browser.open', name: 'app' });

    const result = await w.service.call(agent, FROM_PAGE);

    should(result.copies?.[0]?.exposure.pageReadBeforeCapture).be.false();
    should(w.records.seen('s1', ['app'])).eql([]);
  });

  it('should say the agent read the very document it then copied from', async () => {
    const w = pageWorld();
    await w.service.call(agent, { tool: 'browser.open', name: 'app' });
    await w.service.call(agent, { tool: 'browser.read', name: 'app' });

    const result = await w.service.call(agent, FROM_PAGE);

    should(result.copies?.[0]?.exposure.pageReadBeforeCapture).be.true();
    should(result.summary).containEql('WARNING: you read this page before sealing it');
    should(result.summary).containEql('The page is not pictured until it shows another document');
    should(w.records.seen('s1', ['app'])).eql(['loader-1']);
  });
});
