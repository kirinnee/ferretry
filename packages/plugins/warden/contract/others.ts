/**
 * STAND-IN for the Usage contract (§2.3: Warden `uses` Usage, optional, to read headroom for failover). The parent
 * slice is writing `@ferretry/plugin-usage/contract`; the generator matches ports by name, so replace this with an
 * import of `UsagePort` in the manifest when it lands (a manifest may import another contract; a contract file may not).
 */
import { definePort } from '@ferretry/kernel/contract';

export interface UsageHeadroomApi {
  /** Percent of the quota left for a login, or `undefined` when unknown. */
  headroomPercent(login: string): Promise<number | undefined>;
}
export const UsagePort = definePort<UsageHeadroomApi>('usage');
