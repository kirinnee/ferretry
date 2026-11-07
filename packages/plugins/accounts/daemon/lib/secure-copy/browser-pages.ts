import type { BrowserElementTarget, CopyElementPart } from '@ferretry/protocol';
import type { BrowserCopyPort } from '../browser/transport/copy-contracts.ts';
import type { CopyPageGuard, CopyPagePort, CopyPageQueue, CopyPageRead } from './ports.ts';

/** The agent browser as it runs one page's work in that page's own queue (`BrowserSubsystem.copyOnPage`). */
export interface CopyPageHost {
  copyOnPage<T>(sessionId: string, key: string, job: CopyPageJob<T>): Promise<T>;
}

/**
 * One copy's work in a page's queue: the guard run first, then the read. ONE object on purpose: a host that hands
 * it on whole cannot drop the guard, where a forgotten trailing argument would compile and skip the check.
 */
export interface CopyPageJob<T> {
  readonly work: (copy: BrowserCopyPort, pageId: string) => Promise<T>;
  readonly guard?: CopyPageGuard;
}

/**
 * A copy of a page element, read in the page's own queue so no agent act lands in the middle: the guard first,
 * then the read, then the seal, all before the queue moves on.
 */
export class BrowserCopyPages implements CopyPagePort {
  constructor(private readonly host: CopyPageHost) {}

  async read(
    sessionId: string,
    key: string,
    target: BrowserElementTarget,
    part: CopyElementPart,
    attribute: string | undefined,
    queue: CopyPageQueue,
  ): Promise<CopyPageRead> {
    return await this.host.copyOnPage(sessionId, key, {
      work: async (copy, pageId) => {
        const read = await copy.copyRead(pageId, target, part, attribute);
        if (!read.ok) return read;
        const found = { ...read, pageId };
        queue.seal(found);
        return found;
      },
      ...(queue.guard === undefined ? {} : { guard: queue.guard }),
    });
  }
}
