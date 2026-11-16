import { describe, it } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import should from 'should';
import {
  CHANNEL_BACKOFF_MAX_MS,
  CHANNEL_BACKOFF_START_MS,
  CHANNEL_INSTRUCTIONS,
  CHANNEL_POLL_WAIT_MS,
  type ChannelMessage,
  type ChannelPort,
  ChannelPump,
  channelNotification,
  parseChannelMessages,
} from '../../../cli/lib/serve/channel.ts';
import { clientChannelPort } from '../../../cli/lib/serve/port.ts';
import { McpServer } from '../../../cli/lib/serve/server.ts';
import { serveTools } from '../../../cli/serve.ts';

const banner = '[from :abby]\nplease look at the build';
const message: ChannelMessage = { sendId: 'send-1', text: banner, from: 'abby' };

describe('the channel notification', () => {
  it('should carry the exact text and a meta with the send id and sender, and no `source` key', () => {
    const line = channelNotification(message);
    should(line.endsWith('\n')).be.true();
    const parsed = JSON.parse(line) as { jsonrpc: string; method: string; params: { content: string; meta: object } };
    should(parsed).eql({
      jsonrpc: '2.0',
      method: 'notifications/claude/channel',
      params: { content: banner, meta: { send_id: 'send-1', from: 'abby' } },
    });
    should(Object.keys(parsed.params.meta)).not.containEql('source');
  });

  it('should leave `from` out of the meta when the message names no sender', () => {
    const parsed = JSON.parse(channelNotification({ sendId: 'n-1', text: 'Ferretry notice' })) as {
      params: { meta: object };
    };
    should(parsed.params.meta).eql({ send_id: 'n-1' });
  });

  it('should read the daemon’s poll answer, and refuse one that is not the shape', () => {
    should(
      parseChannelMessages({
        messages: [
          { sendId: 'a', text: 't', from: 'x', extra: 1 },
          { sendId: 'b', text: 'u' },
        ],
      }),
    ).eql([
      { sendId: 'a', text: 't', from: 'x' },
      { sendId: 'b', text: 'u' },
    ]);
    should(parseChannelMessages({ messages: [] })).eql([]);
    should(parseChannelMessages({ messages: [{ sendId: '', text: 't' }] })).be.undefined();
    should(parseChannelMessages(undefined)).be.undefined();
  });
});

const GEN = 'gen-test';

/** A port whose polls are answered from a script; once the script runs out it stops the pump. Claims are granted unless refused. */
function scripted(
  pump: { current?: ChannelPump },
  script: readonly (readonly ChannelMessage[] | Error)[],
  options: { readonly refuse?: ReadonlySet<string>; readonly events?: string[] } = {},
) {
  const polls: { generation: string; waitMs: number }[] = [];
  const claims: { generation: string; sendId: string }[] = [];
  let index = 0;
  const port: ChannelPort = {
    poll: async (generation, waitMs) => {
      polls.push({ generation, waitMs });
      const step = script[index++];
      if (step === undefined) {
        pump.current?.stop();
        return [];
      }
      if (step instanceof Error) throw step;
      return step;
    },
    claim: async (generation, sendId) => {
      claims.push({ generation, sendId });
      options.events?.push(`claim ${sendId}`);
      return options.refuse?.has(sendId) !== true;
    },
  };
  return { port, polls, claims };
}

const seams = { generation: GEN, sleep: async () => undefined };

