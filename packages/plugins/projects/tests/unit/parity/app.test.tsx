import { describe, expect, test } from 'bun:test';
import app from '../../../app/index.ts';
import { projectBoardPath, projectPath, projectsPath } from '../../../app/lib/paths.ts';
import manifest from '../../../manifest.ts';

const half = app.build?.({ manifest, client: {} as never });
const source = async (path: string): Promise<string> => await Bun.file(`${import.meta.dir}/../../../app/${path}`).text();

/** The route model of today's PWA is the two screens this plugin declares; the shell binds them to `/d/<daemon>/…`. */
describe('app parity', () => {
  test('S-0402 S-0351 S-0187 S-0188 the projects screen is the registry page', () => {
    expect(manifest.ui?.screens?.map(screen => screen.id)).toEqual(['projects', 'project']);
    expect(typeof half?.screens.projects).toBe('function');
  });

  test('S-0400 S-0349 S-0183 S-0184 S-0185 the project screen is the detail page', () => {
    expect(typeof half?.screens.project).toBe('function');
    expect(manifest.ui?.screens?.find(screen => screen.id === 'project')?.path).toBe('/projects/:id');
  });

  test('S-0401 S-0350 S-0186 the lanes of a project are edited on its own board, one link away', async () => {
    expect(projectBoardPath('workstation', '11111111-1111-4111-8111-111111111111')).toBe(
      '/d/workstation/board/11111111-1111-4111-8111-111111111111',
    );
    expect(await source('views/project-detail.tsx')).toContain('data-project-lanes-link');
  });

  test('S-0222 S-0318 the project page draws provenance, board, ferrets and files; the registry page its form and discoveries', async () => {
    const detail = await source('views/project-detail.tsx');
    for (const title of ['Provenance', 'Board', 'Active ferrets', 'Files of this project’s ferrets'])
      expect(detail).toContain(`title="${title}"`);
    expect(detail).toContain('function Section(');
    const hub = await source('views/projects-hub.tsx');
    expect(hub).toContain('<AddProjectForm');
    expect(hub).toContain('<ProjectDiscoveries');
  });

  test('S-0127 other plugins’ pickers read the project list through the projects port, and the app half keeps a known-list reader', async () => {
    expect(manifest.provides.projects.name).toBe('projects');
    expect(await source('hooks/use-projects.ts')).toContain('export const useKnownProjects');
  });

  test('S-0375 S-0376 S-0377 the addresses of the screens are per daemon and mint only a registered project UUID', () => {
    expect(projectsPath('workstation')).toBe('/d/workstation/projects');
    expect(projectPath('workstation', '11111111-1111-4111-8111-111111111111')).toBe(
      '/d/workstation/projects/11111111-1111-4111-8111-111111111111',
    );
    expect(() => projectPath('workstation', '/work/ferretry')).toThrow();
    expect(() => projectPath('workstation', '')).toThrow();
  });
});
