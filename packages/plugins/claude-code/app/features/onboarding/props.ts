import type { StepHost } from '@ferretry/kernel/contract';

/** What every page takes: the plugin's client, and the host the shell hands a step (O1's contract). */
export interface StepPageProps<Client> {
  readonly client: Client;
  readonly step?: StepHost | undefined;
}