describe('ChannelPump', () => {
  it('should claim a candidate BEFORE writing it, then write exactly one notification', async () => {
    const holder: { current?: ChannelPump } = {};
    const events: string[] = [];
    const { port, polls, claims } = scripted(holder, [[message]], { events });
    holder.current = new ChannelPump(port, line => events.push(`write ${line.length > 0 ? 'line' : ''}`), seams);
    await holder.current.start();
    should(events).eql(['claim send-1', 'write line']);
    should(claims).eql([{ generation: GEN, sendId: 'send-1' }]);
    should(polls[0]).eql({ generation: GEN, waitMs: CHANNEL_POLL_WAIT_MS });
  });

  it('should write the notification text exactly as the daemon handed it', async () => {
    const holder: { current?: ChannelPump } = {};
    const { port } = scripted(holder, [[message]]);
    const written: string[] = [];
    holder.current = new ChannelPump(port, line => written.push(line), seams);
    await holder.current.start();
    should(written).eql([channelNotification(message)]);
  });

  it('should write NOTHING for a message whose claim the daemon refused (withdrawn: the fallback typed it instead)', async () => {
    const holder: { current?: ChannelPump } = {};
    const second: ChannelMessage = { sendId: 'send-2', text: 'second' };
    const { port, claims } = scripted(holder, [[message, second]], { refuse: new Set(['send-1']) });
    const written: string[] = [];
    holder.current = new ChannelPump(port, line => written.push(line), seams);
    await holder.current.start();
    should(written).eql([channelNotification(second)]);
    should(claims.map(claim => claim.sendId)).eql(['send-1', 'send-2']);
  });

  it('should write nothing for a message whose claim FAILED, and say so (nothing is pushed on a guess)', async () => {
    const holder: { current?: ChannelPump } = {};
    const { port } = scripted(holder, [[message]]);
    const errors: string[] = [];
    const written: string[] = [];
    holder.current = new ChannelPump(
      {
        poll: port.poll,
        claim: async () => {
          throw new Error('no claim');
        },
      },
      line => written.push(line),
      { ...seams, onError: text => errors.push(text) },
    );
    await holder.current.start();
    should(written).eql([]);
    should(errors).eql(['channel claim failed: no claim']);
  });

  it('should say a claim failure that is not an Error as its text, and a missing onError is fine', async () => {
    const holder: { current?: ChannelPump } = {};
    const { port } = scripted(holder, [[message], [message]]);
    const errors: string[] = [];
    holder.current = new ChannelPump(
      {
        poll: port.poll,
        claim: async () => {
          throw 'plain claim';
        },
      },
      () => undefined,
      { ...seams, onError: text => errors.push(text) },
    );
    await holder.current.start();
    should(errors[0]).equal('channel claim failed: plain claim');
    const silentHolder: { current?: ChannelPump } = {};
    const silentScript = scripted(silentHolder, [[message]]);
    silentHolder.current = new ChannelPump(
      {
        poll: silentScript.port.poll,
        claim: async () => {
          throw new Error('x');
        },
      },
      () => undefined,
      seams,
    );
    await silentHolder.current.start();
  });

  it('should write every message of a batch, in order, claiming each one first', async () => {
    const holder: { current?: ChannelPump } = {};
    const second: ChannelMessage = { sendId: 'send-2', text: 'second' };
    const { port, claims } = scripted(holder, [[message, second]]);
    const written: string[] = [];
    holder.current = new ChannelPump(port, line => written.push(line), seams);
    await holder.current.start();
    should(written).eql([channelNotification(message), channelNotification(second)]);
    should(claims.map(claim => claim.sendId)).eql(['send-1', 'send-2']);
  });

  it('should stop claiming and writing the rest of a batch once stopped', async () => {
    const holder: { current?: ChannelPump } = {};
    const second: ChannelMessage = { sendId: 'send-2', text: 'second' };
    const { port, claims } = scripted(holder, [[message, second]]);
    const written: string[] = [];
    holder.current = new ChannelPump(
      {
        poll: port.poll,
        claim: async (generation, sendId) => {
          const granted = await port.claim(generation, sendId);
          holder.current?.stop();
          return granted;
        },
      },
      line => written.push(line),
      seams,
    );
    await holder.current.start();
    should(written).eql([channelNotification(message)]);
    should(claims.map(claim => claim.sendId)).eql(['send-1']);
  });

  it('should write nothing for an empty poll, and poll again', async () => {
    const holder: { current?: ChannelPump } = {};
    const { port, polls, claims } = scripted(holder, [[], []]);
    const written: string[] = [];
    holder.current = new ChannelPump(port, line => written.push(line), seams);
    await holder.current.start();
    should(written).eql([]);
    should(claims).eql([]);
    should(polls.length).equal(3);
  });

  it('should back off, doubling to a cap, when a poll fails, and never crash', async () => {
    const holder: { current?: ChannelPump } = {};
    const failures = Array.from({ length: 7 }, () => new Error('daemon down'));
    const { port } = scripted(holder, [...failures, [message]]);
    const slept: number[] = [];
    const errors: string[] = [];
    const written: string[] = [];
    holder.current = new ChannelPump(port, line => written.push(line), {
      generation: GEN,
      sleep: async ms => {
        slept.push(ms);
      },
      onError: text => errors.push(text),
    });
    await holder.current.start();
    should(slept.slice(0, 3)).eql([
      CHANNEL_BACKOFF_START_MS,
      CHANNEL_BACKOFF_START_MS * 2,
      CHANNEL_BACKOFF_START_MS * 4,
    ]);
    should(Math.max(...slept)).equal(CHANNEL_BACKOFF_MAX_MS);
    should(errors[0]).equal('channel poll failed: daemon down');
    should(written).eql([channelNotification(message)]);
  });

  it('should start the backoff over after a good poll', async () => {
    const holder: { current?: ChannelPump } = {};
    const { port } = scripted(holder, [new Error('a'), new Error('b'), [], new Error('c')]);
    const slept: number[] = [];
    holder.current = new ChannelPump(port, () => undefined, {
      generation: GEN,
      sleep: async ms => void slept.push(ms),
    });
    await holder.current.start();
    should(slept).eql([CHANNEL_BACKOFF_START_MS, CHANNEL_BACKOFF_START_MS * 2, CHANNEL_BACKOFF_START_MS]);
  });

  it('should say a poll failure that is not an Error as its text, and a missing onError is fine', async () => {
    const holder: { current?: ChannelPump } = {};
    let polled = 0;
    const errors: string[] = [];
    holder.current = new ChannelPump(
      {
        poll: async () => {
          polled += 1;
          if (polled === 1) throw 'plain text';
          holder.current?.stop();
          return [message];
        },
        claim: async () => true,
      },
      () => undefined,
      { ...seams, onError: text => errors.push(text) },
    );
    await holder.current.start();
    // Stopped while the poll was in flight: its message was not handed to Claude, so it is not even claimed.
    should(errors).eql(['channel poll failed: plain text']);
    const silent = new ChannelPump(
      {
        poll: async () => {
          silent.stop();
          throw new Error('x');
        },
        claim: async () => true,
      },
      () => undefined,
      seams,
    );
    await silent.start();
  });

  it('should ignore a second start while it runs', async () => {
    const holder: { current?: ChannelPump } = {};
    const { port, polls } = scripted(holder, []);
    holder.current = new ChannelPump(port, () => undefined, seams);
    const first = holder.current.start();
    await holder.current.start();
    await first;
    should(polls.length).equal(1);
  });
});

