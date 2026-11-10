import { expect, it } from 'bun:test';
import type { ConfigPort, ConfigWriteOutcome } from '@ferretry/kernel/contract';
import manifest from '../../../manifest.ts';
import { writeTunnelSetting } from '../../../daemon/tunnel-setting.ts';

/**
 * BG-012 m-3: a refused write of the tunnel setting says the kernel's own sentence (a link, a file that is not UTF-8),
 * not only "could not be written to its document", which names no cause.
 */
const UNREADABLE =
  'connections.yaml cannot be read (a link, not a regular file, or larger than a config file may be), so nothing was written over it';
const FIX = 'replace the file with an ordinary one, then make the change again';

const over = (outcome: ConfigWriteOutcome): Pick<ConfigPort, 'writeAsOwner'> => ({ writeAsOwner: async () => outcome });
const def = manifest.data.config[0]!;

it('BG-012 m-3 a refused tunnel setting write names the kernel’s sentence and its fix', async () => {
  const config = over({
    kind: 'refused',
    reason: 'yaml',
    issues: [{ path: 'connections.yaml', message: UNREADABLE, fix: FIX }],
  });
  await expect(writeTunnelSetting(config, def, true)).rejects.toThrow(
    `the tunnel setting could not be written to its document: ${UNREADABLE}: ${FIX}`,
  );
});

it('BG-012 m-3 a refusal whose fix is the empty string ends in the kernel’s sentence, with no bare colon', async () => {
  const config = over({
    kind: 'refused',
    reason: 'yaml',
    issues: [{ path: 'connections.yaml', message: UNREADABLE, fix: '' }],
  });
  const error = await writeTunnelSetting(config, def, true).then(
    () => undefined,
    (thrown: unknown) => thrown as Error,
  );
  expect(error?.message).toBe(`the tunnel setting could not be written to its document: ${UNREADABLE}`);
});

it('BG-012 m-3 a refusal with nothing to say keeps the plain sentence, and a held write says it waits for the owner', async () => {
  await expect(writeTunnelSetting(over({ kind: 'conflict' }), def, true)).rejects.toThrow(
    'the tunnel setting could not be written to its document',
  );
  await expect(
    writeTunnelSetting(over({ kind: 'held', etag: 'e', id: 'i', sentences: ['x'] }), def, true),
  ).rejects.toThrow('waits for the owner to confirm');
  await expect(
    writeTunnelSetting(over({ kind: 'written', etag: 'e', loosened: [] }), def, false),
  ).resolves.toBeUndefined();
});
