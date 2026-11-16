import { describe, expect, test } from 'bun:test';
import type { ProjectsClient } from '../../../app/lib/client.ts';
import { BOARD_PROJECTS_ROUTE, readWorkProjectNames, workProjectNames } from '../../../app/lib/work-project-names.ts';

/** A client that records every route it is asked and answers with `answer`. */
function client(answer: () => unknown) {
  const routes: string[] = [];
  const fake = {
    call: async (route: string) => {
      routes.push(route);
      return answer();
    },
  } as unknown as ProjectsClient;
  return { fake, routes };
}

describe('workProjectNames', () => {
  test('should map each project id to its name', () => {
    // Act
    const names = workProjectNames([
      { id: 'p1', name: 'ferretry' },
      { id: 'unfiled', name: 'Unfiled' },
    ]);

    // Assert
    expect([...names]).toEqual([
      ['p1', 'ferretry'],
      ['unfiled', 'Unfiled'],
    ]);
  });
});

describe('readWorkProjectNames', () => {
  test('should read Board’s list by route key and name every project, extra fields ignored', async () => {
    // Arrange
    const { fake, routes } = client(() => ({
      projects: [{ id: 'p1', name: 'ferretry', path: '/work/ferretry' }],
      cursor: null,
    }));

    // Act
    const names = await readWorkProjectNames(fake);

    // Assert
    expect(routes).toEqual([BOARD_PROJECTS_ROUTE]);
    expect([...names]).toEqual([['p1', 'ferretry']]);
  });

  test('should refuse an answer that is not a list of named projects', async () => {
    // Arrange
    const { fake } = client(() => ({ projects: [{ id: '', name: 'x' }] }));

    // Act / Assert
    await expect(readWorkProjectNames(fake)).rejects.toThrow();
  });
});
