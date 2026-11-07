import { ALLOW, type StateFileDef } from '@ferretry/kernel/contract';
import { implementDaemon, type ToolResult } from '@ferretry/kernel/manifest';
import { milliseconds, type Result } from '@ferretry/std';
import type { ConfigFileDef } from '@ferretry/kernel/contract';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import {
  type BoardApi,
  type BoardRefusal,
  CardAskRefSchema,
  type Card,
  type CardActionRequest,
  type CardActor,
  CardMoving,
  CardProgressToolInputSchema,
  type CardView,
} from '../contract/index.ts';
import type { BoardConfig } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { CARD_SOURCE } from './adapters/asks.ts';
import { assemble, type BoardDefs } from './wiring.ts';
import { type BoardCaller, BoardError, BOARD_SWEEP_INTERVAL_MS } from './lib/board/index.ts';
import { GITHUB_WATCH_JOB_ID } from './lib/github/index.ts';
import { boardRoutes } from './routes/board.ts';
import { boardProjectRoutes } from './routes/lanes.ts';
import { reraiseBoardError } from './routes/http.ts';

const stateOf = (name: string): StateFileDef =>
  manifest.data.state.find(file => file.name === name) as unknown as StateFileDef;

const refusalOf = (error: unknown): BoardRefusal => {
  if (error instanceof BoardError) {
    const code: BoardRefusal['code'] =
      error.code === 'not-found'
        ? 'not-found'
        : error.code === 'forbidden' || error.code === 'owner-gate'
          ? 'forbidden'
          : error.code === 'invalid'
            ? 'invalid'
            : 'refused';
    return { code, message: error.message };
  }
  throw error;
};

const actorOf = (caller: BoardCaller): CardActor =>
  caller.kind === 'owner'
    ? { kind: 'owner' }
    : caller.kind === 'ferret'
      ? { kind: 'ferret', ferret: caller.ferret }
      : { kind: 'daemon' };

/**
 * Board's daemon half (§2.3): cards and lanes for the work you ask for, with each card's progress and its PRs.
 *
 * #1552: a card is read-only status. It never asks; its gate entry is an obligation Asks shows (`ask.sources:card`),
 * and an answer to it moves the card first, as the owner, before the ask is closed.
 */
