/**
 * Projects: v4 `state/projects.json` (a bare array) → v5 `state/projects/projects.json` (`{format: 1, projects}`).
 *
 * Every project id is kept EXACTLY: cards, lanes files, ferrets and `account-defaults.yaml` point at it. The record
 * fields are the same in both versions (v5's `ProjectInfoSchema` is today's, made strict); only the envelope is new.
 */
import { PROJECTS_FORMAT, ProjectsFileSchema } from '@ferretry/plugin-projects/contract';
import { join } from 'node:path';
import type { StepReport } from '../report.ts';
import { failureNote, readV4Json, V4InputError } from '../v4/documents.ts';
import { V4_PROJECTS_FILE, V4Project } from '../v4/projects.ts';
import type { Step } from './index.ts';

/** `packages/plugins/projects/manifest.ts` `PROJECTS_STATE` (declared in the manifest, not the contract). */
export const V5_PROJECTS_FILE = 'state/projects/projects.json';

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
      const projects = value.map((entry, index) => {
        const parsed = V4Project.safeParse(entry);
        if (!parsed.success)
          throw new V4InputError(`${V4_PROJECTS_FILE}: entry ${String(index)} is not a v4 project record`);
        if (seen.has(parsed.data.id))
          throw new V4InputError(`${V4_PROJECTS_FILE}: project id ${parsed.data.id} appears twice`);
        seen.add(parsed.data.id);
        const { id, name, path, source, createdAt, git, lastActivity } = parsed.data;
        return { id, name, path, source, createdAt, git, lastActivity };
      });
      const document = ProjectsFileSchema.safeParse({ format: PROJECTS_FORMAT, projects });
      if (!document.success)
        throw new V4InputError(`${V4_PROJECTS_FILE}: a project does not fit the v5 project record`);
      await ctx.v5.json({ path: V5_PROJECTS_FILE, format: PROJECTS_FORMAT, schema: ProjectsFileSchema }, document.data);
      return {
        ...base,
        status: 'converted',
        ...(ctx.dryRun ? { note: 'dry run: nothing written' } : {}),
        kept: [{ what: 'projects (ids unchanged)', count: projects.length }],
      };
    } catch (error) {
      return { ...base, status: 'failed', note: failureNote(error, 'cannot convert the project registry'), kept: [] };
    }
  },
};
