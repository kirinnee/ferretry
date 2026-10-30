import { describe, expect, it } from 'bun:test';

import {
  BOARD_MAX_PAGES,
  daemonBoardPort,
  fetchBoardPage,
  fetchBoardProjects,
  fetchBoardTask,
  fetchDaemonVersion,
  postBoardAction,
  postBoardCreate,
  readWholeBoard,
} from '../../src/lib/board-client.ts';
import { NO_BOARD_FILTERS, toServerQuery } from '../../src/lib/board-model.ts';
import { healthOf } from '../support/health.ts';
import { boardAnswer, card, fakePort, laneSetFor, laptop, PROJECT } from './board-support.ts';

const query = toServerQuery(NO_BOARD_FILTERS);
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('fetchBoardPage', () => {
  it('asks the paired daemon for the query and parses the answer', async () => {
    let url = '';
    const answer = await fetchBoardPage(
      laptop,
      { ...query, project: PROJECT },
      'c1',
      async asked => {
        url = String(asked);
        return json(boardAnswer([card('F1')]));
      },
      10,
    );
    expect(url).toContain('https://laptop.example.test/v1/board?');
    expect(url).toContain(`project=${PROJECT}`);
    expect(url).toContain('cursor=c1');
    expect(url).toContain('limit=10');
    expect(answer.cards.map(entry => entry.id)).toEqual(['F1']);
  });

  it('throws the daemon’s error with its status', async () => {
    const failing = fetchBoardPage(laptop, query, undefined, async () => json({ error: 'nope', code: 'x' }, 500));
    await expect(failing).rejects.toMatchObject({ status: 500, message: 'nope' });
    const bare = fetchBoardPage(laptop, query, undefined, async () => new Response('plain', { status: 502 }));
    await expect(bare).rejects.toMatchObject({ status: 502, message: 'HTTP 502' });
  });

  it('refuses an answer that is not a board', async () => {
    await expect(fetchBoardPage(laptop, query, undefined, async () => json({ cards: 1 }))).rejects.toThrow();
  });
});

