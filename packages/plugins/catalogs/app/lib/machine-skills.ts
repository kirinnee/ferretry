/**
 * The skills on ONE machine, path included: what My catalogs' Publish skills picker lists. The inventory (`GET /v1/skills`)
 * is Skills' route, and Catalogs declares no edge to Skills, so the loader is a seam the host fills and the default says
 * why nothing is listed. GAP(skills): Skills' app half offers the list through its contract.
 */

type Harness = 'claude' | 'codex' | 'generic';

/** One skill as Skills' inventory lists it (the fields the picker reads). */
export interface SkillEntry {
  readonly name: string;
  readonly description: string;
  readonly harness: Harness;
  readonly scope: string;
  /** Absolute path of the SKILL.md: what publishing takes. */
  readonly path: string;
  readonly runtimes: readonly string[];
  readonly project?: { readonly name: string; readonly root: string } | undefined;
  /** Set when a same-name skill of this scope wins over this one. */
  readonly shadowedBy?: string | undefined;
}

/** Reads this machine's skills, path included. A seam for the host, tests and the harness. */
export type MachineSkillEntriesLoader = (signal: AbortSignal) => Promise<readonly SkillEntry[]>;

/** The default loader: Catalogs has no route to the skills inventory, so it says so rather than listing nothing. */
export const noMachineSkills: MachineSkillEntriesLoader = () =>
  Promise.reject(new Error('Skills has not offered its list to Catalogs yet.'));
