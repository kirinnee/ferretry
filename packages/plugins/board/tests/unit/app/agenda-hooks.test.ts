/**
 * What Board provides to Agenda's asks: the three app hooks of the REAL half (`app.shell.hooks`), each built as the
 * shell builds it (over one client, on one daemon) against a scripted daemon that records every request. The
 * answers are Board's own: `boardDone` picks the lane, `planMove` plans the move, `createCardReferenceResolver` proves
 * `&F12` and `laneEditDestination` opens the lane editor. Agenda's side (drawing the ask, failing closed without a
 * provider) is tested in Agenda.
 */
import { describe, expect, it } from 'bun:test';
import type { AppHookProviders } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import app from '../../../app/index.ts';
import type { CardView, LaneSet } from '../../../contract/index.ts';
import { card, flush, laneSetFor, PROJECT } from './board-support.ts';

interface Sent {
  readonly route: string;
  readonly cardId?: string;
  readonly body?: unknown;
  readonly key?: string;
}

/** A daemon with `cards` on one lane set; a write answers what `answer` says (the moved card by default). */
const scripted = (
  cards: readonly CardView[],
  options: {
    readonly laneSet?: LaneSet;
    readonly refuse?: { readonly status: number; readonly message: string };
    readonly started?: boolean;
  } = {},
) => {
  const laneSet = options.laneSet ?? laneSetFor();
  const sent: Sent[] = [];
  const client = {
    call: async (
      route: string,
      init?: {
        readonly params?: Readonly<Record<string, string>>;
        readonly body?: unknown;
        readonly headers?: Readonly<Record<string, string>>;
      },
    ) => {
      const cardId = init?.params?.cardId;
      const found = cards.find(each => each.id === cardId);
      if (route.startsWith('POST ')) {
        sent.push({
          route,
          ...(cardId === undefined ? {} : { cardId }),
          ...(init?.body === undefined ? {} : { body: init.body }),
          ...(init?.headers?.['x-fy-request-id'] === undefined ? {} : { key: init.headers['x-fy-request-id'] }),
        });
        if (options.refuse !== undefined)
          throw Object.assign(new Error(options.refuse.message), { status: options.refuse.status });
      }
      switch (route) {
        case 'GET /v1/board/cards/:cardId':
          if (found === undefined) throw Object.assign(new Error('no such card'), { status: 404 });
          return { card: found, laneSet };
        case 'GET /v1/board/ids':
          return { ids: cards.map(each => each.id) };
        case 'POST /v1/board/cards/:cardId': {
          const body = init?.body as { readonly action: string; readonly to?: string };
          return { card: { ...found, ...(body.action === 'move' ? { laneId: body.to } : {}) }, laneSet };
        }
        case 'POST /v1/board/cards/:cardId/start':
          return { card: cardId, ferret: 'mvuc7tsf-0c3d50df', started: options.started ?? true };
        default:
          throw new Error(`no route ${route}`);
      }
    },
    subscribe: () => () => undefined,
  } as unknown as PluginClient;
  return { client, sent };
};

const hooks = (app as unknown as { readonly shell: { readonly hooks: AppHookProviders } }).shell.hooks;

interface CardAnswer {
  readonly subscribe: (listener: () => void) => () => void;
  readonly watch: (card: string) => () => void;
  readonly card: (card: string) => {
    readonly status: string;
    readonly missing: boolean;
    readonly title?: string;
    readonly closed: boolean;
  };
  readonly done: (
    card: string,
  ) => Promise<{ readonly ok: boolean; readonly status?: number; readonly message?: string }>;
  readonly start: (
    card: string,
    key: string,
  ) => Promise<{ readonly ok: boolean; readonly value?: { readonly started: boolean; readonly ferret: string } }>;
  readonly drop: (card: string, reason: string) => Promise<{ readonly ok: boolean; readonly message?: string }>;
}

const answerOver = (client: PluginClient): CardAnswer =>
  must(hooks['agenda.card-answer'])({ client, daemon: 'daemon/laptop' }) as CardAnswer;

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('the half provides no such hook');
  return value;
};

/** Watches `id` and lets the read land, as Agenda's ask does before it offers Done · closes. */
const read = async (answer: CardAnswer, id: string): Promise<void> => {
  answer.watch(id);
  await flush();
};

