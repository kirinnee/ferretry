/**
 * A card's progress as the CLI writes it: three Markdown parts (`now`, `doneSoFar`, `next`). `--file` gives all three
 * (a part it leaves out is empty); `--now` / `--done` / `--next` replace one part each, over the file when there is
 * one. Only the parts named are sent: the daemon merges them into the card's current progress in the card's own write.
 *
 * Pure: text and values in, parts or a refusal out. Reading the file and the card is the controller's.
 */
import { ProgressSchema } from '../../contract/index.ts';
import { refuse } from './errors.ts';
import { readPatchText } from './patch-document.ts';

const PARTS = ['now', 'doneSoFar', 'next'] as const;

/** The parts a caller named with `--now`, `--done` and `--next`. */
export type ProgressParts = Partial<Record<(typeof PARTS)[number], string>>;

/**
 * `--file`: YAML or JSON (JSON is YAML) holding `{ now, doneSoFar, next }`. A part left out, or written with no value,
 * is empty; a key it does not know is refused so a typo cannot drop a part.
 */
export function parseProgressFile(text: string, path: string): Required<ProgressParts> {
  if (text.trim() === '') return refuse(`${path} is empty: it must hold { now, doneSoFar, next }`);
  const read = readPatchText(text, path);
  if (!read.ok) {
    if (read.problem.includes('is not YAML or JSON'))
      return refuse(read.problem.replace(' is not YAML or JSON', ' cannot be read as YAML or JSON'));
    // A document that parsed but would not become a value (an alias bomb) keeps the reader's own sentence.
    if (read.problem.includes('could not be read as a patch')) return refuse(read.problem);
    return refuse(`${path} must hold { now, doneSoFar, next }, each a Markdown string`);
  }
  const value = read.value;
  const unknown = Object.keys(value).filter(key => !(PARTS as readonly string[]).includes(key));
  if (unknown.length > 0) return refuse(`${path} has unknown keys (${unknown.join(', ')}): use now, doneSoFar, next`);
  const given = (part: (typeof PARTS)[number]): string => {
    const written = value[part];
    if (written === undefined || written === null) return '';
    return typeof written === 'string' ? written : refuse(`${path}: ${part} must be a Markdown string`);
  };
  return checked({ now: given('now'), doneSoFar: given('doneSoFar'), next: given('next') });
}

/** `base` (the file's three parts) with each named part replaced; without a file, only the named parts. */
export function mergeProgress(base: Required<ProgressParts> | undefined, parts: ProgressParts): ProgressParts {
  return checked(base === undefined ? parts : { ...base, ...parts });
}

const checked = <Progress extends ProgressParts>(progress: Progress): Progress => {
  const parsed = ProgressSchema.partial().safeParse(progress);
  return parsed.success ? progress : refuse(`cannot set the progress: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
};
