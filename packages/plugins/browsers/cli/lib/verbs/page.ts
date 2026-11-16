import { flag, UsageError } from '../args.ts';
import {
  distanceArgument,
  elementArgument,
  geolocationArgument,
  HISTORY_STEPS,
  prefixed,
  targetArgument,
  uploadFile,
  viewportArgument,
} from '../inputs.ts';
import { BROWSER_WAIT_DEFAULT_TOTAL_MS, BROWSER_WAIT_TOTAL_MAX_MS } from '../limits.ts';
import type { Plan, VerbSpec } from '../plan.ts';
import { byPerson, onPages, PAGE, TARGET } from './define.ts';
import { scrubbing, TEXT_SOURCE_FLAGS, typedText } from './typed-text.ts';

const ASK = flag.either('ask');
/** The words of a hand-over to the owner, after the page: what they should do there (never a secret). */
const MESSAGE = { name: 'message', optional: true, rest: true } as const;

/** Omit a field that was not given, so the daemon's own defaults apply. */
const given = <T>(key: string, value: T | undefined): Record<string, T> =>
  value === undefined ? {} : { [key]: value };

const only = (key: string, on: boolean): Record<string, true> => (on ? { [key]: true } : {});

/**
 * `fy browser page …`: the ferret's pages by name — one browser tool each (`browser_*`), the same acts an agent's
 * tools take, for scripts and for people (v4's `registerBrowserPageCommands`).
 */
