import { readFile } from 'node:fs/promises';
import {
  daemonUrlPort,
  foreignListenerRefusal,
  listenerOwnerVerdict,
  PROC_TCP_TABLES,
} from '../../lib/listener-owner.ts';

/** The kernel's socket tables, or `undefined` on a host that publishes none (macOS). */
export async function procTcpTables(
  read: (path: string) => Promise<string> = path => readFile(path, 'utf8'),
): Promise<readonly string[] | undefined> {
  const tables = await Promise.all(PROC_TCP_TABLES.map(path => read(path).catch(() => undefined)));
  const present = tables.filter((table): table is string => table !== undefined);
  return present.length === 0 ? undefined : present;
}

export interface ListenerGuardPorts {
  readonly tables: () => Promise<readonly string[] | undefined>;
  /** `undefined` where the platform has no uids: a host this guard cannot judge. */
  readonly uid: () => number | undefined;
}

export const systemListenerPorts: ListenerGuardPorts = {
  tables: () => procTcpTables(),
  uid: () => process.getuid?.(),
};

/** Throws instead of letting `credential` go to a loopback `url` whose port another user holds (S57). */
export async function assertOwnLoopbackListener(
  url: string,
  credential: string,
  ports: ListenerGuardPorts = systemListenerPorts,
): Promise<void> {
  const port = daemonUrlPort(url);
  const uid = ports.uid();
  if (port === undefined || uid === undefined) return;
  const refusal = foreignListenerRefusal(url, credential, listenerOwnerVerdict(port, uid, await ports.tables()));
  if (refusal !== undefined) throw new Error(refusal);
}
