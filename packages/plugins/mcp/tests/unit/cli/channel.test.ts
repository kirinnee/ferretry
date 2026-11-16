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

/** A port whose polls are answered from a script; once the script runs out it stops the pump. */
function scripted(pump: { current?: ChannelPump }, script: readonly (readonly ChannelMessage[] | Error)[]) {
  const polls: number[] = [];
  const acks: (readonly string[])[] = [];
  let index = 0;
  const port: ChannelPort = {
    poll: async waitMs => {
      polls.push(waitMs);
      const step = script[index++];
      if (step === undefined) {
        pump.current?.stop();
        return [];
      }
      if (step instanceof Error) throw step;
      return step;
    },
    ack: async ids => {
      acks.push(ids);
    },
  };
  return { port, polls, acks };
}

describe('ChannelPump', () => {
  it('should forward a daemon message as exactly one notification, then ack it', async () => {
    const holder: { current?: ChannelPump } = {};
    const { port, polls, acks } = scripted(holder, [[message]]);
    const written: string[] = [];
    holder.current = new ChannelPump(port, line => written.push(line), { sleep: async () => undefined });
    await holder.current.start();
    should(written).eql([channelNotification(message)]);
    should(acks).eql([['send-1']]);
    should(polls[0]).equal(CHANNEL_POLL_WAIT_MS);
  });

  it('should write every message of a batch, in order, and ack them together', async () => {
    const holder: { current?: ChannelPump } = {};
    const second: ChannelMessage = { sendId: 'send-2', text: 'second' };
    const { port, acks } = scripted(holder, [[message, second]]);
    const written: string[] = [];
    holder.current = new ChannelPump(port, line => written.push(line), { sleep: async () => undefined });
    await holder.current.start();
    should(written).eql([channelNotification(message), channelNotification(second)]);
    should(acks).eql([['send-1', 'send-2']]);
  });

  it('should write nothing for an empty poll, and poll again', async () => {
    const holder: { current?: ChannelPump } = {};
    const { port, polls, acks } = scripted(holder, [[], []]);
    const written: string[] = [];
    holder.current = new ChannelPump(port, line => written.push(line), { sleep: async () => undefined });
    await holder.current.start();
    should(written).eql([]);
    should(acks).eql([]);
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
      sleep: async ms => void slept.push(ms),
    });
    await holder.current.start();
    should(slept).eql([CHANNEL_BACKOFF_START_MS, CHANNEL_BACKOFF_START_MS * 2, CHANNEL_BACKOFF_START_MS]);
  });

  it('should keep going, and say so, when an ack fails', async () => {
    const holder: { current?: ChannelPump } = {};
    const { port } = scripted(holder, [[message]]);
    const errors: string[] = [];
    const written: string[] = [];
    holder.current = new ChannelPump(
      {
        poll: port.poll,
        ack: async () => {
          throw new Error('no ack');
        },
      },
      line => written.push(line),
      { sleep: async () => undefined, onError: text => errors.push(text) },
    );
    await holder.current.start();
    should(written).eql([channelNotification(message)]);
    should(errors).eql(['channel ack failed: no ack']);
  });

  it('should say a failure that is not an Error as its text, and a missing onError is fine', async () => {
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
        ack: async () => {
          throw 'plain ack';
        },
      },
      () => undefined,
      { sleep: async () => undefined, onError: text => errors.push(text) },
    );
    await holder.current.start();
    // Stopped while the poll was in flight: its message was not handed to Claude, so it is not acked either.
    should(errors).eql(['channel poll failed: plain text']);
    const silent = new ChannelPump(
      {
        poll: async () => {
          silent.stop();
          throw new Error('x');
        },
        ack: async () => undefined,
      },
      () => undefined,
      { sleep: async () => undefined },
    );
    await silent.start();
  });

  it('should ignore a second start while it runs', async () => {
    const holder: { current?: ChannelPump } = {};
    const { port, polls } = scripted(holder, []);
    holder.current = new ChannelPump(port, () => undefined, { sleep: async () => undefined });
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
  it('should poll the daemon’s channel_poll with the wait and return the messages', async () => {
    const seen: unknown[] = [];
    const port = clientChannelPort(
      door({
        channel_poll: input => {
          seen.push(input);
          return { text: 'ok', data: { messages: [{ sendId: 's', text: 'hi', from: 'abby' }] } };
        },
      }),
    );
    should(await port.poll(20_000)).eql([{ sendId: 's', text: 'hi', from: 'abby' }]);
    should(seen).eql([{ waitMs: 20_000 }]);
  });

  it('should ack through channel_ack with the ids', async () => {
    const seen: unknown[] = [];
    await clientChannelPort(
      door({
        channel_ack: input => {
          seen.push(input);
          return { text: 'ok', data: { acked: 2 } };
        },
      }),
    ).ack(['a', 'b']);
    should(seen).eql([{ sendIds: ['a', 'b'] }]);
  });

  it('should throw the daemon’s sentence for a refused call, and for an answer it cannot read', async () => {
    await clientChannelPort(door({ channel_poll: () => ({ text: 'not allowed', isError: true }) }))
      .poll(1)
      .then(
        () => should.fail(undefined, undefined, 'it should have thrown'),
        (error: Error) => should(error.message).equal('not allowed'),
      );
    await clientChannelPort(door({ channel_poll: () => ({ nonsense: true }) }))
      .poll(1)
      .then(
        () => should.fail(undefined, undefined, 'it should have thrown'),
        (error: Error) => should(error.message).containEql('a shape this build does not read'),
      );
    await clientChannelPort(door({ channel_poll: () => ({ text: 'ok', data: { messages: 'no' } }) }))
      .poll(1)
      .then(
        () => should.fail(undefined, undefined, 'it should have thrown'),
        (error: Error) => should(error.message).containEql('channel_poll in a shape this build does not read'),
      );
  });

  it('should throw when the build has no tool door', async () => {
    const noDoor = { call: async () => undefined, subscribe: () => () => undefined } as unknown as PluginClient;
    await clientChannelPort(noDoor)
      .poll(1)
      .then(
        () => should.fail(undefined, undefined, 'it should have thrown'),
        (error: Error) => should(error.message).containEql('tool door'),
      );
  });
});

