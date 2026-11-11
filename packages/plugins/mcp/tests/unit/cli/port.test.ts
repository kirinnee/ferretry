import { describe, it } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import should from 'should';
import { clientToolsPort } from '../../../cli/lib/serve/port.ts';

type Seen = { readonly name: string; readonly input: unknown };

function clientOf(answers: readonly unknown[] | ((name: string, input: unknown) => unknown)) {
  const seen: Seen[] = [];
  const client = {
    call: async () => {
      throw new Error('a tool call is not a route call');
    },
    subscribe: () => () => undefined,
    tool: async (name: string, input?: unknown) => {
      seen.push({ name, input });
      if (typeof answers === 'function') return answers(name, input);
      return answers[Math.min(seen.length - 1, answers.length - 1)];
    },
  } as unknown as PluginClient;
  return { client, seen };
}

describe('clientToolsPort', () => {
  it('should call the tool door by name with the arguments and give back the tool’s result', async () => {
    const { client, seen } = clientOf([{ text: 'Open: dev', data: { surfaces: [] } }]);
    should(await clientToolsPort(client).call('terminal_list', {})).eql({ text: 'Open: dev', data: { surfaces: [] } });
    should(seen).eql([{ name: 'terminal_list', input: {} }]);
  });

  it('should refuse an answer that is not a tool result, and a client with no tool door', async () => {
    await clientToolsPort(clientOf([{ nonsense: true }]).client)
      .call('terminal_list', {})
      .then(
        () => should.fail(undefined, undefined, 'it should have refused'),
        (error: Error) => should(error.message).containEql('a shape this build does not read'),
      );
    const noDoor = { call: async () => undefined, subscribe: () => () => undefined } as unknown as PluginClient;
    await clientToolsPort(noDoor)
      .call('terminal_list', {})
      .then(
        () => should.fail(undefined, undefined, 'it should have refused'),
        (error: Error) => should(error.message).containEql('tool door'),
      );
  });

  it('should ask a terminal wait in slices of 25 s until the text matched', async () => {
    const { client, seen } = clientOf([
      { text: 'not yet', data: { matched: false } },
      { text: 'not yet', data: { matched: false } },
      { text: 'there', data: { matched: true } },
    ]);
    const result = await clientToolsPort(client).call('terminal_wait', {
      name: 'dev',
      text: 'ready',
      timeoutMs: 120_000,
    });
    should(result.text).equal('there');
    should(seen.map(call => (call.input as { timeoutMs: number }).timeoutMs)).eql([25_000, 25_000, 25_000]);
    should(seen[0]?.input).eql({ name: 'dev', text: 'ready', timeoutMs: 25_000 });
  });

  it('should stop a terminal wait when the budget is spent, with the last answer, and use 10 s by default', async () => {
    const { client, seen } = clientOf([{ text: 'timed out', data: { matched: false } }]);
    const result = await clientToolsPort(client).call('terminal_wait', { name: 'dev', exit: true });
    should(result.text).equal('timed out');
    should(seen).eql([{ name: 'terminal_wait', input: { name: 'dev', exit: true, timeoutMs: 10_000 } }]);
  });

  it('should stop a wait at once on an error result', async () => {
    const { client, seen } = clientOf([{ text: 'A person has taken over %terminal:dev.', isError: true }]);
    const result = await clientToolsPort(client).call('terminal_wait', { name: 'dev', exit: true, timeoutMs: 60_000 });
    should(result.isError).equal(true);
    should(seen).have.length(1);
  });

  it('should slice a page wait until it did not report "not yet", and ask a time wait once', async () => {
    const waited = clientOf([
      { text: 'timed out', data: { matched: false } },
      { text: 'seen', data: { matched: true } },
    ]);
    const result = await clientToolsPort(waited.client).call('browser_wait_for', {
      name: 'app',
      text: 'Done',
      timeoutMs: 60_000,
    });
    should(result.text).equal('seen');
    should(waited.seen).have.length(2);
    const slept = clientOf([{ text: 'waited', data: { matched: false } }]);
    await clientToolsPort(slept.client).call('browser_wait_for', { name: 'app', time: 5_000 });
    should(slept.seen).eql([{ name: 'browser_wait_for', input: { name: 'app', time: 5_000 } }]);
  });
});
