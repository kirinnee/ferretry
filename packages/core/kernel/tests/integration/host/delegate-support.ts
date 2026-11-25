import { type AuditDraft, type GateConfig, AdminTokenFile, WardenTokenFile } from '../../../../gate/contract/index.ts';
import { AdmissionPort } from '../../../contract/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { testHost } from '../../../testing/index.ts';

/** Real Gate, loaded through the registry as production loads it; all state and freshly minted tokens are in memory. */
export async function gateWorld() {
  const real = daemonImplementations.find(implementation => implementation.manifest.id === 'gate');
  if (real === undefined) throw new Error('registry has no Gate');
  const host = await testHost({ plugins: [real] });
  await host.runJob('gate.tokens');
  const text = (path: string) => {
    const value = host.state('gate').bytes.get(path) ?? host.state('gate').files.get(path);
    return typeof value === 'string' ? value : new TextDecoder().decode(value);
  };
  return {
    gate: host.provided(AdmissionPort),
    admin: text(AdminTokenFile.path).trim(),
    warden: text(WardenTokenFile.path).trim(),
    set policy(value: GateConfig | undefined) {
      host.setConfig('gate.yaml', value ?? { invalid: true });
    },
    async recorded(): Promise<readonly AuditDraft[]> {
      await host.runJob('gate.audit-flush');
      return [...host.state('gate').files.entries()]
        .filter(([path]) => path.endsWith('.jsonl'))
        .flatMap(([, contents]) =>
          contents
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line) as AuditDraft),
        );
    },
  };
}
