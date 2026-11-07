import { LaneTemplateNameSchema } from '../../contract/index.ts';
import { refuse } from './errors.ts';

/** The refusal codes the daemon's board answers with (`error.code` of the refusal). */
const BOARD_CODES: ReadonlySet<string> = new Set([
  'invalid',
  'not-found',
  'forbidden',
  'conflict',
  'stale',
  'board-off',
  'owner-only',
  'version-conflict',
  'unknown-lane',
  'reason-required',
  'owner-gate',
  'blocked-by',
  'cycle',
  'no-lane-set',
]);

export interface RefusalContext {
  readonly binary: string;
  /** The board the call was aimed at, when the command knew it; named in the `lanes propose` command. */
  readonly project?: string | undefined;
}

/** The exact command that gives a project its lanes, so a refused create can be fixed by copying it. */
export function proposeLanesCommand(context: RefusalContext): string {
  const project = context.project === undefined ? '<project>' : context.project;
  return `${context.binary} board lanes propose --template <${LaneTemplateNameSchema.options.join('|')}> --project ${project}`;
}

/**
 * The line(s) a daemon board refusal prints: its own message (which already says what to do instead) and its code,
 * and the `lanes propose` command for a project with no lanes. `undefined` when the failure is not a board refusal,
 * so the caller leaves it alone. The shell's client hands the refusal as an error with the daemon's `code`.
 */
export function explainBoardRefusal(error: unknown, context: RefusalContext): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as Error & { readonly code?: unknown }).code;
  if (typeof code !== 'string' || !BOARD_CODES.has(code)) return undefined;
  const lines = [`${error.message} (${code})`];
  if (code === 'no-lane-set') lines.push('give the project lanes first:', `  ${proposeLanesCommand(context)}`);
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
