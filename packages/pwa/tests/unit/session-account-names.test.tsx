import '../support/dom.ts';

import { describe, expect, it } from 'bun:test';
import type { FleetManifestSummary } from '@ferretry/protocol';
import type { ReactTestInstance } from 'react-test-renderer';
import { SessionCard, SessionRow } from '../../src/components/session-dashboard-rows.tsx';
import { RosterSessionHeader, SessionHeader } from '../../src/components/session-header.tsx';
import { SessionList } from '../../src/components/session-list.tsx';
import type { AccountPickerHealthCatalog } from '../../src/lib/account-picker-catalog.ts';
import { DaemonAccountPickerStore } from '../../src/lib/account-picker-store.ts';
import { daemonConnection, daemonId } from '../../src/lib/daemon-connection.ts';
import { mount } from '../support/dom.ts';
import { render } from '../support/react.ts';
import { type SessionFixtureOverrides, sessionView } from '../support/sessions.ts';

/**
 * A session names the ACCOUNT it runs on by the name its fleet gave it, never
 * by the wrapper id — on the live sessions dashboard, in the session header and
 * in the older list — and falls back to the id only for an account the roster
 * no longer holds.
 */

type Account = FleetManifestSummary['accounts'][number];

const account = (wrapper: string, displayName: string): Account => ({
  id: `${wrapper}-id`,
  kind: 'claude',
  mode: 'auto',
  wrapper,
  home: `/accounts/${wrapper}`,
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

describe('the session header names the callsign, then the account', () => {
  const eyebrow = (node: ReactTestInstance): string => text(node.findByProps({ className: 'fy-eyebrow' }));

  it('leads with the person-readable callsign and follows it with the fleet name', () => {
    const header = render(
      <SessionHeader accounts={ROSTER} daemonId="d" session={onRoster('claude-auto-default')} />,
    ).root;
    expect(eyebrow(header)).toBe('Ada · Claude (default, auto)');
    expect(header.findByProps({ className: 'fy-eyebrow' }).props.title).toBe('claude-auto-default');
  });

  it('shows the account alone without a callsign, and the id only for an account the roster lacks', () => {
    const bare = render(
      <SessionHeader
        accounts={ROSTER}
        daemonId="d"
        session={onRoster('claude-auto-default', { teammate: undefined })}
      />,
    ).root;
    expect(eyebrow(bare)).toBe('Claude (default, auto)');
    const removed = render(<SessionHeader accounts={ROSTER} daemonId="d" session={onRoster('claude-gone')} />).root;
    expect(eyebrow(removed)).toBe('Ada · claude-gone');
  });

  it('keeps the old callsign-or-wrapper line while the roster is unread', () => {
    const named = render(<SessionHeader daemonId="d" session={onRoster('claude-auto-default')} />).root;
    expect(eyebrow(named)).toBe('Ada');
    const unnamed = render(
      <SessionHeader daemonId="d" session={onRoster('claude-auto-default', { teammate: undefined })} />,
    ).root;
    expect(eyebrow(unnamed)).toBe('claude-auto-default');
  });

  it('reads the roster through the shared picker store when given one', async () => {
    const noHealth: AccountPickerHealthCatalog = { health: new Map(), error: null };
    const store = new DaemonAccountPickerStore({
      catalog: async () => ({ accounts: ROSTER }),
      health: async () => noHealth,
      checkHealth: async () => noHealth,
    });
    const connection = daemonConnection({
      daemonId: 'names-daemon',
      baseUrl: 'https://names.example.test',
      deviceToken: 'token-names',
    });
    const mounted = await mount(
      <RosterSessionHeader
        accountPicker={store}
        connection={connection}
        daemonId={connection.daemonId}
        session={onRoster('claude-auto-default')}
      />,
    );
    expect(mounted.container.querySelector('.fy-eyebrow')?.textContent).toBe('Ada · Claude (default, auto)');
    await mounted.unmount();
  });
});

describe('the older session list names the account too', () => {
  const meta = (node: ReactTestInstance): string => text(node.findByProps({ className: 'fy-session-meta' }));
  const list = (session: ReturnType<typeof onRoster>, accounts?: readonly Account[]) =>
    render(
      <SessionList
        daemonId="d"
        now={NOW}
        onOpenSession={() => {}}
        sessions={[session]}
        {...(accounts === undefined ? {} : { accounts })}
      />,
    ).root;

  it('shows the fleet name and the model, or the name alone without one', () => {
    expect(meta(list(onRoster('claude-auto-default'), ROSTER))).toBe('Claude (default, auto) · opus');
    expect(meta(list(onRoster('claude-auto-default', { model: undefined }), ROSTER))).toBe('Claude (default, auto)');
  });

  it('keeps the model-or-wrapper line while the roster is unread', () => {
    expect(meta(list(onRoster('claude-auto-default')))).toBe('opus');
    expect(meta(list(onRoster('claude-auto-default', { model: undefined })))).toBe('claude-auto-default');
  });
});
