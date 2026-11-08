import { describe, expect, test } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import {
  FileSessionAttachmentCopier,
  FileSessionTransferBriefWriter,
  FileSessionTransferTargetPlanStore,
} from '../../../../../daemon/adapters/transfer/index.ts';
import { type TransferPortsParts, transferPorts } from '../../../../../daemon/modules/transfer.ts';
import { TransferPlanFiles } from '../../../../../contract/transfer-state.ts';
import type { TransferAttachmentStore } from '../../../../../daemon/lib/transfer/ports.ts';

/**
 * THE FORK'S TRANSFER-ONLY PORTS.
 *
 * `transferPorts` is the construction `createForkSubsystem` does for the target plan store, the brief writer and the
 * attachment copier. It must stay a FACTORY the fork calls at its construction point, so these tests pin that calling
 * it constructs them over the given ports and touches nothing: no state file is read or written, and the attachment
 * store (the attachment owner's, an unbound port) is not asked anything.
 */

function parts(): {
  readonly folder: MemoryStateFolder;
  readonly asked: string[];
  readonly state: ReturnType<MemoryStateFolder['port']>;
  readonly attachments: TransferAttachmentStore;
  readonly briefs: TransferPortsParts['briefs'];
} {
  const folder = new MemoryStateFolder();
  const asked: string[] = [];
  const unusedStore: TransferAttachmentStore = {
    read: async (sessionId, attachmentId, file) => {
      asked.push(`read ${sessionId}/${attachmentId}/${file}`);
      return undefined;
    },
    write: async (sessionId, attachmentId, file) => {
      asked.push(`write ${sessionId}/${attachmentId}/${file}`);
    },
    parseManifest: () => {
      throw new Error('not asked');
    },
  };
  // The brief is a target's own turn one on the `sessions` root: construction must not even open that folder.
  const briefs: TransferPortsParts['briefs'] = id => {
    asked.push(`briefs ${id}`);
    throw new Error('not asked');
  };
  return { folder, asked, state: folder.port([TransferPlanFiles]), attachments: unusedStore, briefs };
}

describe('transfer module ports factory', () => {
  test('calling the factory makes the three ports over the given ports, and leaves nothing behind', () => {
    const { folder, asked, state, attachments, briefs } = parts();

    const ports = transferPorts({ state, attachments, briefs });

    expect(ports.planStore).toBeInstanceOf(FileSessionTransferTargetPlanStore);
    expect(ports.briefWriter).toBeInstanceOf(FileSessionTransferBriefWriter);
    expect(ports.attachmentCopier).toBeInstanceOf(FileSessionAttachmentCopier);
    // Construction only captures the ports: the owner's store is not asked and nothing is written to state.
    expect(asked).toEqual([]);
    expect(folder.files.size).toBe(0);
    expect(folder.bytes.size).toBe(0);
  });

  test('every call constructs new ports, so the fork owns the instances it was handed', () => {
    const given = parts();
    const first = transferPorts({ state: given.state, attachments: given.attachments, briefs: given.briefs });
    const second = transferPorts({ state: given.state, attachments: given.attachments, briefs: given.briefs });

    expect(second.planStore).not.toBe(first.planStore);
    expect(second.briefWriter).not.toBe(first.briefWriter);
    expect(second.attachmentCopier).not.toBe(first.attachmentCopier);
  });
});
