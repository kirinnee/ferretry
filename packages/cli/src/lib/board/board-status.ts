/**
 * A card's status as the CLI writes it: three Markdown parts (`now`, `doneSoFar`, `next`). `--status-file` gives all
 * three (a part it leaves out is empty); `--status-now` / `--status-done` / `--status-next` replace one part each,
 * over the file when there is one. Only the parts named are sent: the daemon merges them into the card's current
 * status in the card's own write.
 *
 * Pure: text and values in, a status or a refusal out. Reading the file and the card is the controller's.
 */
import { type BoardStatus, BoardStatusSchema } from '@ferretry/protocol';
import { readConfigText } from '@ferretry/fleet/config-text';
import { refuse } from '../tasks/errors';

const PARTS = ['now', 'doneSoFar', 'next'] as const;

/** The parts a caller named with `--status-now`, `--status-done` and `--status-next`. */
export type StatusParts = Partial<Record<(typeof PARTS)[number], string>>;

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

/** `base` (the file's three parts) with each named part replaced; without a file, only the named parts. */
export function mergeStatus(base: BoardStatus | undefined, parts: StatusParts): StatusParts {
  return checked(base === undefined ? parts : { ...base, ...parts });
}

const checked = <Status extends StatusParts>(status: Status): Status => {
  const parsed = BoardStatusSchema.partial().safeParse(status);
  return parsed.success ? status : refuse(`cannot set the status: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
};
