import { sessionTarget } from './address.ts';

/**
 * WHICH PANE THIS IS, ALIVE OR DEAD — the one proof every reader of a registered pane uses.
 *
 * A registration pins a pane by its id and the pid it ran. A live pane is proven by both. A DEAD pane
 * cannot be, on every tmux: since 3.8 `#{pane_pid}` prints NOTHING once the pane's process is gone
 * (`format_cb_pane_pid` answers only while the pane still has its terminal), where 3.6a and 3.7 kept
 * printing the old pid. A reader that demanded the pid therefore never recognised a dead pane on 3.8 —
 * an agent whose harness exited stayed `running` for good.
 *
 * So the proof carries a second stamp that outlives the process: `#{session_created}`, the second the
 * pane's tmux session was made. Every agent runs in a session of its own made for that launch, its
 * registration is written moments later, and a pane id is never handed out twice by one server — so
 * the same pane id in a session created in the same second is the same pane. Wherever tmux still
 * prints a pid, the pid must match too.
 */
export const PANE_PROOF_FORMAT = '#{pane_id}|#{pane_pid}|#{pane_dead}|#{session_created}';

/** Ask tmux the {@link PANE_PROOF_FORMAT} of the pane `-t <session>` names. */
export function paneProofArguments(session: string): readonly string[] {
  return ['display-message', '-p', '-t', sessionTarget(session), PANE_PROOF_FORMAT];
}

/** What tmux says about a pane right now. */
export interface PaneSighting {
  readonly paneId: string;
  /** The pid the pane runs; absent for a dead pane on tmux 3.8 and later. */
  readonly pid?: number;
  readonly dead: boolean;
  /** The UNIX second the pane's session was created. */
  readonly sessionCreated?: number;
}

/** What a registration pins a pane by. `sessionCreated` is absent from one written before it was recorded. */
export interface PaneStamp {
  readonly paneId: string;
  readonly pid: number;
  readonly sessionCreated?: number;
}

const PANE_ID = /^%(?:0|[1-9][0-9]*)$/u;
const WHOLE = /^[1-9][0-9]*$/u;

const positive = (field: string): number | undefined => {
  if (!WHOLE.test(field)) return undefined;
  const value = Number(field);
  return Number.isSafeInteger(value) ? value : undefined;
};

/** Parse {@link PANE_PROOF_FORMAT}; `undefined` for anything that is not a pane tmux described. */
export function parsePaneSighting(output: string): PaneSighting | undefined {
  const fields = output.trimEnd().split('|');
  if (fields.length !== 4) return undefined;
  const [paneId = '', pidField = '', deadField = '', createdField = ''] = fields;
  if (!PANE_ID.test(paneId) || (deadField !== '0' && deadField !== '1')) return undefined;
  const pid = positive(pidField);
  // An empty pid is how tmux 3.8 describes a dead pane; any other unreadable one is not tmux's.
  if (pidField !== '' && (pid === undefined || pid <= 1)) return undefined;
  const sessionCreated = positive(createdField);
  return {
    paneId,
    dead: deadField === '1',
    ...(pid === undefined ? {} : { pid }),
    ...(sessionCreated === undefined ? {} : { sessionCreated }),
  };
}

/**
 * Whether `sighting` is the pane `stamp` registered: the same id, the same session creation second
 * when the stamp has one, and the same pid whenever tmux printed one. A pane with no pid is proven only
 * when it is dead AND the stamp's creation second matches — a registration written before the second
 * was recorded cannot prove a dead pane on tmux 3.8, and says nothing rather than guess.
 */
export function isRegisteredPane(sighting: PaneSighting, stamp: PaneStamp): boolean {
  if (sighting.paneId !== stamp.paneId) return false;
  if (stamp.sessionCreated !== undefined && sighting.sessionCreated !== stamp.sessionCreated) return false;
  if (sighting.pid !== undefined) return sighting.pid === stamp.pid;
  return sighting.dead && stamp.sessionCreated !== undefined;
}
