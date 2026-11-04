/**
 * A card's status as the CLI writes it: three Markdown parts (`now`, `doneSoFar`, `next`), sent whole. The wire has no
 * partial status, so `--status-now` / `--status-done` / `--status-next` are merged here over the card's current
 * status (or over `--status-file`), and the whole object goes in one edit.
 *
 * Pure: text and values in, a status or a refusal out. Reading the file and the card is the controller's.
 */
import { type BoardStatus, BoardStatusSchema } from '@ferretry/protocol';
import { readConfigText } from '@ferretry/fleet/config-text';
import { refuse } from '../tasks/errors';

const PARTS = ['now', 'doneSoFar', 'next'] as const;

/** The parts a caller named with `--status-now`, `--status-done` and `--status-next`. */
export type StatusParts = Partial<Record<(typeof PARTS)[number], string>>;

const EMPTY: BoardStatus = { now: '', doneSoFar: '', next: '' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `--status-file`: YAML or JSON (JSON is YAML) holding `{ now, doneSoFar, next }`. A part left out, or written with no
 * value, is empty; a key it does not know is refused so a typo cannot drop a part.
 */
export function parseStatusFile(text: string, path: string): BoardStatus {
  if (text.trim() === '') return refuse(`${path} is empty: it must hold { now, doneSoFar, next }`);
  const read = readConfigText(text);
  if (!read.ok) {
    const first = read.errors[0];
    const at = first?.position === undefined ? '' : ` (line ${String(first.position.line)})`;
    return refuse(`cannot read ${path} as YAML or JSON${at}: ${first?.message ?? 'syntax error'}`);
  }
  const value = read.read.value;
  if (!isRecord(value)) return refuse(`${path} must hold { now, doneSoFar, next }, each a Markdown string`);
  const unknown = Object.keys(value).filter(key => !(PARTS as readonly string[]).includes(key));
  if (unknown.length > 0) return refuse(`${path} has unknown keys (${unknown.join(', ')}): use now, doneSoFar, next`);
  const given = (part: (typeof PARTS)[number]): string => {
    const part_ = value[part];
    if (part_ === undefined || part_ === null) return '';
    return typeof part_ === 'string' ? part_ : refuse(`${path}: ${part} must be a Markdown string`);
  };
  return checked({ now: given('now'), doneSoFar: given('doneSoFar'), next: given('next') });
}

/** `base` (the file, else the card's current status, else nothing) with each named part replaced. */
export function mergeStatus(base: BoardStatus | undefined, parts: StatusParts): BoardStatus {
  const from = base ?? EMPTY;
  return checked({
    now: parts.now ?? from.now,
    doneSoFar: parts.doneSoFar ?? from.doneSoFar,
    next: parts.next ?? from.next,
  });
}

const checked = (status: BoardStatus): BoardStatus => {
  const parsed = BoardStatusSchema.safeParse(status);
  return parsed.success
    ? parsed.data
    : refuse(`cannot set the status: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
};
