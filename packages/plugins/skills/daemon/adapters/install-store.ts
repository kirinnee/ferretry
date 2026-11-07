import type { StatePort } from '@ferretry/kernel/contract';
import { SKILLS_INSTALLS_STATE } from '../../contract/index.ts';
import {
  EMPTY_LOCAL_SKILL_INSTALL_STATE,
  type LocalSkillInstallState,
  LocalSkillInstallStateError,
  type LocalSkillInstallStore,
} from '../lib/installs/store.ts';

/**
 * `state/skills/installs.json` through the kernel's state port (atomic, `0600`, format-checked). DAMAGED IS NOT EMPTY:
 * a file that will not read raises, because answering "no copies" would forget every recorded hash and let a changed
 * file be overwritten. Only a state home that never copied anything answers the empty state. No part of the file
 * reaches a message.
 */
export class StateLocalSkillInstallStore implements LocalSkillInstallStore {
  constructor(private readonly state: StatePort) {}

  async read(): Promise<LocalSkillInstallState> {
    const read = await this.state.read(SKILLS_INSTALLS_STATE);
    if (!read.ok)
      throw new LocalSkillInstallStateError(
        'installs.json is not a record of copies this daemon writes, so no copy was changed',
      );
    return read.value ?? EMPTY_LOCAL_SKILL_INSTALL_STATE;
  }

  async write(state: LocalSkillInstallState): Promise<void> {
    await this.state.write(SKILLS_INSTALLS_STATE, state);
  }
}