describe('the hooks Board provides to Agenda', () => {
  it('provides exactly the three Agenda offers, by name', () => {
    expect(Object.keys(hooks).sort()).toEqual(['agenda.card-answer', 'agenda.card-reference', 'agenda.lane-proposal']);
  });
});

describe('agenda.card-answer: Done · closes is the board’s own Done', () => {
  it('sends ONE move into the board’s Done lane, the request today’s Done sends', async () => {
    const { client, sent } = scripted([card('F1', { laneId: 'tested' })]);
    const answer = answerOver(client);
    await read(answer, 'F1');

    expect(await answer.done('F1')).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.route).toBe('POST /v1/board/cards/:cardId');
    expect(sent[0]?.cardId).toBe('F1');
    expect(sent[0]?.body).toEqual({ action: 'move', to: 'closed' });
  });

  it('sends ONE move for taps that overlap, and every tap gets that move’s outcome', async () => {
    const { client, sent } = scripted([card('F1', { laneId: 'tested' })]);
    const answer = answerOver(client);
    await read(answer, 'F1');

    const [first, second, third] = await Promise.all([answer.done('F1'), answer.done('f1'), answer.done('F1')]);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(sent).toHaveLength(1);
  });

  it('lets a later tap send again once the move has settled (a refused one is not remembered)', async () => {
    const { client, sent } = scripted([card('F1', { laneId: 'tested' })], {
      refuse: { status: 409, message: 'stale' },
    });
    const answer = answerOver(client);
    await read(answer, 'F1');

    expect(await answer.done('F1')).toMatchObject({ ok: false, status: 409, message: 'stale' });
    expect(await answer.done('F1')).toMatchObject({ ok: false, status: 409 });
    expect(sent).toHaveLength(2);
  });

  it('sends nothing for a card that is already closed, and counts it as closed', async () => {
    const { client, sent } = scripted([card('F1', { laneId: 'closed' })]);
    const answer = answerOver(client);
    await read(answer, 'F1');

    expect(answer.card('F1')).toMatchObject({ status: 'ready', missing: false, title: 'Card F1', closed: true });
    expect(await answer.done('F1')).toEqual({ ok: true });
    expect(sent).toEqual([]);
  });

  it('refuses, without a request, a card it has not read, a dropped one and one the board has no Done for', async () => {
    const dropped = card('F2', { laneId: 'tested', dropped: { at: '2026-08-01T10:00:00.000Z', reason: 'no' } });
    const unread = scripted([card('F1', { laneId: 'tested' })]);
    const droppedWorld = scripted([dropped]);
    // A card in a lane its board does not have: the board has no Done for it.
    const noDone = scripted([card('F3', { laneId: 'gone-lane' })]);

    const neverRead = answerOver(unread.client);
    const droppedAnswer = answerOver(droppedWorld.client);
    await read(droppedAnswer, 'F2');
    const noDoneAnswer = answerOver(noDone.client);
    await read(noDoneAnswer, 'F3');

    expect(await neverRead.done('F1')).toEqual({ ok: false, status: 0, message: 'the card could not be read' });
    expect(await droppedAnswer.done('F2')).toEqual({
      ok: false,
      status: 0,
      message: 'the board has no Done for this card',
    });
    expect(await noDoneAnswer.done('F3')).toEqual({
      ok: false,
      status: 0,
      message: 'the board has no Done for this card',
    });
    expect([...unread.sent, ...droppedWorld.sent, ...noDone.sent]).toEqual([]);
  });

  it('answers the daemon’s refusal in its own words: the route is the authority', async () => {
    const { client, sent } = scripted([card('F1', { laneId: 'tested' })], {
      refuse: { status: 403, message: 'only the owner closes this card' },
    });
    const answer = answerOver(client);
    await read(answer, 'F1');

    expect(await answer.done('F1')).toEqual({ ok: false, status: 403, message: 'only the owner closes this card' });
    expect(sent).toHaveLength(1);
  });

  it('says a card the board does not have is missing', async () => {
    const { client } = scripted([]);
    const answer = answerOver(client);
    await read(answer, 'F9');

    expect(answer.card('F9')).toMatchObject({ status: 'ready', missing: true, closed: false });
  });

  it('keeps one card view while the card is unchanged, so a reader re-renders only on a change', async () => {
    const { client } = scripted([card('F1', { laneId: 'tested' })]);
    const answer = answerOver(client);
    await read(answer, 'F1');

    expect(answer.card('F1')).toBe(answer.card('F1'));
    expect(answer.card('f1')).toBe(answer.card('F1'));
  });
});