export const PAGE_VERBS = {
  'browser page list': onPages([], {}, () => ({ kind: 'tool', tool: 'browser_list', input: {} })),

  'browser page open': onPages(
    [PAGE, { name: 'url', optional: true }],
    { incognito: flag.on('incognito'), ask: ASK },
    words => ({
      kind: 'tool',
      tool: 'browser_open',
      input: {
        name: words.need(0),
        ...given('url', words.arg(1)),
        ...only('incognito', words.on('incognito')),
        ...given('askOwner', words.either('ask')),
      },
    }),
  ),

  'browser page navigate': onPages([PAGE, { name: 'url (or back, forward, reload)' }], {}, words => {
    const where = words.need(1);
    return {
      kind: 'tool',
      tool: 'browser_navigate',
      input: { name: words.need(0), ...(HISTORY_STEPS.has(where) ? { history: where } : { url: where }) },
    };
  }),

  'browser page click': onPages([PAGE, TARGET], { double: flag.on('double'), right: flag.on('right') }, words => ({
    kind: 'tool',
    tool: 'browser_click',
    input: {
      name: words.need(0),
      ...targetArgument(words.need(1)),
      ...only('double', words.on('double')),
      ...(words.on('right') ? { button: 'right' } : {}),
    },
  })),

  'browser page type': onPages(
    [PAGE, TARGET, { name: 'text', optional: true, rest: true }],
    { submit: flag.on('submit'), slowly: flag.on('slowly'), ...TEXT_SOURCE_FLAGS },
    async (words, context): Promise<Plan> => {
      const typed = await typedText(words, 2, context);
      if ('refusal' in typed) return typed.refusal;
      return {
        kind: 'tool',
        tool: 'browser_type',
        input: {
          name: words.need(0),
          ...elementArgument(words.need(1)),
          text: typed.text,
          ...only('submit', words.on('submit')),
          ...only('slowly', words.on('slowly')),
        },
        scrub: scrubbing(typed.text),
      };
    },
  ),

  'browser page hover': onPages([PAGE, TARGET], {}, words => ({
    kind: 'tool',
    tool: 'browser_hover',
    input: { name: words.need(0), ...targetArgument(words.need(1)) },
  })),

  'browser page drag': onPages([PAGE, { name: 'from' }, { name: 'to' }], { steps: flag.whole('steps') }, words => ({
    kind: 'tool',
    tool: 'browser_drag',
    input: {
      name: words.need(0),
      ...prefixed('from', targetArgument(words.need(1))),
      ...prefixed('to', targetArgument(words.need(2))),
      ...given('steps', words.num('steps')),
    },
  })),

  'browser page press': onPages([PAGE, { name: 'key', rest: true }], { on: flag.text('on') }, words => ({
    kind: 'tool',
    tool: 'browser_press',
    input: {
      name: words.need(0),
      keys: words.from(1),
      ...(words.text('on') === undefined ? {} : elementArgument(words.text('on') as string)),
    },
  })),

  'browser page scroll': onPages(
    [PAGE],
    { to: flag.text('to'), text: flag.text('text'), by: flag.text('by'), pages: flag.number('pages') },
    words => ({
      kind: 'tool',
      tool: 'browser_scroll',
      input: {
        name: words.need(0),
        ...(words.text('to') === undefined ? {} : elementArgument(words.text('to') as string)),
        ...given('text', words.text('text')),
        ...(words.text('by') === undefined ? {} : distanceArgument(words.text('by') as string)),
        ...given('pages', words.num('pages')),
      },
    }),
  ),

  'browser page select': onPages([PAGE, TARGET, { name: 'value', rest: true }], {}, words => ({
    kind: 'tool',
    tool: 'browser_select',
    input: { name: words.need(0), ...elementArgument(words.need(1)), values: words.from(2) },
  })),

  'browser page check': onPages([PAGE, TARGET], { off: flag.on('off') }, words => ({
    kind: 'tool',
    tool: 'browser_check',
    input: { name: words.need(0), ...elementArgument(words.need(1)), checked: !words.on('off') },
  })),

  'browser page highlight': onPages([PAGE, { name: 'target', optional: true }], { clear: flag.on('clear') }, words => ({
    kind: 'tool',
    tool: 'browser_highlight',
    input: {
      name: words.need(0),
      ...(words.arg(1) === undefined ? {} : elementArgument(words.arg(1) as string)),
      ...only('clear', words.on('clear')),
    },
  })),

  'browser page read': onPages(
    [PAGE],
    {
      a11y: flag.on('a11y'),
      snapshot: flag.on('snapshot'),
      find: flag.text('find'),
      selector: flag.text('selector'),
    },
    words => ({
      kind: 'tool',
      tool: 'browser_read',
      input: {
        name: words.need(0),
        ...(words.on('snapshot') || words.text('find') !== undefined
          ? { mode: 'snapshot' }
          : words.on('a11y')
            ? { mode: 'a11y' }
            : {}),
        ...given('find', words.text('find')),
        ...(words.text('selector') === undefined ? {} : elementArgument(words.text('selector') as string)),
      },
    }),
  ),

  'browser page screenshot': onPages(
    [PAGE, { name: 'file' }],
    { fullPage: flag.on('full-page'), jpeg: flag.on('jpeg'), of: flag.text('of') },
    words => ({
      kind: 'tool',
      tool: 'browser_screenshot',
      input: {
        name: words.need(0),
        ...(words.text('of') === undefined ? {} : elementArgument(words.text('of') as string)),
        ...only('fullPage', words.on('fullPage')),
        ...(words.on('jpeg') ? { format: 'jpeg' } : {}),
      },
      screenshotTo: words.need(1),
    }),
  ),

  'browser page dialog': onPages(
    [PAGE, { name: 'action (accept or dismiss)' }],
    { text: flag.text('text') },
    words => ({
      kind: 'tool',
      tool: 'browser_dialog',
      input: { name: words.need(0), action: words.need(1), ...given('promptText', words.text('text')) },
    }),
  ),

  'browser page tabs': onPages(
    [
      { name: 'action (list or adopt)', optional: true },
      { name: 'popup id', optional: true },
      { name: 'name to give it', optional: true },
    ],
    {},
    words => ({
      kind: 'tool',
      tool: 'browser_tabs',
      input: { action: words.arg(0) ?? 'list', ...given('id', words.arg(1)), ...given('as', words.arg(2)) },
    }),
  ),

  'browser page wait': onPages(
    [PAGE],
    {
      ref: flag.text('ref'),
      selector: flag.text('selector'),
      state: flag.text('state'),
      text: flag.text('text'),
      textGone: flag.text('text-gone'),
      url: flag.text('url'),
      load: flag.text('load'),
      time: flag.whole('time'),
      timeout: flag.whole('timeout', 't'),
    },
    words => {
      const totalMs = words.num('timeout') ?? BROWSER_WAIT_DEFAULT_TOTAL_MS;
      if (!(totalMs >= 100 && totalMs <= BROWSER_WAIT_TOTAL_MAX_MS))
        throw new UsageError(`--timeout must be between 100 and ${String(BROWSER_WAIT_TOTAL_MAX_MS)} milliseconds`);
      return {
        kind: 'wait',
        input: {
          name: words.need(0),
          ...given('ref', words.text('ref')),
          ...given('selector', words.text('selector')),
          ...given('state', words.text('state')),
          ...given('text', words.text('text')),
          ...given('textGone', words.text('textGone')),
          ...given('url', words.text('url')),
          ...given('load', words.text('load')),
          ...given('time', words.num('time')),
        },
        totalMs,
      };
    },
  ),

  'browser page console': onPages(
    [PAGE],
    { level: flag.text('level'), since: flag.whole('since'), limit: flag.whole('limit') },
    words => ({
      kind: 'tool',
      tool: 'browser_console',
      input: {
        name: words.need(0),
        ...given('level', words.text('level')),
        ...given('since', words.num('since')),
        ...given('limit', words.num('limit')),
      },
    }),
  ),

  'browser page network': onPages(
    [PAGE, { name: 'request id', optional: true }],
    { filter: flag.text('filter'), type: flag.list('type') },
    words => ({
      kind: 'tool',
      tool: 'browser_network',
      input: {
        name: words.need(0),
        action: words.arg(1) === undefined ? 'list' : 'get',
        ...given('id', words.arg(1)),
        ...given('filter', words.text('filter')),
        ...given('types', words.list('type')),
      },
    }),
  ),

  'browser page emulate': onPages(
    [PAGE],
    {
      viewport: flag.text('viewport'),
      colorScheme: flag.text('color-scheme'),
      reducedMotion: flag.text('reduced-motion'),
      forcedColors: flag.text('forced-colors'),
      contrast: flag.text('contrast'),
      print: flag.on('print'),
      geolocation: flag.text('geolocation'),
      locale: flag.text('locale'),
      timezone: flag.text('timezone'),
      cpuThrottle: flag.number('cpu-throttle'),
      offline: flag.on('offline'),
      latency: flag.whole('latency'),
      throughput: flag.whole('throughput'),
      permission: flag.list('permission'),
      reset: flag.on('reset'),
    },
    words => {
      const media = {
        ...given('colorScheme', words.text('colorScheme')),
        ...given('reducedMotion', words.text('reducedMotion')),
        ...given('forcedColors', words.text('forcedColors')),
        ...given('contrast', words.text('contrast')),
        ...only('print', words.on('print')),
      };
      const network = {
        ...only('offline', words.on('offline')),
        ...given('latency', words.num('latency')),
        ...given('throughput', words.num('throughput')),
      };
      return {
        kind: 'tool',
        tool: 'browser_emulate',
        input: {
          name: words.need(0),
          ...(words.text('viewport') === undefined
            ? {}
            : { viewport: viewportArgument(words.text('viewport') as string) }),
          ...(Object.keys(media).length === 0 ? {} : { media }),
          ...(words.text('geolocation') === undefined
            ? {}
            : { geolocation: geolocationArgument(words.text('geolocation') as string) }),
          ...given('locale', words.text('locale')),
          ...given('timezone', words.text('timezone')),
          ...given('cpuThrottle', words.num('cpuThrottle')),
          ...(Object.keys(network).length === 0 ? {} : { network }),
          ...given('permissions', words.list('permission')),
          ...only('reset', words.on('reset')),
        },
      };
    },
  ),

  'browser page upload': onPages([PAGE, TARGET, { name: 'file', rest: true }], { drop: flag.on('drop') }, words => ({
    kind: 'tool',
    tool: 'browser_upload',
    input: {
      name: words.need(0),
      ...elementArgument(words.need(1)),
      files: words.from(2).map(uploadFile),
      ...(words.on('drop') ? { mode: 'drop' } : {}),
    },
  })),

  'browser page download': onPages(
    [PAGE, { name: 'save as', optional: true }],
    { id: flag.text('id'), overwrite: flag.on('overwrite') },
    words => ({
      kind: 'tool',
      tool: 'browser_download',
      input: {
        name: words.need(0),
        ...given('id', words.text('id')),
        ...given('saveAs', words.arg(1)),
        ...only('overwrite', words.on('overwrite')),
      },
    }),
  ),

  'browser page pdf': onPages(
    [PAGE, { name: 'save as', optional: true }],
    { overwrite: flag.on('overwrite') },
    words => ({
      kind: 'tool',
      tool: 'browser_pdf',
      input: { name: words.need(0), ...given('saveAs', words.arg(1)), ...only('overwrite', words.on('overwrite')) },
    }),
  ),

  'browser page eval': onPages(
    [PAGE, { name: 'function' }],
    { of: flag.text('of'), timeout: flag.whole('timeout') },
    words => ({
      kind: 'tool',
      tool: 'browser_eval',
      input: {
        name: words.need(0),
        function: words.need(1),
        ...(words.text('of') === undefined ? {} : elementArgument(words.text('of') as string)),
        ...given('timeoutMs', words.num('timeout')),
      },
    }),
  ),

  'browser page close': onPages([PAGE], {}, words => ({
    kind: 'tool',
    tool: 'browser_close',
    input: { name: words.need(0) },
  })),

  'browser page ask': onPages([PAGE, MESSAGE], {}, words => ({
    kind: 'tool',
    tool: 'browser_ask_owner',
    input: { name: words.need(0), ...given('message', words.words(1)) },
  })),

  'browser page takeover': byPerson([PAGE], {}, words => ({
    kind: 'control',
    action: 'takeover',
    key: words.need(0),
  })),
  'browser page handback': byPerson([PAGE], {}, words => ({
    kind: 'control',
    action: 'handback',
    key: words.need(0),
  })),
  'browser page handover': byPerson([PAGE], {}, words => ({
    kind: 'control',
    action: 'handover',
    key: words.need(0),
  })),
  'browser page control': byPerson([], {}, () => ({ kind: 'view' })),
} as const satisfies Record<string, VerbSpec>;
