import { describe, expect, test } from 'bun:test';
import { ASK_OWNERS_ROUTE, askOwners, askOwnersList, readAskOwners } from '../../../app/lib/ask-owners.ts';
import type { FerretsClient } from '../../../app/lib/client.ts';

/** A client that records every route it is asked and answers with `answer`. */
function client(answer: () => unknown) {
  const routes: string[] = [];
  const fake: FerretsClient = {
    call: async (route: string) => {
      routes.push(route);
      return answer();
    },
  } as FerretsClient;
  return { fake, routes };
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('askOwners', () => {
  test('should map each ferret id to the callsign it is shown by, leaving out a ferret with none', () => {
    // Act
    const owners = askOwners([
      { id: 'f1', name: 'hayden' },
      { id: 'f2', name: 'ms-98' },
      { id: 'f3', name: '  ' },
    ]);

    // Assert
    expect([...owners]).toEqual([
      ['f1', 'Hayden'],
      ['f2', 'Ms-98'],
    ]);
  });
});

describe('readAskOwners', () => {
  test('should read the ferret list by route key and keep only the id and the callsign', async () => {
    // Arrange
    const { fake, routes } = client(() => [{ id: 'f1', name: 'hayden', folder: '/work/secret', title: 'private' }]);

    // Act
    const owners = await readAskOwners(fake);

    // Assert
    expect(routes).toEqual([ASK_OWNERS_ROUTE]);
    expect([...owners]).toEqual([['f1', 'Hayden']]);
  });

  test('should refuse an answer that is not a list of named ferrets', async () => {
    // Arrange
    const { fake } = client(() => [{ id: '', name: 'x' }]);

    // Act / Assert
    await expect(readAskOwners(fake)).rejects.toThrow();
  });
});

describe('askOwnersList', () => {
  test('should read nothing until the names are first asked for, then once', async () => {
    // Arrange
    const { fake, routes } = client(() => [{ id: 'f1', name: 'hayden' }]);
    const list = askOwnersList(fake);
    await settle();
    expect(routes).toEqual([]);

    // Act
    list.names();
    list.names();
    await settle();
    list.names();

    // Assert
    expect(routes).toEqual([ASK_OWNERS_ROUTE]);
  });

  test('should answer an empty map while the read is out and the callsigns once it lands, telling each listener', async () => {
    // Arrange
    const { fake } = client(() => [{ id: 'f1', name: 'hayden' }]);
    const list = askOwnersList(fake);
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
    expect([...list.names()]).toEqual([['f1', 'Hayden']]);
  });

  test('should not tell a listener that stopped listening', async () => {
    // Arrange
    const { fake } = client(() => [{ id: 'f1', name: 'hayden' }]);
    const list = askOwnersList(fake);
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
    const refused: FerretsClient = {
      call: async (route: string) => {
        routes.push(route);
        throw new Error('refused');
      },
    } as FerretsClient;
    const list = askOwnersList(refused);

    // Act
    list.names();
    await settle();
    list.names();
    await settle();

    // Assert
    expect(list.names().size).toBe(0);
    expect(routes).toEqual([ASK_OWNERS_ROUTE]);
  });

  test('should not be settled until the read is over, and then be settled whether it landed or failed', async () => {
    // Arrange
    const landed = askOwnersList(client(() => []).fake);
    const failed = askOwnersList({
      call: async () => {
        throw new Error('refused');
      },
    } as FerretsClient);

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
    const list = askOwnersList({
      call: async () => {
        throw new Error('refused');
      },
    } as FerretsClient);
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
    const list = askOwnersList(client(() => [{ id: 'f1', name: 'hayden' }]).fake);
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
