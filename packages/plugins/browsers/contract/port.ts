/**
 * Browsers' port (§2.3): the agent browser's lifecycle and the pages a ferret holds, by id and name. Never a URL, a
 * title or page text: page metadata is a `reads` act and leaves only through the act runner (§4.7).
 */
import { defineEvent, definePort, type FerretId } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { BrowserPageIdSchema, type BrowserStateView, type SurfaceNameSchema } from './wire.ts';

export interface BrowserPageRef {
  readonly id: z.infer<typeof BrowserPageIdSchema>;
  readonly name?: z.infer<typeof SurfaceNameSchema>;
  readonly incognito?: true;
}

export interface BrowsersApi {
  state(): Promise<BrowserStateView>;
  /** The pages one ferret holds, by id and name only. */
  pagesOf(ferret: FerretId): Promise<readonly BrowserPageRef[]>;
}

export const BrowsersPort = definePort<BrowsersApi>('browsers');

/** A page opened or closed, or a person took the browser over or handed it back. Read the port for the truth. */
export const PageChanged = defineEvent(
  'browsers.page-changed',
  z.strictObject({
    ferret: z.string().min(1),
    page: BrowserPageIdSchema,
    change: z.enum(['opened', 'closed', 'taken-over', 'handed-back', 'handed-over', 'asked']),
  }),
);
