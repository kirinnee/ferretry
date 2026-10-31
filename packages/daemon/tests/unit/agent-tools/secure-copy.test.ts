import { describe, it } from 'bun:test';
import type { AgentToolCall } from '@ferretry/protocol';
import should from 'should';
import {
  type AgentToolError,
  EphemeralValues,
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
