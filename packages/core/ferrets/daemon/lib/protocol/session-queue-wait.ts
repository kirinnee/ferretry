import { z } from 'zod';

/*
 * Its own module so both the queue (`session-queue.ts`) and the send answer (`session.ts`, `SendResult`)
 * can name it: the queue already imports the send vocabulary, so the answer importing the queue back would
 * be a cycle.
 */

/**
 * Why a `queued` message has not gone yet, in words a person can act on. Absent when nothing is in its way
 * but its turn: another message ahead of it.
 */
export const QueueWaitReasonSchema = z.enum([
  /** The agent is still starting. */
  'launching',
  /** The agent is mid-turn and its own queue cannot take the message yet. */
  'busy',
  /** The agent asked a question, and only its answer may go into the pane. */
  'question',
  /** A harness dialog (trust, permission, rate limit) holds the pane. */
  'dialog',
  /** The composer holds text that is not this message: a person's draft, most often. */
  'draft',
  /** The pane could not be read well enough to prove the composer empty. */
  'unreadable',
  /** The session is not running; it is delivered when it is revived. */
  'stopped',
]);
