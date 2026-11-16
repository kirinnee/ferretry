import { defineState } from '@ferretry/kernel/contract';
import { ProjectsFileSchema } from './wire.ts';

/**
 * `state/projects/projects.json`: the registry, `format: 1` first (§9.2). The manifest declares the same file (the
 * kernel matches a declaration by name, path, store and format); the daemon half reads and writes through this one.
 * Damaged = the subsystem fails closed.
 */
export const PROJECTS_STATE = defineState({
  name: 'projects',
  path: 'projects.json',
  store: 'json',
  format: 1,
  schema: ProjectsFileSchema,
});
