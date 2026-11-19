import type { PullDetail } from '../../../contract/index.ts';
import { ReviewableFiles } from '../compose/index.ts';
import type { PullAddress, PullsClient } from '../../lib/client.ts';

/** The Files tab: the diff with its review threads, and the ways to quote and comment on it (E5, E6, E7). */
export function FilesTab({
  client,
  daemon,
  address,
  pull,
}: {
  readonly client: PullsClient;
  readonly daemon: string;
  readonly address: PullAddress;
  readonly pull: PullDetail;
}) {
  return (
    <section aria-label="Files" data-pull-files="">
      <ReviewableFiles address={address} client={client} daemon={daemon} pull={pull} />
    </section>
  );
}
