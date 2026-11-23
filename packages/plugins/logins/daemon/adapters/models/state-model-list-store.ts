import type { StatePort } from '@ferretry/kernel/contract';
import { LOGINS_MODEL_LISTS } from '../../../contract/model-list.ts';
import { LOGIN_NAME } from '../../../contract/wire.ts';
import type { ModelListView } from '../../../contract/model-list.ts';
import type { ModelListStore } from '../../lib/model-lists/service.ts';

/**
 * Each login's live model list, in `state/logins/model-lists/<login>.json` (docs/model-catalog.md § Live model list):
 * ids and the instant they were read, nothing else. A file that is damaged or fails its schema reads as none, so the
 * worst it can do is make the next picker open read the provider again.
 */
export class StateModelListStore implements ModelListStore {
  constructor(private readonly state: Pick<StatePort, 'read' | 'write' | 'remove' | 'list'>) {}

  async read(loginId: string): Promise<ModelListView | undefined> {
    if (!LOGIN_NAME.test(loginId)) return undefined;
    const read = await this.state.read(LOGINS_MODEL_LISTS, loginId).catch(() => undefined);
    if (read === undefined || !read.ok || read.value === undefined) return undefined;
    const { fetchedAt, complete, ids } = read.value;
    return { fetchedAt, complete, ids };
  }

  async write(loginId: string, list: ModelListView): Promise<void> {
    if (!LOGIN_NAME.test(loginId)) return;
    await this.state.write(LOGINS_MODEL_LISTS, { format: 1, ...list }, loginId);
  }

  async remove(loginId: string): Promise<void> {
    if (!LOGIN_NAME.test(loginId)) return;
    await this.state.remove(LOGINS_MODEL_LISTS, loginId);
  }

  async logins(): Promise<readonly string[]> {
    return (await this.state.list(LOGINS_MODEL_LISTS)).filter(name => LOGIN_NAME.test(name));
  }
}
