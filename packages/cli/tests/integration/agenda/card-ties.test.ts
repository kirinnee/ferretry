import { afterEach, describe, it } from 'bun:test';
import { FyApiClient } from '@ferretry/protocol/client';
import should from 'should';
import { BoardCardTies } from '../../../src/adapters/agenda/card-ties';
import { FyBoardGateway } from '../../../src/adapters/board/fy-board-gateway';
import { taskResponse } from '../board/fixtures';

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** A real HTTP server on an EPHEMERAL loopback port standing in for the daemon; it records the paths it was asked. */
function daemon(answer: (path: string) => Response) {
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const { pathname } = new URL(request.url);
      paths.push(pathname);
      return answer(pathname);
    },
  });
  servers.push(server);
  return { paths, url: `http://127.0.0.1:${String(server.port)}` };
}

async function ties(url: string) {
  const client = await FyApiClient.connect({
    baseUrl: url,
    token: 'test-token',
    version: '1.2.3',
    sleep: () => Promise.resolve(),
  });
  return new BoardCardTies(new FyBoardGateway(client));
}

describe('BoardCardTies over FyBoardGateway against a daemon', () => {
  it('should map the card’s dependsOn and blocks to the ties an agenda add lists first', async () => {
    // Arrange
    const { paths, url } = daemon(() =>
      Response.json(
        taskResponse({
          id: 'F12',
          dependsOn: [
            { task: { id: 'F9' }, until: 'shipped' },
            { task: { id: 'F10' }, until: 'released' },
          ],
          blocks: [{ id: 'F14' }],
        }),
      ),
    );

    // Act
    const found = await (await ties(url)).ties({ id: 'F12' });

    // Assert
    should(paths).eql(['/v1/board/tasks/F12']);
    should(found).eql({ dependsOn: [{ id: 'F9' }, { id: 'F10' }], blocks: [{ id: 'F14' }] });
  });

  it('should give a card with no dependencies empty ties, not none', async () => {
    // Arrange
    const { url } = daemon(() => Response.json(taskResponse({ id: 'F12', dependsOn: [], blocks: [] })));

    // Act
    const found = await (await ties(url)).ties({ id: 'F12' });

    // Assert
    should(found).eql({ dependsOn: [], blocks: [] });
  });

  it('should have no ties when the daemon does not know the card (a typo, or an older daemon)', async () => {
    // Arrange
    const { paths, url } = daemon(() => new Response('not found', { status: 404 }));

    // Act
    const found = await (await ties(url)).ties({ id: 'F99' });

    // Assert
    should(paths).eql(['/v1/board/tasks/F99']);
    should(found).be.undefined();
  });

  it('should have no ties when the daemon answers with a card it cannot read', async () => {
    // Arrange
    const { url } = daemon(() => Response.json({ cards: 'an older shape' }));

    // Act
    const found = await (await ties(url)).ties({ id: 'F12' });

    // Assert
    should(found).be.undefined();
  });

  it('should have no ties when the daemon cannot be reached', async () => {
    // Arrange — a port that was open and is now closed.
    const { url } = daemon(() => Response.json(taskResponse()));
    for (const server of servers.splice(0)) server.stop(true);

    // Act
    const found = await (await ties(url)).ties({ id: 'F12' });

    // Assert
    should(found).be.undefined();
  });
});
