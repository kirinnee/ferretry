/**
 * THE ONE-TIME IMPORT of the old per-session task files into the project boards, on the wire.
 *
 * `POST /v1/board/import` runs it (or, with `dryRun`, only says what it would do) and answers with
 * {@link BoardImportSummarySchema}. It is the same import the daemon runs once at start; running it again
 * is safe, because a task that already has a card is never imported twice.
 */
import { z } from 'zod';
import { BoardProjectIdSchema } from './board-refs.ts';

export const BoardImportRequestSchema = z.strictObject({
  /** Count what would happen and change nothing: no card, no lane proposal, no link, no marker. */
  dryRun: z.boolean().optional(),
});
export type BoardImportRequest = z.infer<typeof BoardImportRequestSchema>;

/** A thing the import skipped or could not do. Never fatal. */
export const BoardImportProblemSchema = z.strictObject({
  sessionId: z.string().min(1).nullable(),
  taskId: z.string().min(1).nullable(),
  detail: z.string().min(1),
});
export type BoardImportProblem = z.infer<typeof BoardImportProblemSchema>;

export const BoardImportSummarySchema = z.strictObject({
  dryRun: z.boolean(),
  /** The import had already run and was not forced; nothing else here applies. */
  skipped: z.boolean(),
  /** Sessions with an old task file. */
  sessions: z.number().int().min(0),
  /** Cards written (dry run: to be written). */
  imported: z.number().int().min(0),
  /** Old tasks that already had a card, left exactly as they are. */
  alreadyImported: z.number().int().min(0),
  /** Projects given an unconfirmed lane proposal. */
  proposedProjects: z.array(BoardProjectIdSchema),
  /** Agenda items pointed at a card. */
  linkedAsks: z.number().int().min(0),
  /** "Untriaged asks" cards created. */
  untriagedCards: z.number().int().min(0),
  problems: z.array(BoardImportProblemSchema),
  /** Everything that could be done was, and the marker was recorded (never in a dry run). */
  complete: z.boolean(),
});
export type BoardImportSummary = z.infer<typeof BoardImportSummarySchema>;
