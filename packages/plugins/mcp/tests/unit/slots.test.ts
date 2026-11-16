import { describe, expect, it } from 'bun:test';
import {
  isMcpInstallSlotProps,
  isMcpRowSlotProps,
  MCP_INSTALL_SLOT,
  MCP_ROW_SLOT,
  MCP_SLOTS,
} from '../../contract/index.ts';

describe('the slots MCP offers', () => {
  it('are named in `<plugin>.<name>` form and listed', () => {
    expect(MCP_ROW_SLOT).toBe('mcp.row');
    expect(MCP_INSTALL_SLOT).toBe('mcp.install');
    expect([...MCP_SLOTS]).toEqual([MCP_ROW_SLOT, MCP_INSTALL_SLOT]);
  });

  it('a row panel accepts the one server the row hands it and refuses anything short of it', () => {
    const props = { ferret: 'f1', id: 'id-notion-project', name: 'notion', scope: 'project' };
    expect(isMcpRowSlotProps(props)).toBe(true);
    for (const key of Object.keys(props)) expect(isMcpRowSlotProps({ ...props, [key]: 3 })).toBe(false);
    expect(isMcpRowSlotProps({ ferret: 'f1' })).toBe(false);
    expect(isMcpRowSlotProps(null)).toBe(false);
  });

  it('the header panel accepts the ferret and refuses anything else', () => {
    expect(isMcpInstallSlotProps({ ferret: 'f1' })).toBe(true);
    expect(isMcpInstallSlotProps({ ferret: 3 })).toBe(false);
    expect(isMcpInstallSlotProps({})).toBe(false);
    expect(isMcpInstallSlotProps(null)).toBe(false);
  });
});
