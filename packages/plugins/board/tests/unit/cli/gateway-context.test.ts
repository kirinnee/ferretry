import { describe, it } from 'bun:test';
import should from 'should';
import { BoardController } from '../../../cli/lib/board-controller.ts';
import { extrasOf, ownFerretOf } from '../../../cli/lib/context.ts';
import { ClientBoardGateway } from '../../../cli/lib/gateway.ts';
import type { BoardGateway, BoardOutput, TextFiles } from '../../../cli/lib/ports.ts';
import { response } from './fixtures.ts';
import { listing } from './lane-fixtures.ts';

const PR = 'https://github.com/o/r/pull/1';

const clientAnswering = (answer: unknown) => {
  const calls: { route: string; init: unknown }[] = [];
  return {
    calls,
    client: {
      call: async (route: string, init?: unknown) => {
        calls.push({ route, init });
        return answer;
      },
      subscribe: () => () => {},
    } as never,
  };
};

describe('the board gateway directory and merge gate', () => {
  it('should read ferret names from a bare list, keeping only rows that have a string id', async () => {
    const { client, calls } = clientAnswering([{ id: 'a', name: 'denisha' }, { id: 'b' }, { id: 7 }, 'row', null]);
    should(await new ClientBoardGateway(client).ferrets()).eql([
      { id: 'a', name: 'denisha' },
      { id: 'b', name: undefined },
    ]);
    should(calls[0]?.route).equal('GET /v1/ferrets');
  });

  it('should read ferret names from a list under ferrets, and an unreadable answer as no ferrets', async () => {
    should(await new ClientBoardGateway(clientAnswering({ ferrets: [{ id: 'a', name: 3 }] }).client).ferrets()).eql([
      { id: 'a', name: undefined },
    ]);
    should(await new ClientBoardGateway(clientAnswering({ ferrets: 'none' }).client).ferrets()).eql([]);
    should(await new ClientBoardGateway(clientAnswering(null).client).ferrets()).eql([]);
  });

  it('should ask the merge gate for the pull request and parse the answer', async () => {
    const { client, calls } = clientAnswering({ pr: PR, unit: [], waits: [], unreadable: [] });
    should(await new ClientBoardGateway(client).mergeGate(PR)).eql({ pr: PR, unit: [], waits: [], unreadable: [] });
    should(calls[0]).eql({ route: 'GET /v1/board/merge-gate', init: { query: { pr: PR } } });
  });

  it('should post the related-cards search body as given', async () => {
    const { client, calls } = clientAnswering({ matches: [] });
    should(await new ClientBoardGateway(client).related({ kind: 'card', title: 'x' })).eql({ matches: [] });
    should(calls[0]).eql({ route: 'POST /v1/search/related', init: { body: { kind: 'card', title: 'x' } } });
  });
});

describe('the shell extras', () => {
  const io = {} as never;

  it('should take the environment and the file reader from the context', async () => {
    const context = { env: { FY_SESSION_ID: ' sess-1 ' }, readText: async () => 'from context' };
    const extras = extrasOf(context, io);
    should(await extras.readText?.('/x')).equal('from context');
    should(ownFerretOf(extras)).equal('sess-1');
  });

  it('should fall back to the terminal io file reader, and to nothing at all', async () => {
    const extras = extrasOf(undefined, { readText: async () => 'from io' } as never);
    should(await extras.readText?.('/x')).equal('from io');
    should(extras.env).be.undefined();
    should(extrasOf(null, io)).eql({});
    should(ownFerretOf({ env: { FY_SESSION_ID: '  ' } })).be.undefined();
  });
});

describe('fy board with a daemon that cannot list ferrets', () => {
  it('should still show the board, leaving ids as they are', async () => {
    const log: string[] = [];
    const output: BoardOutput = {
      success: message => log.push(`ok: ${message}`),
      diagnostic: message => log.push(`diag: ${message}`),
    };
    const gateway = {
      board: async () => response(),
      ferrets: () => Promise.reject(new Error('no directory')),
      projects: async () => listing(),
    } as unknown as BoardGateway;
    const files: TextFiles = { readText: async () => '' };
    const controller = new BoardController({ gateway, output, files, binary: 'fy', ownFerret: undefined });
    await controller.board({ project: 'all' });
    should(log[0]).startWith('ok: Ferretry');
  });
});
