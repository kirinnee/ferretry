/**
 * A handover receipt store's state in memory: the kernel test host's `MemoryStateFolder` declaring the contract's
 * `HandoverFiles`. The folder is returned beside the port so a test can plant a damaged document or read what was
 * written, exactly as the on-disk tier did with a temporary directory.
 */
import type { StatePort } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { HandoverFiles } from '../../../contract/handover-state.ts';

export function memoryHandoverState(folder: MemoryStateFolder = new MemoryStateFolder()): {
  readonly folder: MemoryStateFolder;
  readonly state: StatePort;
} {
  return { folder, state: folder.port([HandoverFiles]) };
}