describe('fetchBoardTask', () => {
  it('reads one card, and reads a missing card as null', async () => {
    let url = '';
    const found = await fetchBoardTask(laptop, 'F1', async asked => {
      url = String(asked);
      return json({ task: card('F1'), laneSet: laneSetFor() });
    });
    expect(url).toBe('https://laptop.example.test/v1/board/tasks/F1');
    expect(found?.task.id).toBe('F1');
    expect(await fetchBoardTask(laptop, 'F1', async () => json({ error: 'no' }, 404))).toBeNull();
    await expect(fetchBoardTask(laptop, 'F1', async () => json({ error: 'down' }, 503))).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe('fetchBoardProjects', () => {
  it('reads the projects with their lane sets', async () => {
    const projects = await fetchBoardProjects(laptop, async () =>
      json({ projects: [{ id: PROJECT, name: 'ferretry', path: '/x', laneSet: laneSetFor() }], current: PROJECT }),
    );
    expect(projects?.map(entry => entry.name)).toEqual(['ferretry']);
  });

  it('reads a daemon from before the route (404, 405) as not serving it, and a real failure as one', async () => {
    expect(await fetchBoardProjects(laptop, async () => json({}, 404))).toBeNull();
    expect(await fetchBoardProjects(laptop, async () => json({}, 405))).toBeNull();
    await expect(fetchBoardProjects(laptop, async () => json({ error: 'x' }, 500))).rejects.toMatchObject({
      status: 500,
    });
  });
});

describe('fetchDaemonVersion', () => {
  it('reads the version from health, and null when it cannot', async () => {
    expect(await fetchDaemonVersion(laptop, async () => json(healthOf('4.110.0')))).toBe('4.110.0');
    expect(await fetchDaemonVersion(laptop, async () => json({ error: 'x' }, 500))).toBeNull();
    expect(
      await fetchDaemonVersion(laptop, async () => {
        throw new Error('offline');
      }),
    ).toBeNull();
  });
});

describe('postBoardAction', () => {
  it('posts the parsed action to the card’s machine and returns the card as it now is', async () => {
    let sent: { url: string; method?: string; body?: unknown } = { url: '' };
    const answer = await postBoardAction(laptop, 'F1', { action: 'note', text: 'hello' }, async (asked, init) => {
      sent = { url: String(asked), method: init?.method, body: JSON.parse(String(init?.body)) };
      return json({ task: card('F1'), laneSet: laneSetFor() });
    });
    expect(sent).toEqual({
      url: 'https://laptop.example.test/v1/board/tasks/F1',
      method: 'POST',
      body: { action: 'note', text: 'hello' },
    });
    expect(answer.ok && answer.value.task.id).toBe('F1');
  });

  it('never sends a malformed action', async () => {
    let called = false;
    const answer = await postBoardAction(laptop, 'F1', { action: 'note', text: '' }, async () => {
      called = true;
      return json({});
    });
    expect(called).toBe(false);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.error.status).toBe(0);
  });

  it('hands a refusal back as a value, with the daemon’s code when it is one this app knows', async () => {
    const refused = await postBoardAction(laptop, 'F1', { action: 'note', text: 'x' }, async () =>
      json({ error: 'needs a reason', code: 'reason-required' }, 409),
    );
    expect(refused).toEqual({
      ok: false,
      error: { status: 409, message: 'needs a reason', boardCode: 'reason-required' },
    });
    const unknown = await postBoardAction(laptop, 'F1', { action: 'note', text: 'x' }, async () =>
      json({ error: 'odd', code: 'from-the-future' }, 400),
    );
    expect(!unknown.ok && unknown.error.boardCode).toBeNull();
  });

  it('says so when the daemon cannot be reached or answers with a card it cannot read', async () => {
    const down = await postBoardAction(laptop, 'F1', { action: 'note', text: 'x' }, async () => {
      throw new Error('offline');
    });
    expect(!down.ok && down.error).toEqual({ status: 0, message: 'offline', boardCode: null });
    const odd = await postBoardAction(laptop, 'F1', { action: 'note', text: 'x' }, async () =>
      json({ nonsense: true }),
    );
    expect(!odd.ok && odd.error.status).toBe(200);
    const text = await postBoardAction(laptop, 'F1', { action: 'note', text: 'x' }, async () => {
      throw 'plain';
    });
    expect(!text.ok && text.error.message).toBe('plain');
  });
});

describe('postBoardCreate', () => {
  const request = { kind: 'feature', title: 'Try it', ask: { text: 'do it', source: 'owner (board)' } } as const;

  it('posts the parsed card to the machine’s board and returns the card it opened', async () => {
    let sent: { url: string; method?: string; body?: Record<string, unknown> } = { url: '' };
    const answer = await postBoardCreate(laptop, request, async (asked, init) => {
      sent = { url: String(asked), method: init?.method, body: JSON.parse(String(init?.body)) };
      return json({ task: card('F9'), laneSet: laneSetFor() });
    });
    expect(sent.url).toBe('https://laptop.example.test/v1/board/tasks');
    expect(sent.method).toBe('POST');
    expect(sent.body).toMatchObject({ kind: 'feature', title: 'Try it', workflow: 'quick' });
    expect(answer.ok && answer.value.task.id).toBe('F9');
  });

  it('hands a refusal back as a value, with the daemon’s code', async () => {
    const refused = await postBoardCreate(laptop, request, async () =>
      json({ error: 'owner only', code: 'owner-gate' }, 403),
    );
    expect(refused).toEqual({ ok: false, error: { status: 403, message: 'owner only', boardCode: 'owner-gate' } });
  });

  it('says so when the daemon cannot be reached', async () => {
    const down = await postBoardCreate(laptop, request, async () => {
      throw new Error('offline');
    });
    expect(!down.ok && down.error).toEqual({ status: 0, message: 'offline', boardCode: null });
    const text = await postBoardCreate(laptop, request, async () => {
      throw 'plain';
    });
    expect(!text.ok && text.error.message).toBe('plain');
  });

  it('never sends a malformed card', async () => {
    let called = false;
    const answer = await postBoardCreate(laptop, { ...request, title: '' }, async () => {
      called = true;
      return json({});
    });
    expect(called).toBe(false);
    expect(!answer.ok && answer.error).toMatchObject({ status: 0, boardCode: 'invalid' });
  });

  it('says so when the daemon answers with a card it cannot read', async () => {
    const odd = await postBoardCreate(laptop, request, async () => json({ nonsense: true }));
    expect(!odd.ok && odd.error).toEqual({
      status: 200,
      message: 'the daemon answered with a card this app cannot read',
      boardCode: null,
    });
  });
});

describe('daemonBoardPort', () => {
  it('binds every call to the fetcher it is given', async () => {
    const urls: string[] = [];
    const port = daemonBoardPort(async asked => {
      urls.push(String(asked));
      const path = new URL(String(asked)).pathname;
      if (path === '/v1/board') return json(boardAnswer([]));
      if (path === '/v1/health') return json(healthOf('1.0.0'));
      if (path === '/v1/board/projects')
        return json({ projects: [{ id: PROJECT, name: 'p', path: null, laneSet: null }], current: null });
      if (path.startsWith('/v1/board/tasks/')) return json({ task: card('F1'), laneSet: null });
      return json({}, 404);
    });
    await port.board(laptop, query);
    await port.task(laptop, 'F1');
    await port.projects(laptop);
    expect(await port.version(laptop)).toBe('1.0.0');
    await port.act(laptop, 'F1', { action: 'note', text: 'x' });
    expect(urls).toHaveLength(5);
  });
});

describe('readWholeBoard', () => {
  it('follows the cursor and keeps the first page’s numbers', async () => {
    const pages = [
      boardAnswer([card('F1')], { nextCursor: 'b', projectId: PROJECT, laneSet: laneSetFor() }),
      boardAnswer([card('F2')], { nextCursor: null }),
    ];
    const port = fakePort({ board: async (_d, _q, cursor) => pages[cursor === 'b' ? 1 : 0] ?? boardAnswer([]) });
    const read = await readWholeBoard(port, laptop, query);
    expect(read.response.cards.map(entry => entry.id)).toEqual(['F1', 'F2']);
    expect(read.response.laneSet).not.toBeNull();
    expect(read.truncated).toBe(false);
  });

  it('stops at the page limit and says the board is partial', async () => {
    let page = 0;
    const port = fakePort({ board: async () => boardAnswer([card(`F${++page}`)], { nextCursor: 'more' }) });
    const read = await readWholeBoard(port, laptop, query);
    expect(read.response.cards).toHaveLength(BOARD_MAX_PAGES);
    expect(read.truncated).toBe(true);
    expect(read.response.nextCursor).toBe('more');
  });
});
