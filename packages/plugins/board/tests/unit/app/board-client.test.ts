import { describe, expect, it } from 'bun:test';
import {
  BOARD_MAX_PAGES,
  BoardReadError,
  clientBoardPort,
  readWholeBoard,
  REQUEST_ID_HEADER,
} from '../../../app/lib/board-client.ts';
import { NO_BOARD_FILTERS, toServerQuery } from '../../../app/lib/board-model.ts';
import { boardAnswer, card, fakePort, laneSetFor, laptop, PROJECT } from './board-support.ts';

type Call = {
  route: string;
  init: {
    params?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
    headers?: Record<string, string>;
  };
};

const query = toServerQuery(NO_BOARD_FILTERS);
const refusal = (status: number, message: string, code?: string): Error =>
  Object.assign(new Error(message), { status, ...(code === undefined ? {} : { code }) });

/** A PluginClient whose routes answer from `answers` (a value, or a function that throws to refuse). */
const clientOf = (answers: Record<string, unknown | ((call: Call) => unknown)>) => {
  const calls: Call[] = [];
  return {
    calls,
    call: async <T>(route: string, init: Call['init'] = {}): Promise<T> => {
      calls.push({ route, init });
      const answer = answers[route];
      if (answer === undefined) throw refusal(404, `no ${route}`);
      return (typeof answer === 'function' ? (answer as (call: Call) => unknown)({ route, init }) : answer) as T;
    },
  };
};

describe('the board read', () => {
  it('asks for the query and parses the answer', async () => {
    const client = clientOf({ 'GET /v1/board': boardAnswer([card('F1')]) });
    const answer = await clientBoardPort(client).board(laptop, { ...query, project: PROJECT }, 'c1', 10);
    expect(answer.cards.map(entry => entry.id)).toEqual(['F1']);
    expect(client.calls[0]?.init.query).toMatchObject({ project: PROJECT, cursor: 'c1', limit: '10' });
  });

  it('throws the daemon’s refusal with its status', async () => {
    const client = clientOf({
      'GET /v1/board': () => {
        throw refusal(500, 'nope', 'x');
      },
    });
    await expect(clientBoardPort(client).board(laptop, query)).rejects.toMatchObject({
      status: 500,
      message: 'nope',
      code: 'x',
    });
    await expect(clientBoardPort(client).board(laptop, query)).rejects.toBeInstanceOf(BoardReadError);
  });

  it('refuses an answer that is not a board', async () => {
    const client = clientOf({ 'GET /v1/board': { cards: 1 } });
    await expect(clientBoardPort(client).board(laptop, query)).rejects.toThrow();
  });

  it('reads every card id of the machine in one request', async () => {
    const client = clientOf({ 'GET /v1/board/ids': { ids: ['F1', 'B2'] } });
    expect(await clientBoardPort(client).ids(laptop)).toEqual(['F1', 'B2']);
  });

  it('answers null for a card the daemon does not have, and throws for any other refusal', async () => {
    const missing = clientOf({});
    expect(await clientBoardPort(missing).card(laptop, 'F9')).toBeNull();
    const broken = clientOf({
      'GET /v1/board/cards/:cardId': () => {
        throw refusal(500, 'boom');
      },
    });
    await expect(clientBoardPort(broken).card(laptop, 'F9')).rejects.toMatchObject({ status: 500 });
  });

  it('reads the daemon version from health, and null when health cannot be read', async () => {
    expect(await clientBoardPort(clientOf({ 'GET /v1/health': { version: '5.0.0' } })).version(laptop)).toBe('5.0.0');
    expect(await clientBoardPort(clientOf({})).version(laptop)).toBeNull();
  });

  it('reads the projects with their lane sets', async () => {
    const client = clientOf({
      'GET /v1/board/projects': {
        projects: [{ id: PROJECT, name: 'Ferretry', path: null, laneSet: laneSetFor() }],
        current: null,
      },
    });
    const projects = await clientBoardPort(client).projects(laptop);
    expect(projects.map(project => project.id)).toEqual([PROJECT]);
  });
});

describe('the board writes', () => {
  it('never sends a malformed card and says why', async () => {
    const client = clientOf({});
    const answer = await clientBoardPort(client).create(laptop, { title: '' } as never);
    expect(client.calls).toEqual([]);
    expect(!answer.ok && answer.error).toMatchObject({ status: 0, boardCode: 'invalid' });
  });

  it('hands a refusal back as a value with the daemon’s code, and a dead network as status 0', async () => {
    const refused = clientOf({
      'POST /v1/board/cards/:cardId': () => {
        throw refusal(409, 'needs a reason', 'reason-required');
      },
    });
    const answer = await clientBoardPort(refused).act(laptop, 'F1', { action: 'move', to: 'review' } as never);
    expect(!answer.ok && answer.error).toMatchObject({ status: 409, message: 'needs a reason' });
    const down = clientOf({
      'POST /v1/board/cards/:cardId/start': () => {
        throw new Error('offline');
      },
    });
    const started = await clientBoardPort(down).start(laptop, 'F1');
    expect(!started.ok && started.error).toEqual({ status: 0, message: 'offline', boardCode: null });
  });

  it('sends an action key so a retried click is safe', async () => {
    const client = clientOf({ 'POST /v1/board/cards/:cardId/start': { ok: true } });
    await clientBoardPort(client).start(laptop, 'F1', 'key-1');
    expect(client.calls[0]?.init.headers).toEqual({ [REQUEST_ID_HEADER]: 'key-1' });
  });

  it('says so when the daemon answers with a card it cannot read', async () => {
    const client = clientOf({ 'POST /v1/board/cards': { nonsense: true } });
    const odd = await clientBoardPort(client).create(laptop, {
      title: 'A card',
      kind: 'feature',
      ask: { text: 'do it', source: 'owner' },
    } as never);
    expect(!odd.ok && odd.error.message).toContain('cannot read');
  });

  it('refuses a lane change the daemon answered unreadably', async () => {
    const client = clientOf({ 'POST /v1/board/projects/:projectId/lanes': { nope: 1 } });
    const odd = await clientBoardPort(client).lanes(laptop, PROJECT, { action: 'confirm', version: 1 });
    expect(!odd.ok && odd.error.message).toContain('cannot read');
  });
});

describe('readWholeBoard', () => {
  it('follows each cursor and reports a board longer than the pages read as truncated', async () => {
    let page = 0;
    const port = fakePort({
      board: async () => {
        page += 1;
        return boardAnswer([card(`F${page}`)], { nextCursor: `c${page}` });
      },
    });
    const read = await readWholeBoard(port, laptop, query);
    expect(read.response.cards).toHaveLength(BOARD_MAX_PAGES);
    expect(read.truncated).toBe(true);
  });

  it('is whole when the last page has no cursor', async () => {
    const read = await readWholeBoard(fakePort(), laptop, query);
    expect(read.truncated).toBe(false);
  });
});
