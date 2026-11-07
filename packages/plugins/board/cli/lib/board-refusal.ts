import { BoardErrorCodeSchema, LaneTemplateNameSchema } from '../../contract/index.ts';
import { refuse } from './errors.ts';

/** Who a board standing is, in words. The daemon sends the standing names; a person reads these. */
const STANDING_WORDS: Readonly<Record<string, string>> = {
  'owner-human': 'the owner (a person, from the app or the CLI outside a ferret)',
  owner: "the card's owner ferret",
  ancestor: "a ferret above the card's owner (its lead)",
  'assignee-lead': "a ferret above the card's assignee (for drop and reassign only)",
  assignee: 'the ferret it is assigned to',
  daemon: 'the daemon itself',
  reader: 'anyone who can read the board',
};

export interface RefusalContext {
  readonly binary: string;
  /** The board the call was aimed at, when the command knew it; named in the `lanes propose` command. */
  readonly project?: string | undefined;
}

/** The standings the daemon listed as able to do it, whether the shell kept the refusal's body or only its `allowed`. */
const allowedStandings = (error: Error): readonly string[] => {
  const carrier = error as Error & { readonly allowed?: unknown; readonly body?: unknown };
  const body = typeof carrier.body === 'object' && carrier.body !== null ? (carrier.body as { allowed?: unknown }) : {};
  const allowed = carrier.allowed ?? body.allowed;
  return Array.isArray(allowed) ? allowed.filter((entry): entry is string => typeof entry === 'string') : [];
};

/** The exact command that gives a project its lanes, so a refused create can be fixed by copying it. */
export function proposeLanesCommand(context: RefusalContext): string {
  const project = context.project === undefined ? '<project>' : context.project;
  return `${context.binary} board lanes propose --template <${LaneTemplateNameSchema.options.join('|')}> --project ${project}`;
}

/**
 * The line(s) a daemon board refusal prints: its own message (which already says what to do instead), who may do it
 * when the refusal is about authority, and the `lanes propose` command for a project with no lanes. `undefined` when
 * the failure is not a board refusal, so the caller leaves it alone. The shell's client hands the refusal as an error
 * with the daemon's `code`.
 */
export function explainBoardRefusal(error: unknown, context: RefusalContext): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as Error & { readonly code?: unknown }).code;
  const known = BoardErrorCodeSchema.safeParse(code);
  if (!known.success) return undefined;
  const lines = [`${error.message} (${known.data})`];
  const allowed = allowedStandings(error);
  if (allowed.length > 0) {
    lines.push('who may do this instead:', ...allowed.map(standing => `  - ${STANDING_WORDS[standing] ?? standing}`));
  }
  if (known.data === 'no-lane-set') lines.push('give the project lanes first:', `  ${proposeLanesCommand(context)}`);
  return lines.join('\n');
}

/** Runs a daemon call, turning a board refusal into a CLI refusal; every other failure propagates unchanged. */
export async function explainingRefusals<Value>(context: RefusalContext, work: () => Promise<Value>): Promise<Value> {
  try {
    return await work();
  } catch (error) {
    const explained = explainBoardRefusal(error, context);
    if (explained === undefined) throw error;
    return refuse(explained);
  }
}
