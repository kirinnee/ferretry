/** mcp#1 — the Actions ▾ row "Add MCP server…", offered through Ferrets' `ferrets.actions-row` slot, and the panel's Add… link. */
import type { FC } from 'react';
import { afterEach, describe, expect, it } from 'bun:test';
import type { ActionsRowOffer } from '@ferretry/core-ferrets/contract';
import { type Mounted, must } from '@ferretry/app/testing';
import { AddMcpDialog } from '../../../app/views/add-mcp-dialog.tsx';
import { createAddMcpRowPanel } from '../../../app/views/add-mcp-row.tsx';
import { McpServersPanel } from '../../../app/views/servers-panel.tsx';
import { MCP, NOW, scriptedClient } from './mcp-fixtures.ts';
import { click, mountSettled, settle } from './mcp-view-support.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});
const LISTING = 'GET /v1/ferrets/:ferretId/mcp';

const mountRow = async (props: Record<string, unknown>) => {
  const offers: (readonly [string, ActionsRowOffer | null])[] = [];
  const client = scriptedClient({ [LISTING]: { project: null } });
  const Panel = createAddMcpRowPanel(client as never) as unknown as FC<Record<string, unknown>>;
  const slotProps = {
    ferret: 'f1',
    name: 'Marin',
    canControl: true,
    offer: (id: string, row: ActionsRowOffer | null) => offers.push([id, row]),
    ...props,
  };
  mounted = await mountSettled(<Panel {...slotProps} />);
  return { offers, root: mounted.container };
};

describe('mcp#1 Actions › Add MCP server… row', () => {
  it('offers its one row to a caller who may control the ferret, and opens the form from run', async () => {
    const { offers } = await mountRow({});
    const row = must(offers[0]?.[1], 'the row');
    expect(row).toMatchObject({ id: 'add-mcp', label: 'Add MCP server…', group: 'ferret', kind: 'run' });
    await settle();
    expect(document.body.querySelector('[data-add-mcp-dialog]')).toBeNull();
    await (async () => {
      const { interact } = await import('@ferretry/app/testing');
      await interact(async () => {
        await row.run();
      });
    })();
    expect(document.body.querySelector('[data-add-mcp-dialog]')).not.toBeNull();
    await click(document.body, '[data-add-mcp-dialog] header button');
    expect(document.body.querySelector('[data-add-mcp-dialog]')).toBeNull();
  });

  it('withdraws the row for a caller who may not control the ferret', async () => {
    const { offers } = await mountRow({ canControl: false });
    expect(offers).toEqual([['add-mcp', null]]);
  });

  it('draws nothing for props that are not the slot’s', async () => {
    const client = scriptedClient({});
    const Panel = createAddMcpRowPanel(client as never) as unknown as FC<Record<string, unknown>>;
    mounted = await mountSettled(<Panel />);
    expect(mounted.container.innerHTML).toBe('');
  });
});

describe('mcp#0 the panel’s Add… link', () => {
  it('opens the same form, and re-reads the servers when it closes', async () => {
    const calls: { route: string }[] = [];
    const client = scriptedClient(
      { 'GET /v1/ferrets/:ferretId/mcp/servers': MCP, [LISTING]: { project: null } },
      calls as never,
    );
    mounted = await mountSettled(
      <McpServersPanel client={client} ferretId="f1" now={() => NOW} searchDebounceMs={0} />,
    );
    const reads = () => calls.filter(call => call.route.endsWith('/mcp/servers')).length;
    expect(mounted.container.querySelector('[data-mcp-add] svg')).not.toBeNull();
    await click(mounted.container, '[data-mcp-add]');
    expect(document.body.querySelector('[data-add-mcp-dialog]')).not.toBeNull();
    const before = reads();
    await click(document.body, '[data-add-mcp-dialog] header button');
    expect(document.body.querySelector('[data-add-mcp-dialog]')).toBeNull();
    expect(reads()).toBe(before + 1);
  });
});

describe('mcp#0 the dialog names the login and the ferret from Ferrets’ own read', () => {
  const FERRET = 'GET /v1/ferrets/:ferretId';
  const RESTART = 'POST /v1/restarts';
  const ferret = { id: 'f1', name: 'Marin', runtime: 'marin', state: 'idle', harness: 'claude-code', folder: '/w' };
  const dialog = async (answers: Record<string, unknown>, name?: string) => {
    const client = scriptedClient({ [LISTING]: { project: null }, ...answers });
    mounted = await mountSettled(
      <AddMcpDialog
        client={client}
        ferretId="f1"
        onClose={() => undefined}
        {...(name === undefined ? {} : { name })}
      />,
    );
    return mounted.container;
  };

  it('mcp#0 the login card names the ferret’s runtime, and the words use the ferret’s own name', async () => {
    const root = await dialog({ [FERRET]: ferret });
    expect(root.querySelector('[data-choice="login"]')?.textContent).toContain('Every ferret on marin.');
  });

  it('mcp#0 a name the surface already has wins, and a refused read leaves the words general', async () => {
    const named = await dialog({ [FERRET]: ferret }, 'Given');
    expect(named.querySelector('[data-choice="login"]')?.textContent).toContain('marin');
    await mounted?.unmount();
    mounted = undefined;
    const refused = await dialog({ [FERRET]: new Error('down') });
    expect(refused.querySelector('[data-choice="login"]')?.textContent).toContain('this login');
  });

  it('mcp#1 on the panel path a reload nobody reported names the ferret in lower case mid-sentence', async () => {
    const root = await dialog({
      [FERRET]: new Error('down'),
      'POST /v1/ferrets/:ferretId/mcp/login/preview': {
        scope: 'login',
        runtime: 'marin',
        profile: 'default',
        replaces: false,
        ferrets: 1,
      },
      'POST /v1/ferrets/:ferretId/mcp/login': { scope: 'login', name: 'sentry', runtime: 'marin', profile: 'default' },
      [RESTART]: { restarted: [], queued: [], skipped: [], failed: [] },
    });
    await click(root, '[data-choice="login"] input');
    await (await import('./mcp-view-support.tsx')).type(root, 'input[placeholder="sentry"]', 'sentry');
    await (await import('./mcp-view-support.tsx')).type(
      root,
      'input[placeholder="npx -y @sentry/mcp-server"]',
      'npx x',
    );
    await new Promise(resolve => setTimeout(resolve, 400));
    await settle();
    await click(root, '[data-action-submit]');
    await click(root, '[data-add-mcp-reload]');
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('whether this ferret reloaded');
  });
});
