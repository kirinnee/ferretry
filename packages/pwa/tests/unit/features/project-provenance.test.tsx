import { describe, expect, it } from 'bun:test';

import { ProjectProvenance } from '../../../src/features/projects/project-provenance.tsx';
import type { FleetProject } from '../../../src/lib/fleet-grouping.ts';
import { mount, must } from '../../support/dom.ts';

const project: FleetProject = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'ferretry',
  path: '/work/ferretry',
  source: 'clone',
  createdAt: '2026-08-01T10:00:00.000Z',
  git: { commonDirectory: '/work/ferretry/.git' },
};

const terms = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('dt')].map(node => node.textContent ?? '');

describe('ProjectProvenance', () => {
  it('joins source, path, arrival and Git identity on one rail', async () => {
    const mounted = await mount(<ProjectProvenance project={project} />);

    expect(terms(mounted.container)).toEqual(['Source', 'Path', 'Added', 'Git']);
    expect(mounted.container.textContent).toContain('cloned');
    expect(mounted.container.textContent).toContain('/work/ferretry/.git');
    // A date, not a timestamp: the registry records an instant and a reader
    // comparing two folders is comparing days.
    expect(mounted.container.textContent).toContain('2026-08-01');
    expect(mounted.container.textContent).not.toContain('10:00:00');
    await mounted.unmount();
  });

  it('marks the rail and its ticks decorative, leaving the <dl> as the read', async () => {
    const mounted = await mount(<ProjectProvenance project={project} />);

    const hidden = [...mounted.container.querySelectorAll('span[aria-hidden="true"]')];
    expect(hidden.length).toBeGreaterThan(0);
    expect(must(mounted.container.querySelector('dl'), 'the fact list').getAttribute('aria-hidden')).toBeNull();
    await mounted.unmount();
  });

  it('says a folder is not a Git repository rather than leaving the fact blank', async () => {
    const mounted = await mount(
      <ProjectProvenance project={{ name: 'notes', path: '/work/notes', source: 'new-folder' }} />,
    );

    expect(mounted.container.textContent).toContain('not a Git repository');
    expect(terms(mounted.container)).toEqual(['Source', 'Path', 'Git']);
    await mounted.unmount();
  });

  it('omits the source chip for a row that carries no source, rather than inventing one', async () => {
    const mounted = await mount(<ProjectProvenance project={{ name: 'bare', path: '/work/bare' }} />);

    expect(mounted.container.querySelector('[data-project-source]')).toBeNull();
    expect(terms(mounted.container)).toEqual(['Path', 'Git']);
    await mounted.unmount();
  });

  it('keeps a long path whole instead of truncating the tail that distinguishes it', async () => {
    const deep = '/home/pilot/.ferretry-worktrees/ferretry/feat-project-onboarding';
    const mounted = await mount(<ProjectProvenance project={{ name: 'feat', path: deep }} />);

    const value = must(mounted.container.querySelector('dd'), 'the path value');
    expect(value.textContent).toBe(deep);
    expect(value.className).toContain('break-all');
    expect(value.className).not.toContain('truncate');
    await mounted.unmount();
  });

  it('names the row by its path so a caller can find one project among many', async () => {
    const mounted = await mount(<ProjectProvenance project={project} />);

    expect(mounted.container.querySelector('[data-project-provenance="/work/ferretry"]')).not.toBeNull();
    await mounted.unmount();
  });
});
