import { describe, expect, it } from 'bun:test';

import { LineageSurface, LineageSurfaceContent } from '../../../src/features/lineage/lineage-surface.tsx';
import { daemonConnection, daemonId } from '../../../src/lib/daemon-connection.ts';
import { DaemonControlsStore } from '../../../src/lib/controls.ts';
import { DaemonFleetStore } from '../../../src/lib/fleet-store.ts';
import { render, run, runAsync } from '../../support/react.ts';
import { sessionView } from '../../support/sessions.ts';

const daemon = daemonId('daemon-a');

describe('LineageSurfaceContent', () => {
  it('renders the local family, keeps a filter path visible, and routes only inside its daemon', () => {
    const root = sessionView('root', { config: { teammate: 'rooter' }, state: { status: 'waiting' } });
    const current = sessionView('current', {
      config: { parent: 'root', teammate: 'current' },
      state: { status: 'running' },
    });
    const completedChild = sessionView('child', {
      config: { parent: 'current', teammate: 'child' },
      state: { status: 'completed' },
    });
    const navigated: string[] = [];
    const renderer = render(
      <LineageSurfaceContent
        daemonId={daemon}
        sessionId="current"
        sessions={[root, current, completedChild]}
        onNavigate={to => navigated.push(to)}
      />,
    );

    const rootLink = renderer.root.findAllByType('a').find(link => link.props['data-lineage-role'] === 'parent');
    const childLink = renderer.root.findAllByType('a').find(link => link.props['data-lineage-role'] === 'descendant');
    if (!rootLink || !childLink) throw new Error('lineage links missing');
    expect(rootLink.props.href).toBe('/d/daemon-a/session/root');
    run(() =>
      childLink.props.onClick({
        button: 0,
        preventDefault() {},
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
      }),
    );
    expect(navigated).toEqual(['/d/daemon-a/session/child']);

    const completed = renderer.root
      .findAllByType('button')
      .find(button => button.props['aria-label']?.startsWith('completed'));
    if (!completed) throw new Error('completed filter missing');
    run(() => completed.props.onClick());
    expect(renderer.root.findByProps({ 'data-lineage-role': 'parent' }).props['data-lineage-filter']).toBe('context');
    expect(renderer.root.findByProps({ 'data-lineage-role': 'current' }).props['data-lineage-filter']).toBe('context');
    expect(renderer.root.findByProps({ 'data-lineage-role': 'descendant' }).props['data-lineage-filter']).toBe('match');
    expect(JSON.stringify(renderer.toJSON())).toContain(
      'Path rows keep matching descendants attached to their ancestors.',
    );
  });

  it('shows an honest missing-parent marker and an explicit no-snapshot state', () => {
    const orphan = sessionView('current', { config: { parent: 'gone' } });
    const orphanView = render(<LineageSurfaceContent daemonId={daemon} sessionId="current" sessions={[orphan]} />);
    expect(orphanView.root.findByProps({ 'data-lineage-role': 'missing-parent' }).props.title).toContain(
      'no longer resolves',
    );

    const missing = render(<LineageSurfaceContent daemonId={daemon} sessionId="other" sessions={[orphan]} />);
    expect(JSON.stringify(missing.toJSON())).toContain('not in this daemon’s live fleet snapshot');
  });

  it('offers an explicit reset when no sessions match the selected status', () => {
    const current = sessionView('current', { state: { status: 'running' } });
    const completed = sessionView('completed', { config: { parent: 'current' }, state: { status: 'completed' } });
    const view = render(
      <LineageSurfaceContent daemonId={daemon} sessionId="current" sessions={[current, completed]} />,
    );
    const completedFilter = view.root
      .findAllByType('button')
      .find(button => button.props['aria-label']?.startsWith('completed'));
    if (!completedFilter) throw new Error('completed filter missing');

    run(() => completedFilter.props.onClick());
    run(() => view.update(<LineageSurfaceContent daemonId={daemon} sessionId="current" sessions={[current]} />));
    view.root.findByProps({ 'data-lineage-role': 'no-matches' });
    expect(JSON.stringify(view.toJSON())).toContain('No sessions currently match');
    const reset = view.root.findAllByType('button').find(button => button.children.join('') === 'Show all');
    if (!reset) throw new Error('reset filter missing');
    run(() => reset.props.onClick());
    expect(view.root.findAllByProps({ 'data-lineage-role': 'current' }).length).toBeGreaterThan(0);
  });

  it('reads the live adapter from only the named daemon slice', async () => {
    const connection = daemonConnection({
      daemonId: 'daemon-a',
      baseUrl: 'https://a.example.test',
      deviceToken: 'token-a',
    });
    const current = sessionView('current', { state: { status: 'running' } });
    const fleet = new DaemonFleetStore({ list: async () => [current], get: async () => current });
    const controls = new DaemonControlsStore(undefined);
    const view = render(<LineageSurface daemonId={daemon} sessionId="current" fleet={fleet} controls={controls} />);

    expect(JSON.stringify(view.toJSON())).toContain('Loading lineage…');
    await runAsync(async () => {
      await fleet.hydrate(connection);
    });
    expect(view.root.findByProps({ 'data-lineage-role': 'current' }).props.to).toBe('/d/daemon-a/session/current');
  });
});
