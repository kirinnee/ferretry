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
    expect(tree).toContain('Found locally. Sign-in and provider access have not been verified.');
    expect(tree).toContain('an unavailable account is declared');
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
