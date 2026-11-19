import type { ConfigPort } from '@ferretry/kernel/contract';
import { SKILLS_CONFIG } from '../../../contract/index.ts';
import type { SkillsItemWrite } from './put.ts';

/**
 * Creates `config/skills/<name>.yaml` through the kernel's config writer, pinned to "no file yet" (`ifMatch: 'absent'`),
 * and answers in this feature's words: the writer's own schema check, raw-secret refusal and hold still apply.
 */
export const createSkillsItem =
  (config: Pick<ConfigPort, 'write'>) =>
  async (name: string, text: string): Promise<SkillsItemWrite> => {
    const outcome = await config.write(SKILLS_CONFIG, name, text, { ifMatch: 'absent' });
    if (outcome.kind === 'written') return { kind: 'written' };
    if (outcome.kind === 'held') return { kind: 'held' };
    if (outcome.kind === 'conflict') return { kind: 'conflict' };
    return { kind: 'refused', issues: outcome.issues };
  };

/**
 * Replaces `config/skills/<name>.yaml` for an update the person accepted, pinned to the file's etag read just before
 * (`config.etag`): a file that moved meanwhile is a `conflict`, never an overwrite.
 */
export const replaceSkillsItem =
  (config: Pick<ConfigPort, 'write' | 'etag'>) =>
  async (name: string, text: string): Promise<SkillsItemWrite> => {
    const outcome = await config.write(SKILLS_CONFIG, name, text, { ifMatch: await config.etag(SKILLS_CONFIG, name) });
    if (outcome.kind === 'written') return { kind: 'written' };
    if (outcome.kind === 'held') return { kind: 'held' };
    if (outcome.kind === 'conflict') return { kind: 'conflict' };
    return { kind: 'refused', issues: outcome.issues };
  };
