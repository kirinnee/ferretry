import { hypermediaLaunchEnvironment } from '../hypermedia/lib/launch.ts';
import { StateHypermediaSwitch } from '../hypermedia/adapters/index.ts';
import { hypermediaDefault, SessionHypermediaService, sessionHypermediaRoutes } from '../hypermedia/lib/index.ts';
import { routeTable } from '../seams/api.ts';
import { tryParseSessionId } from '../seams/ferret-id.ts';
import type { ConversationFeature } from './types.ts';

/** The owner's hypermedia switch for a ferret: its route, and what a launch says about it. */
export default {
  id: 'hypermedia',
  register: f => {
    const { kernel, ferrets } = f;
    const hypermediaSwitch = new StateHypermediaSwitch(kernel.state);
    const hypermedia = new SessionHypermediaService({
      facts: async ferret => {
        const id = tryParseSessionId(ferret);
        const summary = id === undefined ? undefined : await ferrets.get(id);
        if (summary === undefined) return undefined;
        return {
          enabled: (await hypermediaSwitch.recorded(summary.id)) ?? hypermediaDefault(summary.mode),
          running: summary.state !== 'stopped',
        };
      },
      write: async (ferret, enabled, at) => await hypermediaSwitch.write(ferret, enabled, at),
      now: () => kernel.clock.now(),
    });
    return {
      routes: routeTable(
        sessionHypermediaRoutes({
          read: async ferret => await hypermedia.read(ferret),
          set: async (ferret, enabled) => await hypermedia.set(ferret, enabled),
        }),
      ),
      hooks: () => ({
        // What a launch says about hypermedia: only a switch the owner set, so a ferret with none keeps its mode default.
        'launch.parts': () => [
          {
            id: 'conversation-hypermedia',
            item: {
              parts: async spec => [
                {
                  kind: 'env' as const,
                  env: hypermediaLaunchEnvironment(await hypermediaSwitch.recorded(spec.ferret)),
                },
              ],
            },
          },
        ],
      }),
    };
  },
} satisfies ConversationFeature;