function door(handlers: Record<string, (input: Record<string, unknown>) => unknown>): PluginClient {
  return {
    call: async () => undefined,
    subscribe: () => () => undefined,
    tool: async (name: string, input?: unknown) => await handlers[name]?.((input ?? {}) as Record<string, unknown>),
  } as unknown as PluginClient;
}

describe('clientChannelPort', () => {
  it('should poll the daemon’s channel_poll with the generation and the wait and return the candidates', async () => {
    const seen: unknown[] = [];
    const port = clientChannelPort(
      door({
        channel_poll: input => {
          seen.push(input);
          return { text: 'ok', data: { messages: [{ sendId: 's', text: 'hi', from: 'abby' }] } };
        },
      }),
    );
    should(await port.poll(GEN, 20_000)).eql([{ sendId: 's', text: 'hi', from: 'abby' }]);
    should(seen).eql([{ generation: GEN, waitMs: 20_000 }]);
  });

  it('should claim through channel_claim with the generation and the send id, and answer what the daemon granted', async () => {
    const seen: unknown[] = [];
    const port = clientChannelPort(
      door({
        channel_claim: input => {
          seen.push(input);
          return { text: 'claimed', data: { claimed: input.sendId === 'a' } };
        },
      }),
    );
    should(await port.claim(GEN, 'a')).be.true();
    should(await port.claim(GEN, 'b')).be.false();
    should(seen).eql([
      { generation: GEN, sendId: 'a' },
      { generation: GEN, sendId: 'b' },
    ]);
  });

  it('should throw when channel_claim answers in a shape it cannot read', async () => {
    await clientChannelPort(door({ channel_claim: () => ({ text: 'ok', data: { claimed: 'yes' } }) }))
      .claim(GEN, 'a')
      .then(
        () => should.fail(undefined, undefined, 'it should have thrown'),
        (error: Error) => should(error.message).containEql('channel_claim in a shape this build does not read'),
      );
  });

  it('should throw the daemon’s sentence for a refused call, and for an answer it cannot read', async () => {
    await clientChannelPort(door({ channel_poll: () => ({ text: 'not allowed', isError: true }) }))
      .poll(GEN, 1)
      .then(
        () => should.fail(undefined, undefined, 'it should have thrown'),
        (error: Error) => should(error.message).equal('not allowed'),
      );
    await clientChannelPort(door({ channel_poll: () => ({ nonsense: true }) }))
      .poll(GEN, 1)
      .then(
        () => should.fail(undefined, undefined, 'it should have thrown'),
        (error: Error) => should(error.message).containEql('a shape this build does not read'),
      );
    await clientChannelPort(door({ channel_poll: () => ({ text: 'ok', data: { messages: 'no' } }) }))
      .poll(GEN, 1)
      .then(
        () => should.fail(undefined, undefined, 'it should have thrown'),
        (error: Error) => should(error.message).containEql('channel_poll in a shape this build does not read'),
      );
  });

  it('should throw when the build has no tool door', async () => {
    const noDoor = { call: async () => undefined, subscribe: () => () => undefined } as unknown as PluginClient;
    await clientChannelPort(noDoor)
      .poll(GEN, 1)
      .then(
        () => should.fail(undefined, undefined, 'it should have thrown'),
        (error: Error) => should(error.message).containEql('tool door'),
      );
  });
});

