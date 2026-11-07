/**
 * The port over `state/skills/installs.json` (schemas live in the contract). DAMAGED IS NOT EMPTY: a file that will
 * not read raises, because answering "no copies" would forget every recorded hash and let a changed file be
 * overwritten.
 */
import type { LocalSkillInstallState } from '../../../contract/index.ts';

export { LocalSkillInstallStateSchema } from '../../../contract/index.ts';
export type {
  LocalSkillInstalledFile,
  LocalSkillInstallRecord,
  LocalSkillInstallState,
} from '../../../contract/index.ts';

export const EMPTY_LOCAL_SKILL_INSTALL_STATE: LocalSkillInstallState = { format: 1, installs: [] };

/** The file could not be read as this daemon writes it. Never answered as "no copies". */
export class LocalSkillInstallStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalSkillInstallStateError';
  }
}

export interface LocalSkillInstallStore {
  /** The state; an empty one when there is no file yet. Throws {@link LocalSkillInstallStateError} on a damaged file. */
  read(): Promise<LocalSkillInstallState>;
  write(state: LocalSkillInstallState): Promise<void>;
}
