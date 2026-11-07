import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
  FileSessionAttachmentCopier,
  FileSessionTransferBriefWriter,
  FileSessionTransferTargetPlanStore,
} from '../../../../src/adapters/transfer/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../../src/lib/index.ts';
import { builtTransfer } from './fixture.ts';

/**
 * THE FORK'S TRANSFER-ONLY PORTS (fix round 1 of the extraction).
 *
 * `TransferProvides.transferPorts` is the construction `createForkSubsystem` used to do inline for the target plan store,
 * the brief writer and the attachment copier. It must stay a FACTORY the fork calls at its old construction point, so
 * these tests pin that building the module constructs none of them, and that calling the factory constructs them over the
 * given path facts and touches nothing: no file, no directory, no timer.
 */

const STATE_HOME = '/nonexistent/transfer-ports-state-home';

describe('transfer module ports factory', () => {
  test('calling the factory makes the three ports over the given paths and resolver, and leaves nothing behind', () => {
    const asked: string[] = [];
    const paths = createFoundationPaths(resolveStateHome({ fyHome: STATE_HOME, homeDirectory: '/unused' }));
    const ports = builtTransfer().provides.transferPorts({
      paths,
      attachmentOriginals: id => {
        asked.push(id);
        return `${STATE_HOME}/attachments/${id}`;
      },
    });

    expect(ports.planStore).toBeInstanceOf(FileSessionTransferTargetPlanStore);
    expect(ports.briefWriter).toBeInstanceOf(FileSessionTransferBriefWriter);
    expect(ports.attachmentCopier).toBeInstanceOf(FileSessionAttachmentCopier);
    // Construction only captures the resolver: it is not asked about a session and nothing is created on disk.
    expect(asked).toEqual([]);
    expect(existsSync(STATE_HOME)).toBe(false);
  });

  test('every call constructs new ports, so the fork owns the instances it was handed', () => {
    const paths = createFoundationPaths(resolveStateHome({ fyHome: STATE_HOME, homeDirectory: '/unused' }));
    const provides = builtTransfer().provides;
    const parts = { paths, attachmentOriginals: (id: string) => `${STATE_HOME}/${id}` };
    const first = provides.transferPorts(parts);
    const second = provides.transferPorts(parts);

    expect(second.planStore).not.toBe(first.planStore);
    expect(second.briefWriter).not.toBe(first.briefWriter);
    expect(second.attachmentCopier).not.toBe(first.attachmentCopier);
  });
});
