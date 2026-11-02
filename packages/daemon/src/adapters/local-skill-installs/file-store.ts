import { join } from 'node:path';
import type { FileSystemPort, FoundationPaths } from '../../lib/index.ts';
import {
  EMPTY_LOCAL_SKILL_INSTALL_STATE,
  type LocalSkillInstallState,
  LocalSkillInstallStateError,
  LocalSkillInstallStateSchema,
  type LocalSkillInstallStore,
} from '../../lib/local-skill-installs/store.ts';

const LOCAL_SKILL_INSTALLS_DOCUMENT = 'local-skill-installs.json';

/**
 * `<FY_HOME>/state/local-skill-installs.json`, `0600` from the first byte (the port writes a `0600`
 * temporary file and renames it). DAMAGED IS NOT EMPTY: a file that will not parse raises, because answering
 * "no copies" would forget every recorded hash and let a changed file be overwritten. Only a state home that
 * never copied anything answers the empty state. No part of the file reaches a message.
 */
export class FileLocalSkillInstallStore implements LocalSkillInstallStore {
  private readonly path: string;

  constructor(
    paths: FoundationPaths,
    private readonly files: FileSystemPort,
  ) {
    this.path = join(paths.state, LOCAL_SKILL_INSTALLS_DOCUMENT);
  }

  async read(): Promise<LocalSkillInstallState> {
    const raw = await this.files.readText(this.path);
    if (raw === undefined) return EMPTY_LOCAL_SKILL_INSTALL_STATE;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw new LocalSkillInstallStateError(`${LOCAL_SKILL_INSTALLS_DOCUMENT} is not JSON, so no copy was changed`);
    }
    const parsed = LocalSkillInstallStateSchema.safeParse(decoded);
    if (!parsed.success)
      throw new LocalSkillInstallStateError(
        `${LOCAL_SKILL_INSTALLS_DOCUMENT} is not a record of copies this daemon writes, so no copy was changed`,
      );
    return parsed.data;
  }

  async write(state: LocalSkillInstallState): Promise<void> {
    await this.files.writeTextAtomic(this.path, `${JSON.stringify(state, undefined, 2)}\n`);
  }
}
