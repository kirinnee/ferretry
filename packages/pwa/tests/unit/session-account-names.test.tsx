import '../support/dom.ts';

import { describe, expect, it } from 'bun:test';
import type { ReactTestInstance } from 'react-test-renderer';
import { SessionCard, SessionRow } from '../../src/components/session-dashboard-rows.tsx';
import type { PickerAccount } from '../../src/lib/account-picker-catalog.ts';
import { daemonId } from '../../src/lib/daemon-connection.ts';
import { render } from '../support/react.ts';
import { type SessionFixtureOverrides, sessionView } from '../support/sessions.ts';

/**
 * A session names the ACCOUNT it runs on by the name its fleet gave it, never
 * by the wrapper id — and falls back to the id only for an account the roster no longer holds.
 */

type Account = PickerAccount;

const account = (wrapper: string, displayName: string): Account => ({
  id: `${wrapper}-id`,
  kind: 'claude',
  agent: true,
  credentialId: `login-${wrapper}`,
  wrapper,
  displayName,
  defaultModel: 'opus',
  models: [{ id: 'opus', available: true }],
  available: true,
  unavailableReason: null,
});

const ROSTER: readonly Account[] = [account('claude-auto-default', 'Claude (default, auto)')];
const DAEMON = daemonId('names-daemon');
const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const text = (node: ReactTestInstance): string =>
  node.children
    .map(child => (typeof child === 'string' || typeof child === 'number' ? String(child) : text(child)))
    .join('');

const onRoster = (agent: string, config: SessionFixtureOverrides['config'] = {}) =>
  sessionView('s-1', { config: { agent, teammate: 'ada', model: 'opus', ...config } });

describe('the live dashboard names a session’s account', () => {
  it('shows the fleet name on the phone card and the desktop row, with the wrapper id kept in the title', () => {
    const card = render(
      <SessionCard accounts={ROSTER} daemonId={DAEMON} now={NOW} usage={null} view={onRoster('claude-auto-default')} />,
    ).root;
    const cardName = card.findByProps({ 'data-account': 'claude-auto-default' });
    expect(text(cardName)).toBe('Claude (default, auto)');
    expect(cardName.props.title).toBe('claude-auto-default');
    expect(text(card)).toContain('Claude (default, auto)·opus');

    const row = render(
      <table>
        <tbody>
          <SessionRow
            accounts={ROSTER}
            daemonId={DAEMON}
            now={NOW}
            usage={null}
            view={onRoster('claude-auto-default')}
          />
        </tbody>
      </table>,
    ).root;
    expect(text(row.findByProps({ 'data-account': 'claude-auto-default' }))).toBe('Claude (default, auto)');
  });

  it('names a removed account by its id, and names no account while the roster is unread', () => {
    const removed = render(
      <SessionCard accounts={ROSTER} daemonId={DAEMON} now={NOW} usage={null} view={onRoster('claude-gone')} />,
    ).root;
    expect(text(removed.findByProps({ 'data-account': 'claude-gone' }))).toBe('claude-gone');

    const unread = render(
      <SessionCard daemonId={DAEMON} now={NOW} usage={null} view={onRoster('claude-auto-default')} />,
    ).root;
    expect(unread.findAllByProps({ 'data-account': 'claude-auto-default' })).toHaveLength(0);
    expect(text(unread)).not.toContain('claude-auto-default');
  });
});
