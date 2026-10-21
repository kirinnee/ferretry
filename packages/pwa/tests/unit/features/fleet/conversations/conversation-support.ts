/**
 * Fixtures for the conversation import suites: invented folders and messages, parsed through the real
 * schema so a wire change fails here first.
 */

import {
  type ConversationImportListing,
  ConversationImportListingSchema,
  type ImportableConversation,
  ImportableConversationSchema,
} from '@ferretry/protocol';
import { interact } from '../../../../support/dom.ts';

export const NOW = Date.parse('2026-10-13T08:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A conversation `daysAgo` days before NOW. */
export const conversation = (
  id: string,
  overrides: Partial<ImportableConversation> & { readonly daysAgo?: number } = {},
): ImportableConversation => {
  const { daysAgo = 1, ...rest } = overrides;
  return ImportableConversationSchema.parse({
    id,
    harness: 'claude',
    project: '/work/shop',
    preview: `Fix the ${id} page`,
    lastActivityAt: new Date(NOW - daysAgo * DAY).toISOString(),
    turns: 4,
    model: 'Sonnet 5.5',
    ...rest,
  });
};

export const listing = (
  conversations: readonly ImportableConversation[],
  matched = conversations.length,
  computerListed?: false,
): ConversationImportListing =>
  ConversationImportListingSchema.parse({
    conversations,
    matched,
    skipped: 0,
    ...(computerListed === undefined ? {} : { computerListed }),
  });

export const type = async (input: HTMLInputElement, value: string): Promise<void> => {
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

export const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 4; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};
