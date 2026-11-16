import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { diskSessionsRoots } from '@ferretry/kernel/testing';
import { FileSessionTransferBriefWriter } from '../../../../daemon/adapters/transfer/brief-writer.ts';
import { parseSessionId } from '../../../../daemon/lib/session-id.ts';

const TARGET = parseSessionId('mw7bp88g-7a26e701');
const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

describe('FileSessionTransferBriefWriter when the disk fails under the pre-launch proof', () => {
  test('a failure that is not "the folder is not made yet" is surfaced, never read as "no brief"', async () => {
    // Arrange: the kernel's refusal for a missing folder is an absence; any other failure is a fault the fork must see.
    const parent = await mkdtemp(`${tmpdir()}/fy-brief-faults-`);
    parents.push(parent);
    const sessions = await diskSessionsRoots(parent);
    const writer = new FileSessionTransferBriefWriter(id => ({
      ...sessions.root(id),
      lstat: async () => {
        throw new Error('EIO: the medium failed');
      },
    }));

    // Act + Assert
    await expect(writer.matches(TARGET, 'the brief')).rejects.toThrow('the medium failed');
  });
});
