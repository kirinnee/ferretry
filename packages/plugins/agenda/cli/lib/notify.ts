import { z } from 'zod';

/** The most a summary or title may carry, and the most a body may (today's agenda limits). */
const MAX_SUBJECT_LENGTH = 240;
const MAX_BODY_LENGTH = 200_000;
/** A push title is clipped here; the notice's card title is the summary cut to it. */
const PUSH_TITLE_LENGTH = 40;

/**
 * What `fy notify` posts to the ferret's board route (Asks'): a plain notice with no answers and no turn. The wire field
 * for "buzz the phone" keeps its name; only the flag is `--buzz`.
 */
export const NoticeRequestSchema = z.strictObject({
  action: z.literal('add'),
  source: z.literal('agent-raised'),
  sourceRef: z.null(),
  subject: z.string().min(1).max(MAX_SUBJECT_LENGTH),
  title: z.string().min(1).max(MAX_SUBJECT_LENGTH),
  kind: z.literal('info'),
  why: z.string().min(1),
  context: z.null(),
  howToResolve: z.string().min(1),
  surface: z.literal(true),
  notice: z.literal(true),
  /** The ferret asked for the phone to buzz. */
  ping: z.literal(true).optional(),
  body: z.string().min(1).max(MAX_BODY_LENGTH).optional(),
});
export type NoticeRequest = z.infer<typeof NoticeRequestSchema>;

export interface NoticeFlags {
  readonly body?: string | undefined;
  readonly buzz?: boolean | undefined;
}

/** What a notice's `howToResolve` says: reading it is all it asks. */
const CLEARS_WHEN = 'Read it in the agenda; opening it clears it.';

/** A trimmed value, or nothing when it was absent or blank. */
function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? undefined : trimmed;
}

/** The start of `line` that fits `limit`, cut at a word where one exists, with an ellipsis when cut. */
function clip(line: string, limit: number): string {
  if (line.length <= limit) return line;
  const cut = line.slice(0, limit - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The request for one notice: the summary is the whole notice and the title of its card; `--body` is the longer reading
 * behind it. A summary is one line, so a second line is refused rather than lost.
 */
export function composeNoticeRequest(words: readonly string[], flags: NoticeFlags): NoticeRequest {
  const summary = text(words.join(' '));
  if (summary === undefined) throw new Error('notify needs a summary: one line saying what the owner should know');
  if (/[\r\n]/u.test(summary)) throw new Error('the summary is one line — put the rest in --body');
  if (summary.length > MAX_SUBJECT_LENGTH)
    throw new Error(
      `the summary is ${String(summary.length)} characters; keep it to ${String(MAX_SUBJECT_LENGTH)} and put the rest in --body`,
    );
  const body = text(flags.body);
  if (body !== undefined && body.length > MAX_BODY_LENGTH)
    throw new Error(`--body is ${String(body.length)} characters; the most it takes is ${String(MAX_BODY_LENGTH)}`);
  const line = summary.replaceAll(/\s+/gu, ' ');
  return NoticeRequestSchema.parse({
    action: 'add',
    source: 'agent-raised',
    sourceRef: null,
    subject: line,
    title: clip(line, PUSH_TITLE_LENGTH),
    kind: 'info',
    why: line,
    context: null,
    howToResolve: CLEARS_WHEN,
    surface: true,
    notice: true,
    ...(flags.buzz === true ? { ping: true } : {}),
    ...(body === undefined ? {} : { body }),
  });
}
