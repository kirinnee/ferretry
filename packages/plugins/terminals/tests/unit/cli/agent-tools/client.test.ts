import { describe, expect, it } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { TerminalToolsClient } from '../../../../cli/lib/agent-tools/client.ts';
import { recordingClient } from '../../../support/cli/doubles.ts';

const AT = '2026-11-07T10:00:00.000Z';
const VIEW = {
  sessionId: 'f-1',
  driving: [],
  takeovers: [{ surface: 'terminal', id: 't-1', name: 'dev', by: { by: 'local' }, since: AT }],
  handed: [],
  opened: [],
  asked: [],
};

describe('what the terminal verbs make of the daemon’s answers', () => {
  it('reads a bare report as an answer that is not an error', async () => {
    const { client } = recordingClient(() => ({ summary: 'Closed dev.', matched: true }));
    const answer = await new TerminalToolsClient(client).call('terminal_close', { name: 'dev' }, 'f-1');
    expect(answer).toEqual({ report: { summary: 'Closed dev.', matched: true }, isError: false });
  });

  it('falls back to the answer’s text when its data is no report, and keeps the error flag', async () => {
    const { client } = recordingClient(() => ({ text: 'taken over', isError: true, data: { nope: 1 } }));
    const answer = await new TerminalToolsClient(client).call('terminal_close', { name: 'dev' }, 'f-1');
    expect(answer).toEqual({ report: { summary: 'taken over' }, isError: true });
  });

  it('refuses an answer in a shape it does not read, in words', async () => {
    const { client } = recordingClient(() => 42);
    await expect(new TerminalToolsClient(client).call('terminal_list', {}, 'f-1')).rejects.toThrow(
      'the daemon answered a terminal tool in a shape this build does not read',
    );
  });

  it('reads who holds what for a ferret, and refuses a view in the wrong shape', async () => {
    const { client, calls } = recordingClient(() => VIEW);
    const view = await new TerminalToolsClient(client).view('f-1');
    expect(view.takeovers).toHaveLength(1);
    expect(calls).toEqual([
      { route: 'GET /v1/ferrets/:ferretId/surfaces/terminals/control', params: { ferretId: 'f-1' } },
    ]);
    const broken: PluginClient = { call: async () => ({ nope: true }) as never, subscribe: () => () => undefined };
    await expect(new TerminalToolsClient(broken).view('f-1')).rejects.toThrow();
  });
});
