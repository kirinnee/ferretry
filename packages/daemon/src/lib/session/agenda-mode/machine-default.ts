/**
 * THE MACHINE'S DEFAULT FOR AGENDA MODE (docs/agenda.md § The machine default): `machine.yaml` `agendaMode`, on
 * unless the owner turned it off. It decides only for a ferret that is NEW and recorded no switch of its own, and
 * it is recorded as that ferret's own switch the moment it exists, so a ferret that already exists is never
 * touched by a later change of the default and a stored per-ferret value always wins.
 */

export interface AgendaDefaultPorts {
  /** The machine's switch as saved now; read per start so a saved change applies to the next one. */
  machineDefault(): Promise<boolean>;
  /** The switch the ferret recorded, or `undefined` when it recorded none (or is not known). */
  recorded(sessionId: string): Promise<boolean | undefined>;
  /** Records agenda mode ON on the ferret's document and in its launch environment. */
  enable(sessionId: string): Promise<void>;
}

/**
 * Records agenda mode ON for a new ferret when the machine's default is on, the ferret is an ordinary one and it
 * recorded no value. Returns whether it did. A ferret the daemon runs for itself (a miner, a warden, a clean-up)
 * keeps none, like Pack mode and lessons.
 */
export async function adoptAgendaDefault(
  ports: AgendaDefaultPorts,
  sessionId: string,
  eligible: boolean,
): Promise<boolean> {
  if (!eligible) return false;
  if ((await ports.recorded(sessionId)) !== undefined) return false;
  if (!(await ports.machineDefault())) return false;
  await ports.enable(sessionId);
  return true;
}
