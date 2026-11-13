import type { BrowserCopyAnswer, BrowserCopyRefusalCode, BrowsersCopyApi } from '../../contract/port.ts';
import type { BrowserSessionService } from '../pages/service.ts';
import { BrowserToolError, type BrowserTools } from '../tools/service.ts';
import { hostOfOrigin, type SealedPages } from './page-guards.ts';

/** What the reach stands on: the tools (their checks), the pages (the queue) and the registry of pages that hold a value. */
export interface SecureCopyReachDeps {
  readonly tools: Pick<BrowserTools, 'copyPageFor' | 'isTakenOver' | 'addressOf'>;
  readonly pages: Pick<BrowserSessionService, 'copyOnPage'>;
  readonly sealed: SealedPages;
}

/**
 * SECURE COPY'S REACH INTO THE AGENT BROWSER (docs/secure-copy.md), handed to Accounts alone: a page element or the
 * clipboard is read in the page's own queue after the checks a browser tool makes, a paste target is cleared, and the pages
 * that hold a sealed value are recorded so the tools keep them closed.
 */
export function secureCopyReach({ tools, pages, sealed }: SecureCopyReachDeps): BrowsersCopyApi {
  /** A refusal a browser tool would have given, as the copy's closed set of codes and the tool's own sentence. */
  const refusal = (error: unknown): { readonly code: BrowserCopyRefusalCode; readonly message: string } => {
    if (error instanceof BrowserToolError) {
      const code: BrowserCopyRefusalCode =
        error.code === 'taken_over' || error.code === 'forbidden' || error.code === 'not_found'
          ? error.code
          : 'unavailable';
      return { code, message: error.message };
    }
    return { code: 'unavailable', message: 'The page could not be read right now.' };
  };
  return {
    copyRead: async (ferret, key, target, part, attribute, queue): Promise<BrowserCopyAnswer> => {
      try {
        const { surface, guard } = await tools.copyPageFor(ferret, key);
        return await pages.copyOnPage<BrowserCopyAnswer>(ferret, surface.name ?? surface.id, {
          // The takeover check, then the owner's: both run inside the page's queue, before the read.
          guard: async page => {
            await guard(page);
            await queue.guard?.(page);
          },
          work: async (copy, pageId) => {
            const read = await copy.copyRead(pageId, target, part, attribute);
            if (!read.ok) return read;
            const found = { ...read, pageId };
            queue.seal(found);
            return found;
          },
        });
      } catch (error) {
        // A refusal is the one thing that comes back as data: it carries a sentence, never the page's words.
        return { ok: false, reason: 'refused', ...refusal(error) };
      }
    },
    clipboardRead: async (ferret, key, queue): Promise<BrowserCopyAnswer> => {
      // While it runs no page script of this ferret's may run: nothing it executes may see what the page put on the clipboard.
      const done = sealed.capturing(ferret);
      try {
        const { surface, guard } = await tools.copyPageFor(ferret, key);
        return await pages.copyOnPage<BrowserCopyAnswer>(ferret, surface.name ?? surface.id, {
          guard: async page => {
            await guard(page);
            await queue.guard?.(page);
          },
          work: async (copy, pageId) => {
            const read = await copy.copyClipboard(pageId);
            if (!read.ok) {
              if (read.reason !== 'shared') return { ok: false, reason: read.reason };
              return {
                ok: false,
                reason: 'refused',
                code: 'unavailable',
                message:
                  "This browser is a real window on this computer, so its clipboard is the computer's own and Ferretry will not read it. Copy the element that shows the value instead, or ask the owner to switch the browser to headless.",
              };
            }
            const found = { ...read, pageId };
            queue.seal(found);
            return found;
          },
        });
      } catch (error) {
        return { ok: false, reason: 'refused', ...refusal(error) };
      } finally {
        done();
      }
    },
    sealed: {
      hold: (ferret, copy, origins, until) => sealed.hold(ferret, copy, origins, until),
      pastedInto: async (ferret, copy, key, until) => {
        // Where the page is NOW, with no takeover or switch check: a page that holds the value is held whoever has it.
        const address = await tools.addressOf(ferret, key);
        if (address !== undefined && hostOfOrigin(address) !== undefined) sealed.hold(ferret, copy, [address], until);
      },
      drop: ferret => sealed.drop(ferret),
    },
    pasteTarget: async (ferret, key) => {
      try {
        const { surface } = await tools.copyPageFor(ferret, key);
        return { ok: true, key: surface.name ?? surface.id };
      } catch (error) {
        return { ok: false, ...refusal(error) };
      }
    },
    takenOver: async (ferret, key) => await tools.isTakenOver(ferret, key),
  };
}
