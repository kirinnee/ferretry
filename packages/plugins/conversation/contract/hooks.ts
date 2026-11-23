import { defineHook } from '@ferretry/kernel/contract';
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { FerretIdSchema } from '@ferretry/core-ferrets/contract';
import type { TranscriptParser } from '@ferretry/core-mailbox/contract';
import type { WorkSource } from './wire-search.ts';

/** Takers change a message on its way to a ferret (§3.5). Taken by none yet. */
export const MessageBeforeSend = defineHook('message.before-send', {
  mode: 'transform',
  value: z.strictObject({ ferret: FerretIdSchema, text: z.string() }),
});

/** One round of a ferret working ended. Taken by Warden, Usage and Lessons. */
export const TurnEnded = defineHook('turn.ended', {
  mode: 'observe',
  payload: z.strictObject({
    ferret: FerretIdSchema,
    turn: z.string().min(1),
    outcome: z.enum(['completed', 'interrupted', 'failed']),
    endedAt: InstantSchema,
  }),
});

/**
 * More work for the work search (`fy search`, `search_work`, the related check): Board contributes its cards. Each
 * source hands over raw text, and Conversation scrubs it inside a redaction read before it is indexed or answered.
 */
export const SearchSources = defineHook('search.sources', { mode: 'contribute', item: z.custom<WorkSource>() });

/**
 * A harness plugin hands Conversation the parser for the transcript bytes it declares (`HarnessFacts.transcriptFormat`).
 * `claude` and `codex` are built in and cannot be replaced; a parser under any other id reads only a harness that names
 * that id. A harness with no parser here is read through its masked entries, never as another harness's format.
 */
export const TranscriptParsers = defineHook('transcript.parsers', {
  mode: 'contribute',
  item: z.custom<TranscriptParser>(),
});
