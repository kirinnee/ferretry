import { describe, expect, test } from 'bun:test';
import { fakeProjects, projectsConformance } from '../../contract/testing/index.ts';
import {
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
  test('the stored file is format 1 and refuses an unknown field', () => {
    expect(ProjectsFileSchema.safeParse({ format: 1, projects: [] }).success).toBe(true);
    expect(ProjectsFileSchema.safeParse({ format: 2, projects: [] }).success).toBe(false);
    expect(ProjectsFileSchema.safeParse({ format: 1, projects: [], extra: true }).success).toBe(false);
  });
});
