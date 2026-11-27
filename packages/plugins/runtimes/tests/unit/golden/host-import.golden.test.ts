/**
 * E-276 0a: the host import — what `HostHarnessScanner` reads from a Claude home and a Codex home and what `planImport` makes of it
 * (components, files, secrets, notes, the preview a person sees), the login note for every sign-in state, and the credential an
 * import files. Hosts are in-memory trees (`support/host-world.ts`); the digest is SHA-256; nothing reads a disk.
 */
import { createHash } from 'node:crypto';
import { describe, it } from 'bun:test';
import { fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { HostHarnessScanner } from '../../../daemon/adapters/host-harness-scan.ts';
import { type HostLogin, credentialOf, loginNote } from '../../../daemon/lib/account/import.ts';
import { planImport } from '../../../daemon/lib/account/import-plan.ts';
import { expectGolden } from './support/golden.ts';
import { HOST_HOME, HOSTS, memoryHostFiles } from './support/host-world.ts';
import { outcome, THIRD_KEY } from './support/thrown.ts';

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const INSTALLED = new Map([
  ['claude', '/opt/harness/bin/claude'],
  ['codex', '/opt/harness/bin/codex'],
  ['npx', '/opt/harness/bin/npx'],
]);

const scanHost = async (name: string, installed: boolean, logins: 'signed-in' | 'none') =>
  await new HostHarnessScanner({
    files: memoryHostFiles(HOSTS[name] as never),
    userHome: HOST_HOME,
    commands: { resolve: command => (installed ? INSTALLED.get(command) : undefined) },
    logins: fakeLogins(
      logins === 'none'
        ? []
        : [
            sampleLogin('claude-host', { email: 'claude@example.test' }),
            sampleLogin('codex-host', {
              harness: 'codex',
              harnesses: ['codex'],
              email: 'codex@example.test',
              status: { ...sampleLogin('codex-host').status, word: 'refresh_due' },
            }),
          ],
    ),
    maxDocumentBytes: 8192,
  }).scan();

const SCENARIOS = [
  { name: 'both', host: 'both', installed: true, logins: 'signed-in', options: {} },
  {
    name: 'both-ticked-token',
    host: 'both',
    installed: true,
    logins: 'signed-in',
    options: { tickedEnv: ['GH_TOKEN'] },
  },
  {
    name: 'both-skipping-an-item',
    host: 'both',
    installed: true,
    logins: 'signed-in',
    options: { skip: ['claude-code:mcp:files'] },
  },
  { name: 'both-codex-only', host: 'both', installed: true, logins: 'signed-in', options: { include: ['codex'] } },
  {
    name: 'both-duplicates',
    host: 'both',
    installed: true,
    logins: 'none',
    options: { addDuplicates: ['claude', 'codex'] },
  },
  { name: 'shared-instructions', host: 'shared-instructions', installed: true, logins: 'signed-in', options: {} },
  { name: 'nothing-installed', host: 'empty', installed: false, logins: 'none', options: {} },
] as const;

describe('host import goldens', () => {
  for (const scenario of SCENARIOS) {
    it(`should scan and plan the import of ${scenario.name} exactly as the base does`, async () => {
      const scans = await scanHost(scenario.host, scenario.installed, scenario.logins);
      const options = { digest, existingSecrets: [] as string[], ...scenario.options } as never;
      expectGolden(`import/${scenario.name}`, { scans, plan: planImport(scans, options) });
      // Deterministic by construction: a second scan and plan renders the same bytes.
      const again = await scanHost(scenario.host, scenario.installed, scenario.logins);
      expectGolden(`import/${scenario.name}`, { scans: again, plan: planImport(again, options) });
    });
  }

  it('should write the login note and the filed credential for every sign-in state exactly as the base does', () => {
    const logins: readonly HostLogin[] = [
      { state: 'signed-in', email: 'person@example.test' },
      { state: 'signed-in' },
      { state: 'refresh-due', email: 'person@example.test' },
      { state: 'not-signed-in' },
      { state: 'unknown' },
      { state: 'unknown', reason: 'golden reason' },
      { state: 'unreadable' },
      { state: 'unreadable', reason: 'a locked keychain' },
      { state: 'not-shareable', reason: 'it is kept in a keyring' },
      { state: 'not-shareable' },
    ];
    expectGolden('import/login-notes', {
      claude: logins.map(login => ({
        login,
        note: loginNote('claude', login),
        credential: credentialOf('claude', login),
      })),
      codex: logins.map(login => ({
        login,
        note: loginNote('codex', login),
        credential: credentialOf('codex', login),
      })),
      thirdKey: outcome(() => loginNote(THIRD_KEY as never, { state: 'signed-in' })),
    });
  });
});
