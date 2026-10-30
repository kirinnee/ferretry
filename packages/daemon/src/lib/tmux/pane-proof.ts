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
 * Whether `sighting` is the pane `stamp` registered:
 *
 * - `proven`: the same id, the same session creation second when the stamp has one, and the same pid
 *   whenever tmux printed one. A pane with no pid is proven only when it is dead AND the creation
 *   second matches.
 * - `pane-id-only`: a DEAD pane with no pid against a stamp written before the creation second was
 *   recorded — the same id in the session the registration names, and nothing more to check it by.
 *   The caller must say that this is all it rests on, never pass it off as `proven`.
 * - `refuted`: anything else, which says nothing about the registered pane.
 */
export function provePane(sighting: PaneSighting, stamp: PaneStamp): 'proven' | 'pane-id-only' | 'refuted' {
  if (sighting.paneId !== stamp.paneId) return 'refuted';
  if (stamp.sessionCreated !== undefined && sighting.sessionCreated !== stamp.sessionCreated) return 'refuted';
  if (sighting.pid !== undefined) return sighting.pid === stamp.pid ? 'proven' : 'refuted';
  if (!sighting.dead) return 'refuted';
  return stamp.sessionCreated === undefined ? 'pane-id-only' : 'proven';
}

/**
 * The creation second to add to a stamp written before it was recorded, or `undefined` when there is
 * nothing to add or nothing to prove it by. Only a LIVE pane whose id and pid both match the stamp
 * earns it: that is the registered pane by the old proof, so its session's second is the one the
 * registration would have recorded — and once recorded, it still proves the pane after it dies on
 * tmux 3.8, where the pid is gone.
 */
export function stampToRecord(sighting: PaneSighting, stamp: PaneStamp): number | undefined {
  if (stamp.sessionCreated !== undefined || sighting.dead) return undefined;
  if (sighting.paneId !== stamp.paneId || sighting.pid !== stamp.pid) return undefined;
  return sighting.sessionCreated;
}
