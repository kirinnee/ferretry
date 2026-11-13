import type { FerretId } from '@ferretry/kernel/contract';
import type { BrowsersApi } from '@ferretry/plugin-browsers/contract';
import type { CopyElementPart } from '../../../contract/routes/index.ts';
import {
  type CopyPagePort,
  type CopyPageQueue,
  type CopyPageRead,
  SecureCopyError,
} from '../../lib/secure-copy/index.ts';
import type { BrowserElementTarget } from '../../lib/vault-inputs.ts';

/**
 * A COPY OF A PAGE ELEMENT, through Browsers' copy reach (`BrowsersApi.copy`, Accounts alone): the page is cleared and read
 * in its OWN queue, so no agent act lands in the middle. Browsers checks what a browser tool checks (the switch, the
 * ferret's own page, nobody holding it) before the read and again inside the queue; a takeover that lands while the copy
 * waits still refuses it. A Browsers that is off, or offers no reach, copies nothing.
 */
export class BrowsersCopyPages implements CopyPagePort {
  constructor(private readonly browsers: () => BrowsersApi | undefined) {}

  async read(
    sessionId: string,
    key: string,
    target: BrowserElementTarget,
    part: CopyElementPart,
    attribute: string | undefined,
    queue: CopyPageQueue,
  ): Promise<CopyPageRead> {
    const copy = this.browsers()?.copy;
    if (copy === undefined)
      throw new SecureCopyError('unavailable', 'Copying from a page is not available on this daemon.');
    const answer = await copy.copyRead(sessionId as FerretId, key, target, part, attribute, queue);
    if (answer.ok || answer.reason !== 'refused') return answer;
    throw new SecureCopyError(answer.code === 'unavailable' ? 'unavailable' : answer.code, answer.message);
  }
}
