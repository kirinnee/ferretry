import { describe, expect, it } from 'bun:test';

import { LineageSurfaceContent } from '../../../src/features/lineage/lineage-surface.tsx';
import { daemonId } from '../../../src/lib/daemon-connection.ts';
import { render, run } from '../../support/react.ts';
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
});
