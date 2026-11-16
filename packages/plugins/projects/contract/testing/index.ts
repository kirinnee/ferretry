/** @ferretry/plugin-projects/contract/testing — the contract's fake and conformance suite (§7.8). */
import { describe, expect, test } from 'bun:test';
import { err, type Instant, ok } from '@ferretry/std';
import {
  type ProjectId,
  type ProjectInfo,
  ProjectInfoSchema,
  type ProjectsApi,
  RegisterProjectRequestSchema,
} from '../index.ts';

export interface FakeProjectsOptions {
  readonly now?: () => Instant;
  /** Mints the next id; the default is a counter that makes valid uuids. */
  readonly newId?: () => string;
}

const uuidFor = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const lastSegment = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path;

/** An in-memory `ProjectsApi`: dedupes by path, lists oldest first, never touches a disk. */
export function fakeProjects(options: FakeProjectsOptions = {}): ProjectsApi {
  const projects: ProjectInfo[] = [];
  let counter = 0;
  const newId = options.newId ?? (() => uuidFor(++counter));
  const now = options.now ?? (() => '2026-11-07T09:00:00.000Z' as Instant);
  return {
    list: async () => [...projects],
    find: async id => projects.find(project => project.id === id),
    register: async request => {
      const parsed = RegisterProjectRequestSchema.safeParse(request);
      if (!parsed.success)
        return err({
          code: 'registration_failed',
          message: parsed.error.issues[0]?.message ?? 'not a project request',
        });
      const path = parsed.data.path.replace(/(.)\/+$/, '$1');
      const existing = projects.find(project => project.path === path);
      if (existing !== undefined) return ok(existing);
      const record = ProjectInfoSchema.parse({
        id: newId(),
        name: parsed.data.name ?? lastSegment(path),
        path,
        source: parsed.data.kind,
        createdAt: now(),
      });
      projects.push(record);
      return ok(record);
    },
    remove: async id => {
      const at = projects.findIndex(project => project.id === id);
      const [removed] = at === -1 ? [] : projects.splice(at, 1);
      return removed === undefined ? err({ code: 'not_found', message: `no project ${id}` }) : ok(removed);
    },
  };
}

/** The behaviour every `ProjectsApi` (the real one and every fake) keeps. */
export function projectsConformance(name: string, make: () => ProjectsApi): void {
  describe(`ProjectsApi conformance: ${name}`, () => {
    test('a registered folder is listed, found, and answers the same record when registered again', async () => {
      const api = make();
      const first = await api.register({ kind: 'existing-folder', path: '/work/alpha' });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const again = await api.register({ kind: 'existing-folder', path: '/work/alpha', name: 'other' });
      expect(again.ok && again.value.id).toBe(first.value.id);
      expect((await api.list()).map(project => project.id)).toEqual([first.value.id]);
      expect((await api.find(first.value.id))?.path).toBe('/work/alpha');
    });

    test('a relative path is refused, not resolved against the daemon', async () => {
      const result = await make().register({ kind: 'existing-folder', path: 'alpha' } as never);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('registration_failed');
    });

    test('removing answers the removed record, then the project is gone and a second removal is not_found', async () => {
      const api = make();
      const added = await api.register({ kind: 'existing-folder', path: '/work/beta' });
      if (!added.ok) throw new Error('setup');
      const removed = await api.remove(added.value.id);
      expect(removed.ok && removed.value.id).toBe(added.value.id);
      expect(await api.find(added.value.id)).toBeUndefined();
      const second = await api.remove(added.value.id as ProjectId);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error.code).toBe('not_found');
    });
  });
}