describe('McpServer — the channel', () => {
  const server = (onInitialized?: () => void) =>
    new McpServer(
      { call: async () => ({ text: 'ok' }) },
      { name: 'ferretry', version: '1', instructions: 'Tools.' },
      onInitialized,
    );

  it('should declare the claude/channel capability and say whose messages the channel carries', async () => {
    const answer = (await server().handle({ jsonrpc: '2.0', id: 1, method: 'initialize' })) as {
      result: { capabilities: { experimental: object }; instructions: string };
    };
    should(answer.result.capabilities.experimental).eql({ 'claude/channel': {} });
    should(answer.result.instructions).equal(`Tools. ${CHANNEL_INSTRUCTIONS}`);
    should(CHANNEL_INSTRUCTIONS).containEql('<channel source="ferretry">');
    should(CHANNEL_INSTRUCTIONS).containEql('never through the channel');
  });

  it('should say only the channel words when the server has no instructions of its own', async () => {
    const bare = new McpServer({ call: async () => ({ text: 'ok' }) }, { name: 'ferretry', version: '1' });
    should(await bare.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' })).match({
      result: { instructions: CHANNEL_INSTRUCTIONS },
    });
  });

  it('should start the channel only on the client’s `initialized` notification, and still answer nothing', async () => {
    let started = 0;
    const handler = server(() => {
      started += 1;
    });
    await handler.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    should(started).equal(0);
    should(await handler.handle({ jsonrpc: '2.0', method: 'notifications/cancelled' })).be.undefined();
    should(started).equal(0);
    should(await handler.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).be.undefined();
    should(started).equal(1);
  });

  it('should not list the channel tools to a model', async () => {
    const answer = (await server().handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as {
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

  function context(options: { stdin?: ReturnType<typeof lines>; sleep?: (ms: number) => Promise<void> | undefined }) {
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
        return { text: 'ok', data: { acked: 1 } };
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
        }),
    };
  }

  it('should refuse to serve without standard input', async () => {
    const { run, err } = context({});
    should(await run()).equal(70);
    should(err.join('')).containEql('no standard input');
  });

  it('should push the daemon’s message as one notification after `initialized`, and ack it', async () => {
    const { run, out, calls } = context({
      stdin: lines(
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
      ),
      sleep: async () => undefined,
    });
    should(await run()).equal(0);
    // The pump polls on a later tick than the input ending, so let it run once.
    await new Promise(resolve => setTimeout(resolve, 20));
    const channel = out.filter(line => line.includes('notifications/claude/channel'));
    should(channel).eql([channelNotification(message)]);
    should(calls.map(call => call.name)).containEql('channel_ack');
    should(calls.find(call => call.name === 'channel_ack')?.input).eql({ sendIds: ['send-1'] });
  });

  it('should serve the tools with no channel when the shell gives no timer', async () => {
    const { run, out, calls } = context({
      stdin: lines({ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }),
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
      sleep: async () => {
        await new Promise(resolve => setTimeout(resolve, 1_000));
      },
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    should(err.join('')).containEql('channel poll failed: daemon down');
    should(out).eql([]);
  });
});
