import { describe, expect, test } from 'bun:test';
import { isSlotName } from '@ferretry/app';
import { panelsInSlot } from '@ferretry/app/testing';
import { ACTIONS_ROW_SLOT } from '@ferretry/core-ferrets/contract';
import { COMPONENT_MCP_SLOT } from '@ferretry/plugin-runtimes/contract';

describe('the slots MCP fills', () => {
  test('MCP puts its Add MCP server row in the Actions ▾ menu, through the name Ferrets owns', () => {
    expect(panelsInSlot(ACTIONS_ROW_SLOT)).toContain('mcp.add-mcp-row');
  });

  test('MCP puts its one status panel under each MCP row of Runtimes’ Profiles library, through the name Runtimes owns', () => {
    expect(isSlotName(COMPONENT_MCP_SLOT)).toBe(true);
    expect(COMPONENT_MCP_SLOT.startsWith('runtimes.')).toBe(true);
    expect(panelsInSlot(COMPONENT_MCP_SLOT)).toEqual(['mcp.component-status']);
  });
});