describe('agenda.card-answer: a notice’s Start and Close', () => {
  it('starts a ferret with the click’s key and names it', async () => {
    const { client, sent } = scripted([card('F1')], { started: false });
    const answer = answerOver(client);

    expect(await answer.start('F1', 'click-1')).toEqual({
      ok: true,
      value: { started: false, ferret: 'mvuc7tsf-0c3d50df' },
    });
    expect(sent).toEqual([{ route: 'POST /v1/board/cards/:cardId/start', cardId: 'F1', key: 'click-1' }]);
  });

  it('closes a card with the board’s drop and the owner’s reason', async () => {
    const { client, sent } = scripted([card('F1')]);
    const answer = answerOver(client);

    expect(await answer.drop('F1', 'not needed any more')).toEqual({ ok: true });
    expect(sent.map(each => each.body)).toEqual([{ action: 'drop', reason: 'not needed any more' }]);
  });

  it('refuses an id that is not a card, and sends nothing', async () => {
    const { client, sent } = scripted([]);
    const answer = answerOver(client);

    expect(await answer.drop('not-a-card', 'x')).toMatchObject({ ok: false, message: 'that is not a card id' });
    expect(await answer.start('A3', 'k')).toMatchObject({ ok: false });
    expect(sent).toEqual([]);
  });
});

describe('agenda.lane-proposal: Edit opens the lane editor', () => {
  const editorFor = (
    must(hooks['agenda.lane-proposal'])({ client: scripted([]).client, daemon: 'daemon/laptop' }) as {
      readonly editorFor: (ask: { readonly sourceRef?: string | null }, answer: unknown) => string | undefined;
    }
  ).editorFor;
  const choose = (choice: string) => ({ kind: 'respond', response: { kind: 'multiple-choice', choice } });

  it('opens the project’s lanes on Edit, and nothing on Accept or for another ask', () => {
    expect(editorFor({ sourceRef: `lanes:${PROJECT}:2` }, choose('Edit'))).toBe(
      `/d/daemon%2Flaptop/board/${PROJECT}?lanes=1`,
    );
    expect(editorFor({ sourceRef: `lanes:${PROJECT}:2` }, choose('Accept'))).toBeUndefined();
    expect(editorFor({ sourceRef: 'gate:F1:1' }, choose('Edit'))).toBeUndefined();
    expect(editorFor({ sourceRef: null }, { kind: 'dismiss' })).toBeUndefined();
  });
});

describe('agenda.card-reference: `&F12` proves against this machine’s cards', () => {
  const referenceOver = (client: PluginClient) =>
    must(hooks['agenda.card-reference'])({ client, daemon: 'daemon/laptop' }) as {
      readonly watch: () => () => void;
      readonly proves: () => (id: string) => boolean;
      readonly href: (id: string) => string;
    };

  it('proves nothing before the ids are read, then exactly the ids the machine lists', async () => {
    const reference = referenceOver(scripted([card('F1'), card('F12')]).client);
    expect(reference.proves()('F12')).toBe(false);

    reference.watch();
    await flush();

    const proves = reference.proves();
    expect(proves('F12')).toBe(true);
    expect(proves('f1')).toBe(true);
    expect(proves('F13')).toBe(false);
    // The same proof while the list is unchanged.
    expect(reference.proves()).toBe(proves);
  });

  it('opens the card’s page, on the daemon the hook was built for', () => {
    expect(referenceOver(scripted([]).client).href('f12')).toBe('/d/daemon%2Flaptop/card/F12');
  });

  it('opens the daemon’s board, never a made-up page, for something that is not a card id', () => {
    const reference = referenceOver(scripted([]).client);
    expect(reference.href('../x')).toBe('/d/daemon%2Flaptop/board');
    expect(reference.href('F12/../../x')).toBe('/d/daemon%2Flaptop/board');
  });

  it('follows the hook’s daemon, not the address the reader happens to be on', () => {
    const location = (globalThis as { location?: unknown }).location;
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { pathname: '/d/elsewhere/agenda' } });
    try {
      expect(referenceOver(scripted([]).client).href('F12')).toBe('/d/daemon%2Flaptop/card/F12');
    } finally {
      Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
    }
  });
});
