import { describe, expect, test } from 'bun:test';
import { resolveSettingsTab } from '../../../src/shell/settings-tab.ts';

const runtimes = { plugin: 'runtimes', id: 'runtimes', label: 'Runtimes' };
const profiles = { plugin: 'runtimes', id: 'profiles', label: 'Profiles' };
const accounts = { plugin: 'accounts', id: 'accounts', label: 'Accounts' };
const secureCopy = { plugin: 'accounts', id: 'secure-copy', label: 'Secure copy' };
const mcp = { plugin: 'mcp', id: 'mcp', label: 'MCP servers' };
const tabs = [runtimes, profiles, accounts, secureCopy, mcp];

describe('which settings tab an address names', () => {
  test('no address part opens the first tab', () => {
    expect(resolveSettingsTab(tabs, undefined, undefined)).toEqual({ kind: 'tab', tab: runtimes });
  });
  test('a plugin id opens that plugin’s first tab', () => {
    expect(resolveSettingsTab(tabs, 'accounts', undefined)).toEqual({ kind: 'tab', tab: accounts });
  });
  test('a plugin and its own tab id open exactly that tab', () => {
    expect(resolveSettingsTab(tabs, 'accounts', 'secure-copy')).toEqual({ kind: 'tab', tab: secureCopy });
  });
  test('a bare tab id (settings/<tab>) opens that tab, whichever plugin owns it', () => {
    expect(resolveSettingsTab(tabs, 'profiles', undefined)).toEqual({ kind: 'tab', tab: profiles });
    expect(resolveSettingsTab(tabs, 'secure-copy', undefined)).toEqual({ kind: 'tab', tab: secureCopy });
  });
  test('a name no tab answers to is missing — it never silently shows the first tab', () => {
    expect(resolveSettingsTab(tabs, 'logins', undefined)).toEqual({ kind: 'missing', name: 'logins' });
    expect(resolveSettingsTab(tabs, 'accounts', 'nope')).toEqual({ kind: 'missing', name: 'accounts/nope' });
  });
  test('a daemon with no settings tabs has none to open', () => {
    expect(resolveSettingsTab([], undefined, undefined)).toEqual({ kind: 'none' });
    expect(resolveSettingsTab([], 'runtimes', undefined)).toEqual({ kind: 'none' });
  });
});
