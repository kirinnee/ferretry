import { z } from 'zod';

/**
 * The Global lessons document: the rules every ferret reads at its next launch (`launch.parts`). Today it is a file the
 * owner edits in any editor (`<assets>/instructions/lessons.md`); here it is this plugin's own state, so the owner reads
 * and rewrites it through `GET` / `PUT /v1/lessons/global` (Settings › Lessons, `fy lesson global`). That is how an
 * applied Global lesson is changed or removed. It is not a file on disk, so it is shown by this name, never by a path.
 */
export const GLOBAL_LESSONS_DOCUMENT = 'Global lessons document';

/** The most a Global document may hold: it is read into every launch. */
export const MAX_GLOBAL_LESSONS_CHARS = 64_000;

/** `GET /v1/lessons/global`: the document (empty before the first Apply) and the etag a write must name. */
export const LessonsGlobalDocumentSchema = z.strictObject({
  name: z.literal(GLOBAL_LESSONS_DOCUMENT),
  text: z.string(),
  etag: z.string().min(1),
  notes: z.array(z.string()),
});
export type LessonsGlobalDocument = z.infer<typeof LessonsGlobalDocumentSchema>;

/**
 * `PUT /v1/lessons/global {text, etag}`: the owner's whole new document, written only if it still has the etag the owner
 * read (`409 apply_conflict` otherwise). Empty text removes every rule.
 */
export const LessonsGlobalWriteSchema = z.strictObject({
  text: z.string().max(MAX_GLOBAL_LESSONS_CHARS),
  etag: z.string().min(1),
});
export type LessonsGlobalWrite = z.infer<typeof LessonsGlobalWriteSchema>;

/** The rules in a Global document: each `- ` bullet, in order (an Apply writes one bullet per lesson). */
export function globalLessonRules(text: string): readonly string[] {
  return text
    .split('\n')
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim());
}

/**
 * `text` with its `number`th rule (1-based, as `globalLessonRules` counts) reworded to `rule`, or removed when `rule` is
 * `undefined`. `undefined` when there is no such rule. Every other line is kept as it is.
 */
export function withGlobalLessonRule(text: string, number: number, rule: string | undefined): string | undefined {
  const lines = text.split('\n');
  let seen = 0;
  const index = lines.findIndex(line => line.startsWith('- ') && ++seen === number);
  if (index < 0 || !Number.isInteger(number) || number < 1) return undefined;
  if (rule === undefined) lines.splice(index, 1);
  else lines[index] = `- ${rule.replace(/\s+/gu, ' ').trim()}`;
  return lines.join('\n');
}
