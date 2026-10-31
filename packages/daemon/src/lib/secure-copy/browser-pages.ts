import type { BrowserElementTarget, CopyElementPart } from '@ferretry/protocol';
import type { BrowserCopyPort } from '../browser/transport/copy-contracts.ts';
import type { CopyPagePort, CopyPageRead } from './ports.ts';

/** The agent browser as it runs one page's work in that page's own queue (`BrowserSubsystem.copyOnPage`). */
export interface CopyPageHost {
  copyOnPage<T>(
    sessionId: string,
    key: string,
    work: (copy: BrowserCopyPort, pageId: string) => Promise<T>,
  ): Promise<T>;
}

/** A copy of a page element, read in the page's own queue so no agent act lands in the middle. */
export class BrowserCopyPages implements CopyPagePort {
  constructor(private readonly host: CopyPageHost) {}

  async read(
    sessionId: string,
    key: string,
    target: BrowserElementTarget,
    part: CopyElementPart,
    attribute?: string,
  ): Promise<CopyPageRead> {
    return await this.host.copyOnPage(sessionId, key, async (copy, pageId) => {
      const read = await copy.copyRead(pageId, target, part, attribute);
      return read.ok ? { ...read, pageId } : read;
    });
  }
}
