import { describe, expect, it } from 'bun:test';
import { mount, must } from '@ferretry/app/testing';
import { ProjectInfoSchema } from '../../../contract/index.ts';
import { ProjectCard, projectCardMeta } from '../../../app/views/project-card.tsx';

const project = (extra: Record<string, unknown> = {}) =>
  ProjectInfoSchema.parse({
    id: '00000000-0000-4000-8000-000000000001',
    name: 'site',
    path: '/work/site',
    source: 'existing-folder',
    createdAt: '2026-08-01T10:00:00.000Z',
    ...extra,
  });
const repo = (remote: string) => ({ path: '.', remote, provider: 'github' });

describe('projectCardMeta', () => {
  it('says the repository when one is known, else the folder name, never the full path', () => {
    expect(projectCardMeta(project({ repos: [repo('https://github.com/fake-org/site.git')] }), 0)).toBe(
      'fake-org/site',
    );
    expect(projectCardMeta(project(), 0)).toBe('site');
    expect(projectCardMeta(project({ path: '/work/site/' }), 0)).toBe('site');
  });

  it('counts the other repositories and the active ferrets', () => {
    const two = project({ repos: [repo('https://github.com/a/one'), repo('https://github.com/a/two')] });
    expect(projectCardMeta(two, 1)).toBe('a/one + 1 more · 1 ferret');
    expect(projectCardMeta(project(), 3)).toBe('site · 3 ferrets');
  });
});

describe('ProjectCard', () => {
  it('is a link to the project page with Open and a start that goes to New ferret with the folder', async () => {
    const went: string[] = [];
    const mounted = await mount(
      <ul>
        <ProjectCard
          activeFerrets={0}
          daemon="d1"
          href="/d/d1/projects/p1"
          onNavigate={to => went.push(to)}
          project={project()}
        />
      </ul>,
    );
    const links = [...mounted.container.querySelectorAll('a')].map(a => a.getAttribute('href'));
    expect(links).toEqual(['/d/d1/projects/p1', '/d/d1/projects/p1']);
    must(
      [...mounted.container.querySelectorAll('button')].find(button => button.textContent === 'Start a ferret here'),
      'the start button',
    ).click();
    expect(went).toEqual(['/d/d1/new?folder=%2Fwork%2Fsite']);
    await mounted.unmount();
  });

  it('draws plain text and no actions where there is nowhere to go (a harness frame)', async () => {
    const mounted = await mount(
      <ul>
        <ProjectCard activeFerrets={0} project={project()} />
      </ul>,
    );
    expect(mounted.container.querySelector('a')).toBeNull();
    expect(mounted.container.querySelector('button')).toBeNull();
    expect(must(mounted.container.querySelector('h3'), 'the title').textContent).toBe('site');
    await mounted.unmount();
  });
});
