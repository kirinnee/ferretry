import {
  BROWSER_MAX_HEIGHT,
  BROWSER_MAX_WIDTH,
  BROWSER_MIN_HEIGHT,
  BROWSER_MIN_WIDTH,
} from '../../../contract/index.ts';
import { UsageError, wholeNumber } from '../args.ts';
import type { Plan, VerbSpec } from '../plan.ts';
import { onBrowser } from './define.ts';
import { scrubbing, TEXT_SOURCE_FLAGS, typedText } from './typed-text.ts';

/** A required word that is present but blank, which the daemon would refuse in its own words. */
function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === '') throw new UsageError(`${label} is required`);
  return trimmed;
}

const optional = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
};

/** Viewport bounds come from the contract, the same definition the daemon validates against. */
function viewport(rawWidth: string, rawHeight: string): { readonly width: number; readonly height: number } {
  const width = wholeNumber(rawWidth, 'width');
  const height = wholeNumber(rawHeight, 'height');
  if (width < BROWSER_MIN_WIDTH || width > BROWSER_MAX_WIDTH)
    throw new UsageError(`width must be between ${String(BROWSER_MIN_WIDTH)} and ${String(BROWSER_MAX_WIDTH)}`);
  if (height < BROWSER_MIN_HEIGHT || height > BROWSER_MAX_HEIGHT)
    throw new UsageError(`height must be between ${String(BROWSER_MIN_HEIGHT)} and ${String(BROWSER_MAX_HEIGHT)}`);
  return { width, height };
}

const act = (action: string) => onBrowser([], {}, (): Plan => ({ kind: 'whole', body: { action } }));

/** Each of these is also spelled as v4 spelled it (`close`, `goto`): the same row under a second declared verb. */
const STOP = act('stop');
const NAVIGATE = onBrowser([{ name: 'url' }], {}, words => ({
  kind: 'whole',
  body: { action: 'navigate', url: required(words.need(0), 'URL') },
}));

/**
 * `fy browser <verb>`: the ferret's whole browser, through the per-ferret route (v4's `registerBrowserCommands`, the
 * session verbs). The ferret is `--ferret <id>` or the one this runs inside.
 */
export const WHOLE_BROWSER_VERBS = {
  'browser status': onBrowser([], {}, (): Plan => ({ kind: 'whole' })),
  'browser start': act('start'),
  'browser stop': STOP,
  'browser close': STOP,
  'browser back': act('back'),
  'browser forward': act('forward'),
  'browser reload': act('reload'),

  'browser open': onBrowser([{ name: 'url', optional: true }], {}, words => {
    const url = optional(words.arg(0));
    return { kind: 'whole', body: { action: 'open', ...(url === undefined ? {} : { url }) } };
  }),

  'browser new-page': onBrowser([{ name: 'url', optional: true }], {}, words => {
    const url = optional(words.arg(0));
    return { kind: 'whole', body: { action: 'new-page', ...(url === undefined ? {} : { url }) } };
  }),

  'browser activate-page': onBrowser([{ name: 'page id' }], {}, words => ({
    kind: 'whole',
    body: { action: 'activate-page', pageId: required(words.need(0), 'page id') },
  })),

  'browser close-page': onBrowser([{ name: 'page id' }], {}, words => ({
    kind: 'whole',
    body: { action: 'close-page', pageId: required(words.need(0), 'page id') },
  })),

  'browser navigate': NAVIGATE,
  'browser goto': NAVIGATE,

  'browser click': onBrowser([{ name: 'selector' }], {}, words => ({
    kind: 'whole',
    body: { action: 'click', selector: required(words.need(0), 'selector') },
  })),

  'browser type': onBrowser(
    [{ name: 'selector' }, { name: 'text', optional: true, rest: true }],
    TEXT_SOURCE_FLAGS,
    async (words, context): Promise<Plan> => {
      const typed = await typedText(words, 1, context);
      if ('refusal' in typed) return typed.refusal;
      return {
        kind: 'whole',
        body: { action: 'type', selector: required(words.need(0), 'selector'), text: typed.text },
        scrub: scrubbing(typed.text),
      };
    },
  ),

  'browser read': onBrowser([{ name: 'selector', optional: true }], {}, words => {
    const selector = optional(words.arg(0));
    return {
      kind: 'whole',
      body: { action: 'read', ...(selector === undefined ? {} : { selector }) },
      shows: 'text',
    };
  }),

  'browser screenshot': onBrowser([{ name: 'file' }], {}, words => ({
    kind: 'whole',
    body: { action: 'screenshot' },
    shows: 'screenshot',
    screenshotTo: required(words.need(0), 'output file'),
  })),

  'browser resize': onBrowser([{ name: 'width' }, { name: 'height' }], {}, words => ({
    kind: 'whole',
    body: { action: 'resize', ...viewport(words.need(0), words.need(1)) },
  })),
} as const satisfies Record<string, VerbSpec>;
