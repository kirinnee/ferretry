import { describe, expect, test } from 'bun:test';
import { OP_EFFECTS } from '@ferretry/kernel/contract';
import manifest from '../../manifest.ts';

const routes = manifest.actions.routes;
const tools = manifest.actions.agentTools;

describe('terminals manifest', () => {
  test("declares today's terminal, process, console, snapshot, attach and surface routes and the viewer stream", () => {
    expect(routes).toHaveLength(17);
    expect(routes.map(route => route.key)).toContain('GET /v1/ferrets/:ferretId/snapshot');
    expect(manifest.actions.sockets.map(socket => socket.key)).toEqual([
      'GET /v1/ferrets/:ferretId/terminals/:terminalId/stream',
    ]);
  });
  test('attaching to a pane must arrive over the privileged local listener', () => {
    expect(routes.find(route => route.key === 'GET /v1/ferrets/:ferretId/attach')?.privilegedOnly).toBe(true);
  });
  test('anything that may show pane text is built inside one Redaction.read (guard: secrets)', () => {
    expect(manifest.actions.sockets[0]?.guard).toBe('secrets');
    expect(routes.find(route => route.key === 'GET /v1/ferrets/:ferretId/processes/:processId/output')?.guard).toBe(
      'secrets',
    );
  });
  test("declares today's eight terminal tools; every act names an Op, and only a read-effect Op may show text", () => {
    expect(tools.map(entry => entry.name)).toEqual([
      'terminal_list',
      'terminal_open',
      'terminal_send',
      'terminal_read',
      'terminal_wait',
      'terminal_close',
      'terminal_ask_owner',
      'terminal_request_input',
    ]);
    for (const entry of tools) {
      if (entry.op === undefined) continue;
      const effects: readonly string[] = OP_EFFECTS[entry.op];
      if (!effects.includes('reads')) expect(entry.guard).not.toBe('secrets');
      else expect(entry.guard).toBe('secrets');
    }
  });
  test('takes the terminal input target, the tmux runner and the %terminal reference menu', () => {
    expect(manifest.hooks.takes.map(take => `${take.hook.name}:${take.key}`)).toEqual([
      'input.targets:terminal',
      'runners:tmux',
      'reference.catalog:%terminal',
    ]);
  });
  test('declares the tmux-release doctor row and selftest, and takes no contributed doctor hook', () => {
    expect(manifest.doctor).toContain('tmux-release');
    expect(manifest.selftest).toEqual(['tmux-release']);
  });
  test('uses neither Browsers nor the Warden, so their optional uses of Terminals make no cycle', () => {
    const edges = [...Object.keys(manifest.needs), ...Object.keys((manifest as { uses?: object }).uses ?? {})];
    expect(edges).not.toContain('browsers');
    expect(edges).not.toContain('warden');
  });
});
