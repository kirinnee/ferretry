/**
 * The Profiles library offers `runtimes.component-mcp` under each MCP server's row: the panel MCP contributes draws where
 * the server stands. Here stand-in panels draw what the page hands them (the subject and the props the contract names).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { type PlacedPanel, WithSlotPanels } from '@ferretry/app/testing';
import { ProfilesTab } from '../../../../../../app/features/fleet/profiles/profiles-tab.tsx';
import { COMPONENT_MCP_SLOT, isComponentMcpSlotProps } from '../../../../../../contract/index.ts';
import { type Mounted } from '../../../../support/dom.ts';
import { stack } from '../components/catalog-fixture.ts';
import { click, mountSettled, scriptedMachine, TAB_PATH, tabProps } from '../components/view-support.tsx';

let mounted: Mounted | undefined;
beforeEach(() => window.history.replaceState(null, '', TAB_PATH));
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  window.history.replaceState(null, '', '/');
});

const PREVIEW = {
  harnesses: [stack('claude-code')],
  scope: { kind: 'scoped', scope: 'claude-code' },
  resolved: [],
} as const;

const PLACED: Record<string, readonly PlacedPanel[]> = {
  [COMPONENT_MCP_SLOT]: [
    {
      plugin: 'mcp',
      id: 'component-status',
      view: props => (
        <span data-fake-status={`${String(props['subject'])}:${String(props['usedByRuntimes'])}`}>
          {String(isComponentMcpSlotProps(props))}
        </span>
      ),
    },
  ],
};

/** The Default profile's page, with the panels placed in the slots (none: outside a shell). */
const open = async (
  slots: Record<string, readonly PlacedPanel[]> | undefined,
  blocked: Record<string, string> = {},
): Promise<ParentNode> => {
  const machine = scriptedMachine({ preview: PREVIEW as never });
  const tab = <ProfilesTab {...tabProps(machine)} />;
  mounted = await mountSettled(
    slots === undefined ? (
      tab
    ) : (
      <WithSlotPanels slots={slots} blocked={blocked}>
        {tab}
      </WithSlotPanels>
    ),
  );
  await click(mounted.container, '[data-profile-row="Default"]');
  return mounted.container;
};

const footers = (root: ParentNode): string[] =>
  [...root.querySelectorAll('[data-library-mcp-status]')].map(
    node => node.getAttribute('data-library-mcp-status') ?? '',
  );

describe('the Profiles library’s MCP rows', () => {
  it('draws the panel MCP places under each MCP server’s row, with its name and how many runtimes use it', async () => {
    const root = await open(PLACED);
    expect(footers(root)).toEqual(['github', 'notes']);
    const github = root.querySelector('[data-library-item="mcp/github"] [data-library-mcp-status]');
    expect(
      github?.querySelector(`[data-slot="${COMPONENT_MCP_SLOT}"] [data-fake-status="github:2"]`)?.textContent,
    ).toBe('true');
    expect(root.querySelector('[data-library-item="mcp/notes"] [data-fake-status="notes:0"]')?.textContent).toBe(
      'true',
    );
  });

  it('with MCP off on this daemon, draws no footer under any row and never mounts the panel (so no MCP read)', async () => {
    const drawn: string[] = [];
    const placed: Record<string, readonly PlacedPanel[]> = {
      [COMPONENT_MCP_SLOT]: [
        {
          plugin: 'mcp',
          id: 'component-status',
          view: props => {
            drawn.push(String(props['subject']));
            return <span data-fake-status="x" />;
          },
        },
      ],
    };
    const root = await open(placed, { mcp: 'MCP servers is off on this daemon.' });
    expect(root.querySelector('[data-library-item="mcp/github"]')).not.toBeNull();
    expect(footers(root)).toEqual([]);
    expect(root.querySelector(`[data-slot="${COMPONENT_MCP_SLOT}"]`)).toBeNull();
    expect(root.textContent).not.toContain('is off on this daemon');
    expect(drawn).toEqual([]);
  });

  it('with another plugin blocked and MCP usable, the footer is drawn as before', async () => {
    const root = await open(PLACED, { board: 'Board is off on this daemon.' });
    expect(footers(root)).toEqual(['github', 'notes']);
  });

  it('draws nothing under a row that is not an MCP server’s', async () => {
    const root = await open(PLACED);
    expect(root.querySelector('[data-library-item="skills/My skills"] [data-library-mcp-status]')).toBeNull();
    expect(root.querySelector('[data-library-item="profile/Review"] [data-library-mcp-status]')).toBeNull();
  });

  it('with no panel placed in the slot, the rows read as they did before it', async () => {
    const root = await open({ [COMPONENT_MCP_SLOT]: [] });
    expect(footers(root)).toEqual([]);
    expect(root.querySelector('[data-library-item="mcp/github"]')).not.toBeNull();
  });

  it('outside a shell there is nothing to draw, so no footer', async () => {
    const root = await open(undefined);
    expect(footers(root)).toEqual([]);
  });

  it('off a machine page there is no daemon to draw the slot for, so no footer', async () => {
    window.history.replaceState(null, '', '/');
    const root = await open(PLACED);
    expect(root.querySelector('[data-library-item="mcp/github"]')).not.toBeNull();
    expect(footers(root)).toEqual([]);
  });
});
