import { forkRoute } from '../fork/fork-route.ts';
import { built, type ConversationFeature } from './types.ts';

/**
 * Fork a ferret into a new one from a message of its conversation (c58-37 PR11). Conversation owns the route because it
 * owns the message selection (the binding it issued on a transcript row), the attachments it copies and the form that
 * asks; Ferrets owns the cut and the start (`FerretsApi.forks`), which is only ever handed to this plugin.
 */
export default {
  id: 'fork',
  register: f => ({
    routes: {
      'POST /v1/ferrets/:ferretId/fork': forkRoute({
        forks: () => f.ferrets.forks,
        selectTurn: async (ferret, point, binding) =>
          await built(f.late.reading, 'reader').forkTurn(ferret, point, binding),
        copyAttachments: async (from, to) => await built(f.late.reading, 'reader').copyAttachments(from, to),
      }),
    },
  }),
} satisfies ConversationFeature;
