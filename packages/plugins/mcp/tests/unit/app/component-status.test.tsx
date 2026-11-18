/**
 * `runtimes.component-mcp` — where one MCP component stands, under its row in Runtimes' Profiles library: the row's status
 * line with Check and Sign in, or why there is nothing to check. Every row shares ONE read of the machine's inventory.
 */
import type { FC } from 'react';
import { afterEach, describe, expect, it } from 'bun:test';
import type { Mounted } from '@ferretry/app/testing';
import { createComponentStatusPanel, unusedWords } from '../../../app/views/component-status.tsx';
import { createSurfaces } from '../../../app/views/surfaces.tsx';
import { type Answers, type Call, MCP, mcpServer, NOW, scriptedClient } from './mcp-fixtures.ts';
import { click, mountSettled, text } from './mcp-view-support.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const CHECK = 'POST /v1/mcp/check';
const NO_RUNTIME = 'No runtime’s profile uses it yet, so no ferret starts it and there is nothing to check.';
const NOT_YET = 'Its runtimes haven’t picked it up yet, so there is nothing to check. They do at their next launch.';

/** The panels as Runtimes' library mounts them, one per row, on one client. */
const mountRows = async (
  rows: readonly Record<string, unknown>[],
  answers: Answers = {},
  calls: Call[] = [],
): Promise<ParentNode> => {
  const client = scriptedClient({ 'GET /v1/mcp': MCP, ...answers }, calls);
  const Panel = createComponentStatusPanel(client as never) as unknown as FC<Record<string, unknown>>;
  mounted = await mountSettled(
    <>
      {rows.map(row => (
        <div key={String(row['subject'])} data-row={String(row['subject'])}>
          <Panel {...row} />
        </div>
      ))}
    </>,
  );
  return mounted.container;
};

const status = (root: ParentNode, row: string): string =>
  root.querySelector(`[data-row="${row}"] [data-component-mcp-status]`)?.getAttribute('data-component-mcp-status') ??
  '';

describe('mcp#2 the status under an MCP server’s row in the Profiles library', () => {
  it('S-0061 draws the server’s own status line, from the machine’s inventory, with Check', async () => {
    const root = await mountRows([{ subject: 'linear', usedByRuntimes: 2 }]);
    expect(status(root, 'linear')).toBe('ready');
    expect(root.querySelector('[data-mcp-row="linear"] [data-mcp-status]')).not.toBeNull();
    expect(root.querySelector('[data-mcp-check="linear"]')).not.toBeNull();
    // The row sits under a row that already names the server, so it does not name it again.
    expect(root.querySelector('[data-mcp-scope-chip]')).toBeNull();
  });

  it('reads the machine ONCE for every row on the page, not once per row', async () => {
    const calls: Call[] = [];
    const root = await mountRows(
      [
        { subject: 'linear', usedByRuntimes: 1 },
        { subject: 'ghost', usedByRuntimes: 0 },
        { subject: 'other', usedByRuntimes: 3 },
      ],
      {},
      calls,
    );
    expect(calls.filter(call => call.route === 'GET /v1/mcp')).toHaveLength(1);
    expect([status(root, 'linear'), status(root, 'ghost'), status(root, 'other')]).toEqual([
      'ready',
      'unused',
      'unused',
    ]);
  });

  it('reads only the machine’s Ferretry component of that name, not a user or project server called the same', async () => {
    const root = await mountRows([{ subject: 'github', usedByRuntimes: 1 }]);
    // `github` is a user-scope server in the inventory: it is not the component, so the component has nothing to check.
    expect(status(root, 'github')).toBe('unused');
  });

  it('says so when no runtime’s profile uses the component, and when its runtimes have not launched since', async () => {
    const root = await mountRows([
      { subject: 'ghost', usedByRuntimes: 0 },
      { subject: 'other', usedByRuntimes: 2 },
    ]);
    expect(text(root, '[data-row="ghost"] [data-component-mcp-status]')).toBe(NO_RUNTIME);
    expect(text(root, '[data-row="other"] [data-component-mcp-status]')).toBe(NOT_YET);
    expect(unusedWords(0)).toBe(NO_RUNTIME);
    expect(unusedWords(1)).toBe(NOT_YET);
  });

  it('says it is reading while the machine has not answered', async () => {
    const client = scriptedClient({ 'GET /v1/mcp': () => new Promise(() => undefined) });
    const Panel = createComponentStatusPanel(client as never) as unknown as FC<Record<string, unknown>>;
    mounted = await mountSettled(<Panel subject="linear" usedByRuntimes={1} />);
    expect(text(mounted.container, '[data-loading="background"]')).toBe('Reading where linear stands…');
  });

  it('says a failed read in plain words and reads again, once for every row, on Try again', async () => {
    let fail = true;
    const calls: Call[] = [];
    const root = await mountRows(
      [
        { subject: 'linear', usedByRuntimes: 1 },
        { subject: 'ghost', usedByRuntimes: 0 },
      ],
      {
        'GET /v1/mcp': () => {
          if (fail) throw new Error('the machine is offline');
          return MCP;
        },
      },
      calls,
    );
    expect(status(root, 'linear')).toBe('failed');
    expect(status(root, 'ghost')).toBe('failed');
    expect(text(root, '[data-row="linear"] [data-mcp-failure="status"]')).toContain('This machine isn’t reachable');
    expect(calls).toHaveLength(1);
    fail = false;
    await click(root, '[data-row="linear"] [data-component-mcp-retry]');
    expect(calls).toHaveLength(2);
    expect([status(root, 'linear'), status(root, 'ghost')]).toEqual(['ready', 'unused']);
  });

  it('checks the server as the machine does, and shows what the check found', async () => {
    const calls: Call[] = [];
    const root = await mountRows(
      [{ subject: 'linear', usedByRuntimes: 1 }],
      {
        [CHECK]: {
          id: 'id-linear-component',
          name: 'linear',
          transport: 'http',
          outcome: 'connected',
          toolCount: 2,
          tools: ['issues', 'projects'],
          elapsedMs: 4,
          checkedAt: new Date(NOW).toISOString(),
        },
      },
      calls,
    );
    await click(root, '[data-mcp-check="linear"]');
    expect(calls.at(-1)?.body).toEqual({ id: 'id-linear-component' });
    expect(text(root, '[data-mcp-status]')).toBe('Connected · 2 tools');
  });

  it('offers Sign in on a server that needs one', async () => {
    const needing = mcpServer({ name: 'asana', signIn: { subject: 'asana', required: true } });
    const root = await mountRows([{ subject: 'asana', usedByRuntimes: 1 }], {
      'GET /v1/mcp': { ...MCP, servers: [needing] },
    });
    expect(root.querySelector('[data-mcp-sign-in="asana"]')).not.toBeNull();
  });

  it('draws nothing for what the page handed it that is not the slot’s', async () => {
    const root = await mountRows([{ usedByRuntimes: 1 }]);
    expect(root.querySelector('[data-component-mcp-status]')).toBeNull();
    const bad = await (async () => {
      await mounted?.unmount();
      return mountRows([{ subject: 'linear', usedByRuntimes: 'many' }]);
    })();
    expect(bad.querySelector('[data-component-mcp-status]')).toBeNull();
  });

  it('is the panel the app half builds for `runtimes.component-mcp`', () => {
    const client = scriptedClient({});
    expect(typeof createSurfaces(client as never).panels['component-status']).toBe('function');
  });
});
