import { describe, expect, test } from 'bun:test';
import type { ProjectsClient } from '../../../app/lib/client.ts';
import {
  BOARD_PROJECTS_ROUTE,
  readWorkProjectNames,
  workProjectNames,
  workProjectNamesList,
} from '../../../app/lib/work-project-names.ts';

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

describe('workProjectNamesList', () => {
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  test('should read nothing until the names are first asked for, then once', async () => {
    // Arrange
    const { fake, routes } = client(() => ({ projects: [{ id: 'p1', name: 'ferretry' }] }));
    const list = workProjectNamesList(fake);
    await settle();
    expect(routes).toEqual([]);

    // Act
    list.names();
    list.names();
    await settle();
    list.names();

    // Assert
    expect(routes).toEqual([BOARD_PROJECTS_ROUTE]);
  });

  test('should answer an empty map while the read is out and the names once it lands, telling each listener', async () => {
    // Arrange
    const { fake } = client(() => ({ projects: [{ id: 'p1', name: 'ferretry' }] }));
    const list = workProjectNamesList(fake);
    let heard = 0;
    list.subscribe(() => {
      heard += 1;
    });

    // Act
    const before = list.names();
    await settle();

    // Assert
    expect(before.size).toBe(0);
    expect(heard).toBe(1);
    expect([...list.names()]).toEqual([['p1', 'ferretry']]);
  });

  test('should not tell a listener that stopped listening', async () => {
    // Arrange
    const { fake } = client(() => ({ projects: [{ id: 'p1', name: 'ferretry' }] }));
    const list = workProjectNamesList(fake);
    let heard = 0;
    const stop = list.subscribe(() => {
      heard += 1;
    });
    stop();

    // Act
    list.names();
    await settle();

    // Assert
    expect(heard).toBe(0);
  });

  test('should stay empty and not read again when the read fails', async () => {
    // Arrange
    const routes: string[] = [];
    const refused = {
      call: async (route: string) => {
        routes.push(route);
        throw new Error('Board is off');
      },
    } as unknown as ProjectsClient;
    const list = workProjectNamesList(refused);

    // Act
    list.names();
    await settle();
    list.names();
    await settle();

    // Assert
    expect(list.names().size).toBe(0);
    expect(routes).toEqual([BOARD_PROJECTS_ROUTE]);
  });

  test('should not be settled until the read is over, and then be settled whether it landed or failed', async () => {
    // Arrange
    const landed = workProjectNamesList(client(() => ({ projects: [] })).fake);
    const failed = workProjectNamesList({
      call: async () => {
        throw new Error('Board is off');
      },
    } as unknown as ProjectsClient);

    // Act
    const before = [landed.settled(), failed.settled()];
    landed.names();
    failed.names();
    const during = [landed.settled(), failed.settled()];
    await settle();

    // Assert
    expect(before).toEqual([false, false]);
    expect(during).toEqual([false, false]);
    expect([landed.settled(), failed.settled()]).toEqual([true, true]);
  });

  test('should let go of a waiting listener once the read fails, without telling it', async () => {
    // Arrange
    const list = workProjectNamesList({
      call: async () => {
        throw new Error('Board is off');
      },
    } as unknown as ProjectsClient);
    let heard = 0;
    list.subscribe(() => {
      heard += 1;
    });

    // Act
    list.names();
    await settle();

    // Assert
    expect(heard).toBe(0);
  });

  test('should not keep a listener added after the read is over', async () => {
    // Arrange
    const list = workProjectNamesList(client(() => ({ projects: [{ id: 'p1', name: 'ferretry' }] })).fake);
    list.names();
    await settle();
    let heard = 0;

    // Act
    const stop = list.subscribe(() => {
      heard += 1;
    });
    stop();

    // Assert
    expect(heard).toBe(0);
    expect(list.settled()).toBe(true);
  });
});
