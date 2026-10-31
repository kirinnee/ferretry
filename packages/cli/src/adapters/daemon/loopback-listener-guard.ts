import { readFile } from 'node:fs/promises';
import { PROC_TCP_TABLES } from '@ferretry/protocol';
import { daemonUrlPort, foreignListenerRefusal, listenerOwnerVerdict } from '../../lib/daemon/listener-owner.ts';

/** The kernel's socket tables, or `undefined` on a host that publishes none (macOS). */
export async function procTcpTables(
  read: (path: string) => Promise<string> = path => readFile(path, 'utf8'),
): Promise<readonly string[] | undefined> {
  const tables = await Promise.all(PROC_TCP_TABLES.map(path => read(path).catch(() => undefined)));
  const present = tables.filter((table): table is string => table !== undefined);
  return present.length === 0 ? undefined : present;
}

export interface LoopbackListenerGuardPorts {
  readonly tables: () => Promise<readonly string[] | undefined>;
  /** `undefined` where the platform has no uids, which is a host this guard cannot judge. */
  readonly uid: () => number | undefined;
}

const systemPorts: LoopbackListenerGuardPorts = {
  tables: () => procTcpTables(),
  uid: () => process.getuid?.(),
};

/**
 * Throws instead of letting `credential` go to a loopback `url` whose port another user holds
 * (`lib/daemon/listener-owner.ts`). Callers only ask this for a URL they already decided is loopback.
 */
export async function assertOwnLoopbackListener(
  url: string,
  credential: string,
  ports: LoopbackListenerGuardPorts = systemPorts,
): Promise<void> {
  const port = daemonUrlPort(url);
  const uid = ports.uid();
  if (port === undefined || uid === undefined) return;
  const refusal = foreignListenerRefusal(url, credential, listenerOwnerVerdict(port, uid, await ports.tables()));
  if (refusal !== undefined) throw new Error(refusal);
}
