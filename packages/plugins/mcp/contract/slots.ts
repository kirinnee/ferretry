/**
 * THE SLOTS MCP OFFERS (§5.2: plugin panels offer their own, named `<plugin>.<name>`).
 *
 * The MCP tab of a ferret's context lists every server the ferret sees. Where a server came from beyond this machine, and
 * what can be done with it besides Check and Sign in, is not MCP's to know, so the panel OFFERS two slots and mounts
 * whatever an installed plugin contributes: Catalogs draws "from Ines · v2", Share / add to a catalog and Uninstall on each
 * row, and "Install from a file…" in the header. Neither half imports the other's views — the slot names and the props
 * below are the whole agreement, so a daemon without Catalogs shows the tab with no extra controls.
 *
 * The props are plain data (no framework type: this is a contract). A contributing panel reads them from its props.
 */

/** On each server's row in the MCP tab, at the end of the status line (after Check and Sign in). */
export const MCP_ROW_SLOT = 'mcp.row' as const;

/** In the MCP tab's header, beside "Add…": the ways in that bring a server from somewhere else (a catalog file). */
export const MCP_INSTALL_SLOT = 'mcp.install' as const;

/** Every slot MCP's panel offers, in one list a test can pair against the panels other plugins contribute. */
export const MCP_SLOTS = [MCP_ROW_SLOT, MCP_INSTALL_SLOT] as const;
export type McpSlot = (typeof MCP_SLOTS)[number];

/** What the row slot hands its panels, besides the shell's `subject` (the ferret): the one server the row draws. */
export interface McpRowSlotProps {
  /** The ferret whose MCP tab this is. */
  readonly ferret: string;
  /** The server's id in the inventory: what Publish points at (`{ kind: 'mcp', mcp: id }`). */
  readonly id: string;
  /** The server's name, which a catalog install is matched by. */
  readonly name: string;
  /** Where it comes from ('project', 'local', 'user', 'ferretry', 'component'). */
  readonly scope: string;
}

/** What the header slot hands its panels, besides the shell's `subject` (the ferret). */
export interface McpInstallSlotProps {
  /** The ferret whose MCP tab this is. */
  readonly ferret: string;
}

/** A narrowing for the row slot's panels: the props are untyped at the shell, so the panel checks what it reads. */
export function isMcpRowSlotProps(props: unknown): props is McpRowSlotProps {
  if (typeof props !== 'object' || props === null) return false;
  const candidate = props as Record<string, unknown>;
  return (
    typeof candidate.ferret === 'string' &&
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.scope === 'string'
  );
}

/** A narrowing for the header slot's panels, as {@link isMcpRowSlotProps} is for the row's. */
export function isMcpInstallSlotProps(props: unknown): props is McpInstallSlotProps {
  if (typeof props !== 'object' || props === null) return false;
  return typeof (props as Record<string, unknown>).ferret === 'string';
}
