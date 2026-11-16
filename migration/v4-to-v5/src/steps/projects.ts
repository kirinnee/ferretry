/**
 * Projects: v4 `state/projects.json` (a bare array) → v5 `state/projects/projects.json` (`{format: 1, projects}`).
 *
 * Every project id is kept EXACTLY: cards, lanes files, ferrets and `account-defaults.yaml` point at it. The record
 * fields are the same in both versions (v5's `ProjectInfoSchema` is today's, made strict); only the envelope is new.
 */
import { PROJECTS_FORMAT, ProjectsFileSchema } from '@ferretry/plugin-projects/contract';
import { join } from 'node:path';
import type { z } from 'zod';
import type { StepReport } from '../report.ts';
import { failureNote, readV4Json, V4InputError } from '../v4/documents.ts';
import { V4_PROJECTS_FILE, V4Project } from '../v4/projects.ts';
import type { Step } from './index.ts';

/** `packages/plugins/projects/manifest.ts` `PROJECTS_STATE` (declared in the manifest, not the contract). */
export const V5_PROJECTS_FILE = 'state/projects/projects.json';

const pick = ({ id, name, path, source, createdAt, git, lastActivity }: z.infer<typeof V4Project>) => ({
  id,
  name,
  path,
  source,
  createdAt,
  git,
  lastActivity,
});

export const projectsStep: Step = {
  id: 'projects',
  title: 'Projects',
  owner: ['plugin-projects'],
  reads: [V4_PROJECTS_FILE],
  sealed: [],
  notCarried: [],
  async run(ctx): Promise<StepReport> {
    const base = { id: this.id, title: this.title, notCarried: this.notCarried, sealed: [] };
    try {
      const value = await readV4Json(ctx.v4.home, join(ctx.v4.home, V4_PROJECTS_FILE));
      if (value === undefined)
        return { ...base, status: 'converted', note: 'this home has no project registry', kept: [] };
      if (!Array.isArray(value)) throw new V4InputError(`${V4_PROJECTS_FILE}: is not a list of projects`);
      const seen = new Set<string>();
      // One damaged or repeated record is counted and not carried; it never fails the registry.
      let skipped = 0;
      const projects = value.flatMap(entry => {
        const parsed = V4Project.safeParse(entry);
        if (
          !parsed.success ||
          seen.has(parsed.data.id) ||
          !ProjectsFileSchema.safeParse({ format: PROJECTS_FORMAT, projects: [pick(parsed.data)] }).success
        ) {
          skipped++;
          return [];
        }
        seen.add(parsed.data.id);
        return [pick(parsed.data)];
      });
      const document = ProjectsFileSchema.safeParse({ format: PROJECTS_FORMAT, projects });
      if (!document.success)
        throw new V4InputError(`${V4_PROJECTS_FILE}: the projects do not fit the v5 project record`);
      await ctx.v5.json({ path: V5_PROJECTS_FILE, format: PROJECTS_FORMAT, schema: ProjectsFileSchema }, document.data);
      const notes = [
        ...(skipped > 0 ? [`${skipped} damaged or repeated project record(s) not carried`] : []),
        ...(ctx.dryRun ? ['dry run: nothing written'] : []),
      ];
      return {
        ...base,
        status: 'converted',
        ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
        kept: [{ what: 'projects (ids unchanged)', count: projects.length }],
      };
    } catch (error) {
      return { ...base, status: 'failed', note: failureNote(error, 'cannot convert the project registry'), kept: [] };
    }
  },
};