describe('McpServer — the channel', () => {
  const server = (options: { channel?: boolean; instructions?: string | undefined; onInitialized?: () => void } = {}) =>
    new McpServer(
      { call: async () => ({ text: 'ok' }) },
      {
        name: 'ferretry',
        version: '1',
        ...(options.instructions === undefined && 'instructions' in options
          ? {}
          : { instructions: options.instructions ?? 'Tools.' }),
        ...(options.channel === undefined ? {} : { channel: options.channel }),
      },
      options.onInitialized,
    );

  it('should declare the claude/channel capability and say whose messages the channel carries WHEN the launch gave the channel flag', async () => {
    const answer = (await server({ channel: true }).handle({ jsonrpc: '2.0', id: 1, method: 'initialize' })) as {
      result: { capabilities: { experimental: object }; instructions: string };
    };
    should(answer.result.capabilities.experimental).eql({ 'claude/channel': {} });
    should(answer.result.instructions).equal(`Tools. ${CHANNEL_INSTRUCTIONS}`);
    should(CHANNEL_INSTRUCTIONS).containEql('<channel source="ferretry">');
    should(CHANNEL_INSTRUCTIONS).containEql('never through the channel');
  });

  it('should declare NO channel and keep the plain instructions when the launch did not give the channel flag', async () => {
    for (const handler of [server(), server({ channel: false })]) {
      const answer = (await handler.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' })) as {
        result: { capabilities: object; instructions: string };
      };
      should(answer.result.capabilities).eql({ tools: { listChanged: false } });
      should(answer.result.instructions).equal('Tools.');
    }
  });

  it('should say only the channel words when the server has no instructions of its own, and nothing when neither', async () => {
    should(
      await server({ channel: true, instructions: undefined }).handle({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    ).match({
      result: { instructions: CHANNEL_INSTRUCTIONS },
    });
    const plain = (await server({ instructions: undefined }).handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    })) as {
      result: object;
    };
    should(plain.result).not.have.property('instructions');
  });

  it('should start the channel only on the client’s `initialized` notification, and still answer nothing', async () => {
    let started = 0;
    const handler = server({
      onInitialized: () => {
        started += 1;
      },
    });
    await handler.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    should(started).equal(0);
    should(await handler.handle({ jsonrpc: '2.0', method: 'notifications/cancelled' })).be.undefined();
    should(started).equal(0);
    should(await handler.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).be.undefined();
    should(started).equal(1);
  });

  it('should not list the channel tools to a model', async () => {
    const answer = (await server({ channel: true }).handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as {
      result: { tools: { name: string }[] };
    };
    should(answer.result.tools.map(tool => tool.name).filter(name => name.startsWith('channel_'))).eql([]);
  });
});

describe('serveTools — the channel end to end', () => {
  const lines =
    (...requests: object[]): (() => AsyncIterable<Uint8Array>) =>
    () =>
      (async function* () {
        for (const request of requests) yield new TextEncoder().encode(`${JSON.stringify(request)}\n`);
      })();

  function context(options: {
    stdin?: ReturnType<typeof lines>;
    sleep?: (ms: number) => Promise<void> | undefined;
    channel?: boolean;
    generation?: string;
  }) {
    const out: string[] = [];
    const err: string[] = [];
    const calls: { name: string; input: unknown }[] = [];
    let polls = 0;
    const client = {
      call: async () => undefined,
      subscribe: () => () => undefined,
      tool: async (name: string, input?: unknown) => {
        calls.push({ name, input });
        if (name === 'channel_poll') {
          polls += 1;
          return polls === 1
            ? { text: 'ok', data: { messages: [{ sendId: 'send-1', text: banner, from: 'abby' }] } }
            : new Promise(() => undefined);
        }
        return { text: 'ok', data: { claimed: true } };
      },
    } as unknown as PluginClient;
    return {
      out,
      err,
      calls,
      run: async () =>
        await serveTools({
          client,
          io: { out: text => void out.push(text), err: text => void err.push(text) },
          stdin: options.stdin,
          version: '1',
          instructions: 'Tools.',
          sleep: options.sleep === undefined ? undefined : async ms => void (await options.sleep?.(ms)),
          ...(options.channel === undefined ? {} : { channel: options.channel }),
          ...(options.generation === undefined ? {} : { generation: options.generation }),
        }),
    };
  }

  it('should refuse to serve without standard input', async () => {
    const { run, err } = context({});
    should(await run()).equal(70);
    should(err.join('')).containEql('no standard input');
  });

  it('should push the daemon’s message as one notification after `initialized`, claiming it first, when the launch gave the channel flag', async () => {
    const { run, out, calls } = context({
      stdin: lines(
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
      ),
      sleep: async () => undefined,
      channel: true,
      generation: 'gen-serve',
    });
    should(await run()).equal(0);
    // The pump polls on a later tick than the input ending, so let it run once.
    await new Promise(resolve => setTimeout(resolve, 20));
    const channel = out.filter(line => line.includes('notifications/claude/channel'));
    should(channel).eql([channelNotification(message)]);
    should(calls.find(call => call.name === 'channel_poll')?.input).eql({
      generation: 'gen-serve',
      waitMs: CHANNEL_POLL_WAIT_MS,
    });
    should(calls.find(call => call.name === 'channel_claim')?.input).eql({
      generation: 'gen-serve',
      sendId: 'send-1',
    });
    should(calls.map(call => call.name)).not.containEql('channel_ack');
  });

  it('should take a fresh generation per process when the caller names none', async () => {
    const { run, calls } = context({
      stdin: lines({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      sleep: async () => undefined,
      channel: true,
    });
    await run();
    await new Promise(resolve => setTimeout(resolve, 20));
    const poll = calls.find(call => call.name === 'channel_poll')?.input as { generation: string } | undefined;
    should((poll?.generation ?? '').length).be.above(8);
  });

  it('should NEVER poll when the launch did not give the channel flag, even though the shell has a timer (regression)', async () => {
    for (const channel of [undefined, false]) {
      const { run, out, calls } = context({
        stdin: lines(
          { jsonrpc: '2.0', id: 1, method: 'initialize' },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
        ),
        sleep: async () => undefined,
        ...(channel === undefined ? {} : { channel }),
      });
      should(await run()).equal(0);
      await new Promise(resolve => setTimeout(resolve, 20));
      should(calls).eql([]);
      should(out.filter(line => line.includes('notifications/claude/channel'))).eql([]);
    }
  });

  it('should serve the tools with no channel when the shell gives no timer', async () => {
    const { run, out, calls } = context({
      stdin: lines({ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }),
      channel: true,
    });
    should(await run()).equal(0);
    await new Promise(resolve => setTimeout(resolve, 20));
    should(calls).eql([]);
    should(out.length).equal(1);
  });

  it('should write a failed poll to standard error, not to the client', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const client = {
      call: async () => undefined,
      subscribe: () => () => undefined,
      tool: async () => {
        throw new Error('daemon down');
      },
    } as unknown as PluginClient;
    await serveTools({
      client,
      io: { out: text => void out.push(text), err: text => void err.push(text) },
      stdin: lines({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      version: '1',
      instructions: 'Tools.',
      channel: true,
      sleep: async () => {
        await new Promise(resolve => setTimeout(resolve, 1_000));
      },
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    should(err.join('')).containEql('channel poll failed: daemon down');
    should(out).eql([]);
  });
});
