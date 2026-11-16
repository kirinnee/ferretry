import { describe, expect, it } from 'bun:test';
import {
  ADD_RUNTIME_LOGIN_SLOT,
  ADD_RUNTIME_SIGN_IN_SLOT,
  ADD_RUNTIME_SLOTS,
  COMPONENT_MCP_SLOT,
  isAddRuntimeLoginSlotProps,
  isComponentMcpSlotProps,
  isAddRuntimeSignInSlotProps,
  RUNTIMES_SLOTS,
} from '../../contract/index.ts';

describe('the slots Runtimes offers on its Add runtime page', () => {
  it('are named in `<plugin>.<name>` form and listed', () => {
    expect(ADD_RUNTIME_LOGIN_SLOT).toBe('runtimes.add-runtime-login');
    expect(ADD_RUNTIME_SIGN_IN_SLOT).toBe('runtimes.add-runtime-sign-in');
    expect([...ADD_RUNTIME_SLOTS]).toEqual([ADD_RUNTIME_LOGIN_SLOT, ADD_RUNTIME_SIGN_IN_SLOT]);
    expect([...RUNTIMES_SLOTS]).toEqual([ADD_RUNTIME_LOGIN_SLOT, ADD_RUNTIME_SIGN_IN_SLOT, COMPONENT_MCP_SLOT]);
  });

  it('the MCP component slot is named `runtimes.component-mcp` and takes a count of the runtimes that use the server', () => {
    expect(COMPONENT_MCP_SLOT).toBe('runtimes.component-mcp');
    expect(isComponentMcpSlotProps({ usedByRuntimes: 0 })).toBe(true);
    expect(isComponentMcpSlotProps({ usedByRuntimes: 3 })).toBe(true);
    expect(isComponentMcpSlotProps({ usedByRuntimes: -1 })).toBe(false);
    expect(isComponentMcpSlotProps({ usedByRuntimes: 1.5 })).toBe(false);
    expect(isComponentMcpSlotProps({ usedByRuntimes: '2' })).toBe(false);
    expect(isComponentMcpSlotProps({})).toBe(false);
    expect(isComponentMcpSlotProps(null)).toBe(false);
    expect(isComponentMcpSlotProps(2)).toBe(false);
  });

  it('the add-login panel accepts the callback the page hands it and refuses anything short of it', () => {
    expect(isAddRuntimeLoginSlotProps({ onAdded: () => undefined })).toBe(true);
    expect(isAddRuntimeLoginSlotProps({ onAdded: 'claude-new' })).toBe(false);
    expect(isAddRuntimeLoginSlotProps({})).toBe(false);
    expect(isAddRuntimeLoginSlotProps(null)).toBe(false);
    expect(isAddRuntimeLoginSlotProps('onAdded')).toBe(false);
  });

  it('the sign-in panel accepts a harness it signs in and the callback, and refuses anything short of them', () => {
    const props = { harness: 'claude-code', onSignedIn: () => undefined };
    expect(isAddRuntimeSignInSlotProps(props)).toBe(true);
    expect(isAddRuntimeSignInSlotProps({ ...props, harness: 'codex' })).toBe(true);
    expect(isAddRuntimeSignInSlotProps({ ...props, harness: 'other' })).toBe(false);
    expect(isAddRuntimeSignInSlotProps({ harness: 'codex' })).toBe(false);
    expect(isAddRuntimeSignInSlotProps({ ...props, onSignedIn: 1 })).toBe(false);
    expect(isAddRuntimeSignInSlotProps(null)).toBe(false);
  });
});
