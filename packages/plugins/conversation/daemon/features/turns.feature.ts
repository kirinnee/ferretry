import { ApiError } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { err, ok } from '@ferretry/std';
import { TurnEnded } from '../../contract/index.ts';
import { SessionCompactAtError, SessionCompactAtService } from '../turns/compact-at/lib/service.ts';
import { TurnBoundaries } from '../turns/lib/index.ts';
import { sessionCompactAtRoutes } from '../turns/lib/mounts/session-compact-at.ts';
import { routeTable } from '../seams/api.ts';
import { parseSessionId, tryParseSessionId } from '../seams/ferret-id.ts';
import { built, type ConversationFeature } from './types.ts';

/** A ferret nobody knows has no setting to read (the port answers `undefined`); anything else is a real failure. */
const compactAtAbsent = (error: unknown): undefined => {
  if (error instanceof SessionCompactAtError && error.reason === 'not-found') return undefined;
  throw error;
};

/** The turn boundaries (what `turn.ended` announces), and the ferret's compaction trigger. */
export default {
  id: 'turns',
  register: f => {
    const { kernel, ferrets, hooks } = f;
    // The round that ends is announced to whoever takes `turn.ended`; Ferrets' own phase is what the daemon can see.
    const boundaries = new TurnBoundaries(boundary => {
      hooks.observe(TurnEnded, {
        ferret: parseSessionId(boundary.ferret),
        turn: boundary.turn,
        outcome: boundary.outcome,
        endedAt: boundary.endedAt as Instant,
      });
    });
    f.late.boundaries = boundaries;
    f.late.turns = {
      look: (ferret, phase) => {
        boundaries.look(ferret, phase, kernel.clock.now());
      },
      forget: ferret => {
        built(f.late.channelOutbox, 'channel outbox').forget(ferret);
        boundaries.forget(ferret);
      },
    };

    // The ferret's own compaction trigger is Ferrets' to record (its session config, which every launch and relaunch reads);
    // Conversation judges the value, words what it means for a running ferret and asks Ferrets to write it. The model's
    // window and the login's default are not reachable from here: a value the model cannot honour is dropped at launch.
    const compactAtSetting = new SessionCompactAtService({
      // The caller is the ferret behind the call, when it is one: Ferrets applies its `mayTouch` rule to the read and the
      // write, and the read comes first, so a refused caller never reaches the store.
      facts: async (ferret, caller) => {
        const id = tryParseSessionId(ferret);
        const summary = id === undefined ? undefined : await ferrets.get(id);
        if (summary === undefined) return undefined;
        return {
          own: await ferrets.compactAt?.(summary.id, caller === undefined ? undefined : parseSessionId(caller)),
          accountDefault: undefined,
          window: undefined,
          running: summary.state !== 'stopped',
        };
      },
      write: async (ferret, value, _at, caller) => {
        if (ferrets.setCompactAt === undefined)
          throw new ApiError(503, 'Ferrets cannot record the compact-at setting right now.', 'plugin_unavailable');
        await ferrets.setCompactAt(
          parseSessionId(ferret),
          value,
          caller === undefined ? undefined : parseSessionId(caller),
        );
      },
      now: () => kernel.clock.now(),
    });

    return {
      routes: routeTable(
        sessionCompactAtRoutes({
          get: async (ferret, caller) => await compactAtSetting.get(ferret, caller),
          set: async (ferret, wanted, caller) => await compactAtSetting.set(ferret, wanted, caller),
        }),
      ),
      port: {
        currentTurn: async ferret => boundaries.current(ferret),
        compactAt: async ferret => await compactAtSetting.get(ferret).catch(compactAtAbsent),
        setCompactAt: async (ferret, patch) => {
          try {
            return ok(await compactAtSetting.set(ferret, patch.compactAt));
          } catch (error) {
            if (error instanceof SessionCompactAtError)
              return err({
                code: error.reason === 'not-found' ? 'not-found' : 'invalid_compact_at',
                message: error.message,
              });
            if (error instanceof ApiError)
              return err({ code: error.code ?? 'compact_at_refused', message: error.message });
            throw error;
          }
        },
      },
    };
  },
} satisfies ConversationFeature;
