import { describe, expect, test } from 'bun:test';
import { fakeProjects, projectsConformance } from '../../contract/testing/index.ts';
import {
  CloneRepoRequestSchema,
  cloneAddressHasCredentials,
  isProjectsConnectAccount,
  isProjectsInsights,
  PROJECTS_APP_HOOKS,
  PROJECTS_CONNECT_ACCOUNT_HOOK,
  PROJECTS_INSIGHTS_HOOK,
  ProjectCloneUrlSchema,
  ProjectPathMustBeAbsoluteMessage,
  ProjectsFileSchema,
  RegisterProjectRequestSchema,
} from '../../contract/index.ts';

projectsConformance('fakeProjects', () => fakeProjects());

describe('projects wire schemas', () => {
  test('a relative path is refused with the one message both programs share', () => {
    const parsed = RegisterProjectRequestSchema.safeParse({ kind: 'existing-folder', path: 'alpha' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toBe(ProjectPathMustBeAbsoluteMessage);
  });
  test('a clone address may use https, ssh or file only, and never a remote helper or an option host', () => {
    for (const bad of [
      'ext::sh -c id',
      'ssh::x',
      'https:/host/r',
      'https://-oProxy/r',
      'git://host/r',
      'file://host/r',
    ])
      expect(ProjectCloneUrlSchema.safeParse(bad).success).toBe(false);
    for (const good of ['https://host/r.git', 'ssh://git@host/r.git', 'file:///srv/r.git'])
      expect(ProjectCloneUrlSchema.safeParse(good).success).toBe(true);
  });
  test('R2: any parsed userinfo on an https address is refused, the username alone included; an ssh username is not', () => {
    for (const bad of [
      'https://tok@host.invalid/r.git',
      'https://user:@host.invalid/r.git',
      'https://:pw@host.invalid/r.git',
      'HTTPS://tok@host.invalid/r.git',
      'https:///tok@host.invalid/r.git',
      'https:////user:@host.invalid/r.git',
    ]) {
      expect(cloneAddressHasCredentials(bad)).toBe(true);
      expect(CloneRepoRequestSchema.safeParse({ url: bad }).success).toBe(false);
    }
    for (const good of ['https://host.invalid/r.git', 'ssh://git@host.invalid/r.git'])
      expect(CloneRepoRequestSchema.safeParse({ url: good }).success).toBe(true);
  });
  test('the stored file is format 1 and refuses an unknown field', () => {
    expect(ProjectsFileSchema.safeParse({ format: 1, projects: [] }).success).toBe(true);
    expect(ProjectsFileSchema.safeParse({ format: 2, projects: [] }).success).toBe(false);
    expect(ProjectsFileSchema.safeParse({ format: 1, projects: [], extra: true }).success).toBe(false);
  });
  test('the connect-account hook is read only from a value that has a panel to render', () => {
    expect(PROJECTS_APP_HOOKS[PROJECTS_CONNECT_ACCOUNT_HOOK]).toBe(isProjectsConnectAccount);
    expect(isProjectsConnectAccount({ panel: () => null })).toBe(true);
    for (const bad of [undefined, null, 'panel', {}, { panel: 1 }]) expect(isProjectsConnectAccount(bad)).toBe(false);
  });
  test('the insights hook is read only from a value with a title and a panel to render', () => {
    expect(PROJECTS_APP_HOOKS[PROJECTS_INSIGHTS_HOOK]).toBe(isProjectsInsights);
    expect(isProjectsInsights({ title: 'PRs & CI', panel: () => null })).toBe(true);
    for (const bad of [undefined, null, {}, { panel: () => null }, { title: 1, panel: () => null }, { title: 'x' }])
      expect(isProjectsInsights(bad)).toBe(false);
  });
});
