import { describe, expect, it } from 'bun:test';

import { FleetSurface } from '../../../../src/features/fleet/fleet-surface.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { render, run } from '../../../support/react.ts';

const daemon = daemonConnection({
  daemonId: 'fleet-daemon',
  baseUrl: 'https://fleet.example.test',
  deviceToken: 'test-token',
});

describe('FleetSurface', () => {
  it('keeps unavailable evidence distinct from an empty fleet', () => {
    const view = render(
      <FleetSurface
        daemonId={daemon.daemonId}
        state={{ kind: 'unavailable', reason: 'The daemon has not published inventory.' }}
      />,
    );

    expect(view.root.findByProps({ 'data-fleet-surface': 'unavailable' }).props['data-fleet-daemon-id']).toBe(
      'fleet-daemon',
    );
    expect(view.root.findByProps({ id: 'fleet-heading' }).children.join('')).toBe('Fleet inventory is unavailable');
    expect(view.root.findAll(node => node.props['data-fleet-harness'] !== undefined)).toHaveLength(0);
    run(() => view.unmount());
  });

  it('shows both detected harnesses but gives the default to Claude', () => {
    const view = render(
      <FleetSurface
        daemonId={daemon.daemonId}
        state={{
          kind: 'available',
          harnesses: [
            { kind: 'claude', launchable: ['claude-auto-studio'], blocked: [] },
            { kind: 'codex', launchable: ['codex-auto-studio'], blocked: ['an unavailable account is declared'] },
          ],
          accounts: [
            {
              id: 'claude-studio',
              wrapper: 'claude-auto-studio',
              harness: 'claude',
              label: 'Studio Claude',
              available: true,
            },
            {
              id: 'codex-studio',
              wrapper: 'codex-auto-studio',
              harness: 'codex',
              label: 'Studio Codex',
              available: true,
            },
          ],
        }}
      />,
    );

    expect(view.root.findByProps({ 'data-fleet-surface': 'available' }).props['data-fleet-daemon-id']).toBe(
      'fleet-daemon',
    );
    expect(
      view.root
        .findAll(node => node.props['data-fleet-harness'] !== undefined)
        .map(node => node.props['data-fleet-harness']),
    ).toEqual(['claude', 'codex']);
    const tree = JSON.stringify(view.toJSON());
    expect(tree).toContain('Claude is the default when a harness is not specified.');
    // This line used to end "Sign-in and provider access have not been verified", which was true and
    // no longer is: each account now reports what the provider last said about its credential. The
    // sentence points at the rows instead of disclaiming everything.
    expect(tree).toContain('Found locally. Each account below reports its own sign-in separately.');
    expect(tree).toContain('an unavailable account is declared');
    run(() => view.unmount());
  });

  /**
   * PER-ACCOUNT HEALTH, and the three absences that must never merge.
   *
   * `Published` is what the MANIFEST declares. Health is what the PROVIDER last said. An account can
   * be published and signed out, so the two facts sit side by side rather than one standing in for
   * the other.
   */
  it('shows each account’s verdict and when it was established, beside its published state', () => {
    // Arrange
    const now = Date.parse('2026-08-24T12:00:00.000Z');
    const view = render(
      <FleetSurface
        daemonId={daemon.daemonId}
        now={now}
        state={{
          kind: 'available',
          harnesses: [{ kind: 'claude', launchable: ['claude-auto-studio'], blocked: [] }],
          accounts: [
            {
              id: 'healthy-account',
              wrapper: 'claude-auto-studio',
              harness: 'claude',
              label: 'Studio Claude',
              available: true,
              health: {
                accountId: 'healthy-account',
                kind: 'claude',
                verdict: 'healthy',
                reason: 'provider_accepted',
                evidence: 'anthropic_usage',
                lastCheckedAt: now - 240_000,
                verdictAt: now - 240_000,
                lastCheckInconclusive: false,
              },
            },
            {
              id: 'rejected-account',
              wrapper: 'claude-auto-atelier',
              harness: 'claude',
              label: 'Atelier Claude',
              available: true,
              health: {
                accountId: 'rejected-account',
                kind: 'claude',
                verdict: 'needs_relogin',
                reason: 'oauth_token_rejected',
                evidence: 'anthropic_usage',
                lastCheckedAt: now - 120_000,
                verdictAt: now - 120_000,
                lastCheckInconclusive: false,
              },
            },
            // NO health row at all: nobody has ever checked it. Absent is not unhealthy, and it is not
            // the same as a row that SAYS unknown — that one has its own reason.
            {
              id: 'unread-account',
              wrapper: 'claude-auto-archive',
              harness: 'claude',
              label: 'Archive Claude',
              available: true,
            },
          ],
        }}
      />,
    );

    // Assert
    const tree = JSON.stringify(view.toJSON());
    expect(tree).toContain('Healthy');
    expect(tree).toContain('Checked 4m ago');
    expect(tree).toContain('Needs re-login');
    expect(tree).toContain('Checked 2m ago');
    expect(tree).toContain('Never checked');
    // The exact UTC instant travels in the machine-readable attribute, so the relative label can tick
    // in the client without anything claiming a fresh check happened.
    expect(tree).toContain(new Date(now - 240_000).toISOString());
    // Tone is on the DOM so a review can see the three readings are visibly different.
    expect(
      view.root
        .findAll(node => node.props['data-fleet-health'] !== undefined)
        .map(node => node.props['data-fleet-health']),
    ).toEqual(['ok', 'bad', 'muted']);
    run(() => view.unmount());
  });

  it('calls a 403 healthy and never offers a login for a static credential', () => {
    // Arrange
    const now = Date.parse('2026-08-24T12:00:00.000Z');
    const row = (id: string, verdict: 'healthy' | 'needs_credentials', reason: string) => ({
      id,
      wrapper: `claude-auto-${id}`,
      harness: 'claude' as const,
      label: id,
      available: true,
      health: {
        accountId: id,
        kind: 'claude',
        verdict,
        reason,
        evidence: 'anthropic_usage',
        lastCheckedAt: now,
        verdictAt: now,
        lastCheckInconclusive: false,
      } as never,
    });
    const view = render(
      <FleetSurface
        daemonId={daemon.daemonId}
        now={now}
        state={{
          kind: 'available',
          harnesses: [{ kind: 'claude', launchable: ['claude-auto-studio'], blocked: [] }],
          accounts: [
            row('scoped', 'healthy', 'usage_scope_unavailable'),
            row('static', 'needs_credentials', 'static_credential_rejected'),
          ],
        }}
      />,
    );

    // Assert — a 403 is accepted-and-unmeasurable, and an account authenticated from an environment
    // variable cannot be fixed by signing in, so it must not be told to.
    const tree = JSON.stringify(view.toJSON());
    expect(tree).toContain('quota is not measurable');
    expect(tree).toContain('Needs credential');
    expect(tree).not.toContain('Needs re-login');
    run(() => view.unmount());
  });

  it('renders a positively reported but accountless harness as empty, not as unavailable evidence', () => {
    const view = render(
      <FleetSurface
        daemonId={daemon.daemonId}
        state={{
          kind: 'available',
          harnesses: [
            { kind: 'claude', launchable: ['claude-auto-studio'], blocked: [] },
            { kind: 'codex', launchable: [], blocked: [] },
          ],
          accounts: [],
        }}
      />,
    );

    const copy = view.root.findAllByType('p').map(node => node.children.join(''));
    expect(copy).toContain('No Claude account is published for this daemon.');
    expect(copy).toContain('No Codex account is published for this daemon.');
    run(() => view.unmount());
  });
});
