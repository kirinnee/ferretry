import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ProjectsFileSchema } from '@ferretry/plugin-projects/contract';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { projectsStep, V5_PROJECTS_FILE } from '../../src/steps/projects.ts';
import { AT, fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const P1 = '0b6f4f0e-8a1e-4c55-9d3a-2f4b6c8d0e11';
const P2 = '9e2d5c3b-1a0f-4e8d-b7c6-a5f4e3d2c1b0';
const project = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `fake-${id.slice(0, 4)}`,
  path: `/work/fake-${id.slice(0, 4)}`,
  source: 'existing-folder',
  createdAt: AT,
  ...extra,
});

test('keeps every project id exactly and wraps the bare v4 array in the v5 envelope', async () => {
  await f.put('state/projects.json', [
    project(P1, { git: { commonDirectory: '/work/fake-0b6f/.git' }, lastActivity: AT }),
    project(P2, { source: 'clone' }),
  ]);
  const report = await projectsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept).toEqual([{ what: 'projects (ids unchanged)', count: 2 }]);
  const target = join(f.to, V5_PROJECTS_FILE);
  const written = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;
  expect(Object.keys(written)[0]).toBe('format');
  const document = ProjectsFileSchema.parse(written);
  expect(document.projects.map(p => String(p.id))).toEqual([P1, P2]);
  expect(document.projects[0]).toMatchObject({
    name: 'fake-0b6f',
    path: '/work/fake-0b6f',
    source: 'existing-folder',
    git: { commonDirectory: '/work/fake-0b6f/.git' },
  });
  expect(document.projects[1]?.git).toBeUndefined();
  expect((await stat(target)).mode & 0o777).toBe(0o600);
});

test('a home with no registry converts to nothing', async () => {
  const report = await projectsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(await stat(join(f.to, V5_PROJECTS_FILE)).catch(() => undefined)).toBeUndefined();
});

test('a repeated id is counted and not carried: the first is kept, the registry still converts', async () => {
  await f.put('state/projects.json', [project(P1), project(P1, { path: '/work/other' })]);
  const report = await projectsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.note).toBe('1 damaged or repeated project record(s) not carried');
  expect(report.kept).toEqual([{ what: 'projects (ids unchanged)', count: 1 }]);
  const document = ProjectsFileSchema.parse(JSON.parse(await readFile(join(f.to, V5_PROJECTS_FILE), 'utf8')));
  expect(document.projects.map(p => ({ id: String(p.id), path: p.path }))).toEqual([
    { id: P1, path: '/work/fake-0b6f' },
  ]);
});

test('a damaged entry is counted and not carried, and its content is in no report and no v5 file', async () => {
  await f.put('state/projects.json', [project(P1), project(P2, { source: 'FAKE-CONTENT-NOT-REPORTED' })]);
  const report = await projectsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.note).toBe('1 damaged or repeated project record(s) not carried');
  expect(JSON.stringify(report)).not.toContain('FAKE-CONTENT');
  const written = await readFile(join(f.to, V5_PROJECTS_FILE), 'utf8');
  expect(written).not.toContain('FAKE-CONTENT');
  expect(ProjectsFileSchema.parse(JSON.parse(written)).projects.map(p => String(p.id))).toEqual([P1]);
});

test('a registry that is not a list, or not JSON, fails naming the file', async () => {
  await f.put('state/projects.json', { projects: [] });
  expect((await projectsStep.run(f.ctx())).note).toBe('state/projects.json: is not a list of projects');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(f.from, 'state/projects.json'), '[{"FAKE-TORN');
  const report = await projectsStep.run(f.ctx());
  expect(report.note).toBe('state/projects.json: is not valid JSON');
  expect(JSON.stringify(report)).not.toContain('FAKE-TORN');
});

test('a dry run reports the count and writes nothing', async () => {
  await f.put('state/projects.json', [project(P1)]);
  const report = await projectsStep.run(f.ctx(true));
  expect(report.status).toBe('converted');
  expect(report.kept[0]?.count).toBe(1);
  expect(await stat(f.to).catch(() => undefined)).toBeUndefined();
});