export default implementDaemon(manifest, {
  build: ctx => {
    const { kernel } = ctx;
    const defs: BoardDefs = {
      cards: stateOf('cards') as BoardDefs['cards'],
      counters: stateOf('counters') as BoardDefs['counters'],
      boards: stateOf('boards') as BoardDefs['boards'],
      sweep: stateOf('sweep') as BoardDefs['sweep'],
      focus: stateOf('focus') as BoardDefs['focus'],
      config: manifest.data.config[0] as unknown as ConfigFileDef<BoardConfig>,
    };
    const world = assemble({
      kernel,
      asks: ctx.needs.asks,
      ferrets: ctx.needs.ferrets,
      projects: () => ctx.uses.projects.current(),
      moving: async () => ALLOW,
      product: 'ferretry',
      version: manifest.version,
      defs,
    });
    const { service } = world;

    // `card.moving`: takers say yes or no to a card changing lanes; the first no wins, with its reason.
    const movingGuard = async (id: Card['id'], request: CardActionRequest, caller: BoardCaller): Promise<void> => {
      if (request.action !== 'move' && request.action !== 'reopen') return;
      const from = (await service.card(id)).card.laneId;
      const decision = await ctx.hooks.decide(CardMoving, { card: id, from, to: request.to, by: actorOf(caller) });
      if (!decision.allow) throw new BoardError('forbidden', decision.reason);
    };
    const acting = {
      board: (query: Parameters<typeof service.board>[0]) => service.board(query),
      ids: () => service.ids(),
      mergeGate: (pr: string) => service.mergeGate(pr),
      card: (id: Card['id']) => service.card(id),
      create: (request: Parameters<typeof service.create>[0], caller: BoardCaller) => service.create(request, caller),
      act: async (id: Card['id'], request: CardActionRequest, caller: BoardCaller) => {
        await movingGuard(id, request, caller);
        return await service.act(id, request, caller);
      },
      skip: (request: Parameters<typeof service.skip>[0], caller: BoardCaller) => service.skip(request, caller),
      start: world.start,
    };

    const api: BoardApi = {
      card: async id => {
        try {
          return (await service.card(id)).card;
        } catch (error) {
          if (error instanceof BoardError && error.code === 'not-found') return undefined;
          throw error;
        }
      },
      cards: async query => (await service.board(query)).cards,
      create: async (by, request) => await settle(async () => (await service.create(request, callerOf(by))).card),
      act: async (by, id, request) => await settle(async () => (await acting.act(id, request, callerOf(by))).card),
      progress: async (by, id, parts) =>
        await settle(async () => (await acting.act(id, { action: 'edit', progress: parts }, callerOf(by))).card),
      heldBy: world.heldBy,
      switchOf: async project => await world.switches.read(project as never),
    };

    // ── jobs: the sweep, the gates' reconcile, the GitHub watch ─────────────────────────────────────────────────
    kernel.jobs.add({
      id: 'board-sweep',
      schedule: { every: milliseconds(BOARD_SWEEP_INTERVAL_MS) },
      run: async () => {
        await world.sweepTick();
      },
    });
    kernel.jobs.add({
      id: 'board-gates',
      schedule: { onceAfterStart: true },
      run: async () => {
        await world.gateReconcile();
      },
    });
    if (world.watchEnabled())
      kernel.jobs.add({
        ...world.watch.job,
        id: GITHUB_WATCH_JOB_ID,
        schedule: { every: milliseconds(world.watchEvery()) },
      });

    const lanes = boardProjectRoutes(world.lanes, world.switches, {
      nameOf: async ferret => (await ctx.needs.ferrets.get(ferret as FerretId))?.name ?? ferret,
      helperRefusal: async ferret => {
        const lead = await world.helpers.leadOf(ferret);
        return lead === undefined ? null : "You are a helper, so you can't edit the board lanes. Ask your lead.";
      },
    });

    return {
      routes: { ...boardRoutes(acting), ...lanes },
      tools: {
        card_progress: async (call, input): Promise<ToolResult> => {
          const parsed = CardProgressToolInputSchema.safeParse(input);
          if (!parsed.success)
            return { text: 'card_progress takes a card and any of now, doneSoFar, next', isError: true };
          if (call.credential?.tokenClass !== 'ferret')
            return { text: 'only a ferret writes a card’s progress', isError: true };
          const { card, ...parts } = parsed.data;
          const result = await api.progress(call.credential.ferret, card, parts);
          return result.ok ? { text: `${card} progress written` } : { text: result.error.message, isError: true };
        },
      },
      provides: { board: api },
      hooks: {
        'ask.sources:card': { schema: CardAskRefSchema, title: '{card}', form: false, apply: world.applyAnswer },
        'start.decide': () => ALLOW,
        'sitrep.lines': () => [{ id: 'board', order: 50, item: { lines: async ferret => await world.lines(ferret) } }],
      },
      subscribers: {
        'asks.answered': async wake => {
          const answers = await ctx.needs.asks.answers({ source: wake.source, entry: wake.entry });
          const answer = answers.find(each => each.id === wake.answerId);
          if (answer === undefined) return;
          if (wake.source === CARD_SOURCE) return; // applied by the source's own `apply`, before the answer was recorded
          // A lane proposal's Accept (a daemon ask whose entry names the project and version).
          await world.proposalAcceptance.answered({
            source: answer.source,
            entry: answer.entry,
            effect: answer.effect,
            choice: answer.choice,
          });
        },
      },
    };
  },
});

const callerOf = (by: string): BoardCaller => (by === 'owner' ? { kind: 'owner' } : { kind: 'ferret', ferret: by });

const settle = async <T>(work: () => Promise<T>): Promise<Result<T, BoardRefusal>> => {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: refusalOf(error) };
  }
};

void reraiseBoardError;
export type { CardView };
