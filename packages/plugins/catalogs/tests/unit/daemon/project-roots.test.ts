/**
 * THE FOLDERS AN INSTALL MAY LAND IN: the roots the item providers name, plus every project Projects has registered.
 * Projects is optional: off, an install can only target the roots the providers name, as before.
 */
import { describe, expect, it } from 'bun:test';
import type { UsesHandle } from '@ferretry/kernel/manifest';
import { fakeProjects } from '@ferretry/plugin-projects/contract/testing';
import type { ProjectsApi } from '@ferretry/plugin-projects/contract';
import { itemProviders } from '../../../daemon/adapters/items.ts';
import { CatalogItems } from '../../../contract/items/index.ts';

const provider = (roots: readonly string[]) => ({ kind: 'skill', projectRoots: async () => roots }) as never;
const hooks = (roots: readonly string[]) =>
  ({ provider: (hook: unknown) => (hook === CatalogItems ? provider(roots) : 'unavailable') }) as never;
const handle = (api: ProjectsApi | undefined): UsesHandle<ProjectsApi> => ({ current: () => api }) as never;

describe('the project roots an install may target', () => {
  it('should add every registered project to the roots the providers name', async () => {
    // Arrange
    const projects = fakeProjects();
    await projects.register({ kind: 'existing-folder', path: '/work/app' });
    const roots = itemProviders(hooks(['/work/named']), handle(projects));

    // Act
    const found = await roots.projectRoots();

    // Assert
    expect(found).toEqual(['/work/named', '/work/app']);
  });

  it('should name only the providers’ roots when Projects is off', async () => {
    // Arrange
    const roots = itemProviders(hooks(['/work/named']), handle(undefined));

    // Act / Assert
    expect(await roots.projectRoots()).toEqual(['/work/named']);
  });
});
