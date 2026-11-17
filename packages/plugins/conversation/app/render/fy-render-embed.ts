/**
 * THE PAYLOAD OF A `task` OR `board` BLOCK: references to board tasks, read into a closed shape.
 *
 * These two types are the only `fy-render` blocks whose payload names something that LIVES — a task on
 * the board — rather than carrying bytes to draw. The payload is a reference (`&F12`), parsed by the
 * reference grammar's own token reader so there is no second spelling of a task id, and nothing else:
 * no title, no lane and no status is authored here, so a block can never say something the board does
 * not. What it shows is read from the board when it is drawn (`fy-render-embed.tsx`).
 *
 *   task    exactly one `&F12` (an older message spells the type `task`; the header reader hands it here as `task`)
 *   board   a list of `&F12` `&F13` … (spaces or lines, an optional leading `- `), or `parent: &F12`
 *           alone, which shows that task's children grouped by lane
 */

import { FY_RENDER_LIMITS, parseReferenceToken } from '@ferretry/app';

export type FyRenderEmbedSpec =
  | { readonly kind: 'card'; readonly id: string }
  | { readonly kind: 'cards'; readonly ids: readonly string[] }
  | { readonly kind: 'children'; readonly parent: string };

export type FyRenderEmbedParse =
  | { readonly ok: true; readonly spec: FyRenderEmbedSpec }
  | { readonly ok: false; readonly reason: string };

const PARENT_LINE = /^parent:\s*(\S+)$/u;
const LIST_MARK = /^-\s+/u;

const refuse = (reason: string): FyRenderEmbedParse => ({ ok: false, reason });

const taskId = (word: string): string | null => {
  const reference = parseReferenceToken(word);
  return reference?.kind === 'task' ? reference.id : null;
};

/** Every word of a payload, with list marks and blank lines dropped. */
const words = (payload: string): readonly string[] =>
  payload
    .split('\n')
    .map(line => line.trim().replace(LIST_MARK, ''))
    .filter(line => line !== '')
    .flatMap(line => line.split(/\s+/u));

export function parseFyRenderEmbed(type: 'task' | 'board', payload: string): FyRenderEmbedParse {
  if (new TextEncoder().encode(payload).length > FY_RENDER_LIMITS.embedBytes)
    return refuse('Task payload exceeds 2 KiB');
  const lines = payload
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '');
  if (lines.length === 0) return refuse(`A ${type} block needs a payload naming a task, such as &F12`);

  const parent = PARENT_LINE.exec(lines[0] ?? '');
  if (parent !== null) {
    if (type !== 'board') return refuse('Only a board block may name a parent');
    if (lines.length > 1) return refuse('A board names a parent or lists tasks, never both');
    const id = taskId(parent[1] ?? '');
    return id === null
      ? refuse(`"${parent[1]}" is not a task reference`)
      : { ok: true, spec: { kind: 'children', parent: id } };
  }

  const ids: string[] = [];
  for (const word of words(payload)) {
    const id = taskId(word);
    if (id === null) return refuse(`"${word}" is not a task reference`);
    if (ids.includes(id)) return refuse(`${id} is listed twice`);
    ids.push(id);
  }
  if (type === 'task') {
    const [only] = ids;
    if (ids.length !== 1 || only === undefined) return refuse('A task block names exactly one task');
    return { ok: true, spec: { kind: 'card', id: only } };
  }
  if (ids.length > FY_RENDER_LIMITS.embedCards)
    return refuse(`A board lists at most ${FY_RENDER_LIMITS.embedCards} tasks`);
  return { ok: true, spec: { kind: 'cards', ids } };
}
