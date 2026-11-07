/**
 * Fixtures for the links suites: invented folders, messages and ferrets, parsed through the real schemas so a wire
 * change fails here first.
 */

import { interact } from '@ferretry/app/testing';
import { type FerretSummary, FerretSummarySchema } from '@ferretry/core-ferrets/contract';
import type { Instant } from '@ferretry/std';
import type { z } from 'zod';
import {
  type LinkableConversation,
  LinkableConversationSchema,
  type LinkListing,
  LinkListingSchema,
} from '../../../contract/index.ts';
import { createElement, type ReactNode } from 'react';
import type { RuntimeField } from '../../../app/links/conversation-picker.tsx';

export const NOW = Date.parse('2026-10-13T08:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** An instant `hoursAgo` hours before NOW. */
export const hoursAgo = (hours: number): Instant => new Date(NOW - hours * HOUR).toISOString() as Instant;

/** A conversation `daysAgo` days before NOW. */
export const conversation = (
  id: string,
  overrides: Partial<z.input<typeof LinkableConversationSchema>> & { readonly daysAgo?: number } = {},
): LinkableConversation => {
  const { daysAgo = 1, ...rest } = overrides;
  return LinkableConversationSchema.parse({
    id,
    harness: 'claude-code',
    project: '/work/shop',
    preview: `Fix the ${id} page`,
    lastActivityAt: new Date(NOW - daysAgo * DAY).toISOString(),
    turns: 4,
    model: 'Sonnet 5.5',
    ...rest,
  });
};

export const listing = (
  conversations: readonly LinkableConversation[],
  matched = conversations.length,
  computerListed?: false,
): LinkListing =>
  LinkListingSchema.parse({
    conversations,
    matched,
    skipped: 0,
    ...(computerListed === undefined ? {} : { computerListed }),
  });

/** A ferret's summary, as Ferrets' `GET /v1/ferrets` answers it. */
export const ferret = (id: string, overrides: Partial<z.input<typeof FerretSummarySchema>> = {}): FerretSummary =>
  FerretSummarySchema.parse({
    id,
    name: `ferret-${id}`,
    role: 'lead',
    harness: 'claude-code',
    runner: 'tmux',
    folder: '/work/shop',
    state: 'idle',
    createdAt: hoursAgo(24 * 50),
    stateAt: hoursAgo(1),
    ...overrides,
  });

/**
 * A stand-in for the runtime slot Runtimes fills (`ferrets.move-account`): one button per wrapper of the harness it is
 * asked about, each proposing that wrapper, and the page’s own "no runtime" node when the harness has none.
 */
export const runtimeField =
  (wrappers: Readonly<Record<string, readonly string[]>>): RuntimeField =>
  props => {
    const offered = wrappers[props.harness] ?? [];
    if (offered.length === 0) return props.noAccounts as ReactNode;
    return createElement(
      'div',
      { role: 'radiogroup', 'aria-labelledby': props.labelId, 'data-test-runtimes': props.harness },
      offered.map(wrapper =>
        createElement(
          'button',
          {
            key: wrapper,
            type: 'button',
            'aria-pressed': props.value === wrapper,
            'data-test-runtime': wrapper,
            onClick: () => props.onValueChange(wrapper),
          },
          wrapper,
        ),
      ),
    );
  };

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
