/**
 * THE RUNTIME PICKER IS ONE COMPACT CONTROL, NOT TWO OPEN LISTS (ferret-page-send, items 2 and 4).
 *
 * It sits in the composer's row (`composer.tools`). It used to draw the model list AND the reasoning list, open, in
 * the row: a four-row column beside a one-line text box, taller than the window, with Send painted below the fold. And
 * because it asked the daemon for the model catalog on mount, a daemon whose runtime discovery is not connected made
 * every composer on every page show a red "Account-aware model choices are unavailable" box.
 *
 * Now the bar holds three quiet readouts (model, thinking, speed). The lists live in ONE popover that opens on a tap on
 * any of them, on that one's list, and the catalog is asked for only then; a catalog that cannot be read says so once,
 * quietly, inside the popover.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must, settleUntil } from '@ferretry/app/testing';
import type { PanelProps } from '@ferretry/kernel/manifest';
import { createElement, type FunctionComponent } from 'react';
import { ferretSummary, THIRD_HARNESS_KEY } from '@ferretry/core-ferrets/contract/testing';
import { unsupportedHarnessSentence } from '../../../contract/harness-words.ts';
import { createRuntimePicker } from '../../../app/views/runtime-picker.tsx';
import type { LiveRuntimesClient, RuntimesClient } from '../../../app/lib/client.ts';
import { runtimeCatalog, runtimeView } from './support/picker.ts';

const CATALOG = {
  harness: 'claude',
  source: 'wrapper-inventory',
  choices: [
    { value: 'claude-opus-5', label: 'Opus 5', isDefault: true, reasoningEfforts: [], fast: true },
    { value: 'claude-sonnet-5', label: 'Sonnet 5', reasoningEfforts: [], fast: false },
  ],
};

interface Asked {
  readonly route: string;
  readonly body?: unknown;
}

/** A daemon that answers the ferret and (unless `discovery` is off) its model catalog; every route asked is recorded. */
const daemon = (
  discovery: boolean,
  ferret: Record<string, unknown> = {},
  catalog: unknown = CATALOG,
): { readonly client: RuntimesClient; readonly asked: Asked[] } => {
  const roster = runtimeCatalog(runtimeView({ wrapper: 'claude-you' }));
  const asked: Asked[] = [];
  const client = {
    call: async (route: string, input?: { readonly body?: unknown }) => {
      asked.push({ route, ...(input?.body === undefined ? {} : { body: input.body }) });
      if (route === 'GET /v1/runtimes') return roster;
      if (route === 'GET /v1/ferrets/:ferretId')
        return ferretSummary({
          id: 's-1',
          harness: 'claude-code',
          runtime: 'claude-you',
          model: 'claude-sonnet-5',
          state: 'idle',
          effort: 'high',
          ...ferret,
        });
      if (route === 'GET /v1/ferrets/:id/runtime-models') {
        if (discovery) return catalog;
        throw new Error('Runtime model discovery is not connected to Ferrets yet.');
      }
      return {};
    },
  } as unknown as RuntimesClient;
  return { client, asked };
};

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const draw = async (client: RuntimesClient): Promise<HTMLElement> => {
  const Picker = createRuntimePicker(client) as unknown as FunctionComponent<PanelProps>;
  mounted = await mount(createElement(Picker, { subject: 's-1' } as PanelProps));
  const root = mounted.container;
  await settleUntil(
    () => root.querySelector('[data-runtime-picker]') !== null,
    () => `the picker drew its chip; drew: ${root.textContent ?? ''}`,
    interact,
  );
  return root;
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 8; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

/** The popover is a portal: it lives in the document, not in the composer's row. */
const popover = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-runtime-popover]');

describe('the runtime picker in the composer row', () => {
  it('is three readouts and nothing else at rest: no list, no catalog request, no error', async () => {
    const { client, asked } = daemon(false);
    const root = await draw(client);
    await settle();

    expect(root.querySelectorAll('[data-runtime-chip]')).toHaveLength(3);
    expect(root.querySelector('[role="menu"]')).toBeNull();
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.textContent).not.toContain('unavailable');
    expect(popover()).toBeNull();
    expect(asked.map(call => call.route)).not.toContain('GET /v1/ferrets/:id/runtime-models');
  });

  it('shows the model, the thinking level and the speed on the bar, each a button that opens a dialog', async () => {
    const root = await draw(daemon(true).client);
    const chips = [...root.querySelectorAll<HTMLElement>('[data-runtime-chip]')];
    expect(chips.map(chip => chip.textContent)).toEqual(['claude-sonnet-5', 'high', 'Normal']);
    expect(chips.map(chip => chip.getAttribute('data-runtime-chip'))).toEqual(['model', 'effort', 'speed']);
    for (const chip of chips) {
      expect(chip.getAttribute('aria-haspopup')).toBe('dialog');
      expect(chip.getAttribute('aria-expanded')).toBe('false');
    }
    expect(chips[0]?.getAttribute('aria-label')).toBe('Change the model — claude-sonnet-5 · high');
  });

  it('says a plain word, never a guess, for a value the ferret has not reported', async () => {
    const root = await draw(daemon(true, { model: undefined, effort: undefined }).client);
    const chips = [...root.querySelectorAll<HTMLElement>('[data-runtime-chip]')];
    expect(chips.map(chip => chip.textContent)).toEqual(['Model', 'Thinking', 'Normal']);
  });

  it('reads fast mode when the ferret was launched in it', async () => {
    const root = await draw(daemon(true, { fast: true }).client);
    const speed = must(root.querySelector<HTMLElement>('[data-runtime-chip="speed"]'), 'the speed chip');
    expect(speed.textContent).toBe('Fast');
  });

  it('opens one popover with the model, thinking and speed lists on a tap, outside the row, and closes on Escape', async () => {
    const { client, asked } = daemon(true, { model: 'claude-opus-5' });
    const root = await draw(client);
    const chip = must(root.querySelector<HTMLElement>('[data-runtime-chip="model"]'), 'the chip');
    await interact(() => chip.click());
    await settle();

    const open = must(popover(), 'the popover');
    expect(root.contains(open)).toBe(false);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(open.querySelectorAll('[role="menu"]')).toHaveLength(3);
    expect(open.textContent).toContain('Opus 5');
    expect(asked.map(call => call.route)).toContain('GET /v1/ferrets/:id/runtime-models');

    await interact(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      open.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();
    expect(popover()).toBeNull();
    expect(chip.getAttribute('aria-expanded')).toBe('false');
  });

  it('says in plain words which runtime the ferret runs on, never its stored name', async () => {
    const root = await draw(daemon(true).client);
    await interact(() => must(root.querySelector<HTMLElement>('[data-runtime-chip="model"]'), 'the chip').click());
    await settleUntil(
      () => popover()?.querySelector('[data-runtime-runs-on]') != null,
      () => `the popover named the runtime; drew: ${popover()?.textContent ?? ''}`,
      interact,
    );
    expect(popover()?.querySelector('[data-runtime-runs-on]')?.textContent).toBe(
      'Runs on Claude · your terminal sign-in',
    );
  });

  it('closes on a tap outside the popover', async () => {
    const root = await draw(daemon(true).client);
    await interact(() => must(root.querySelector<HTMLElement>('[data-runtime-chip="model"]'), 'the chip').click());
    await settle();
    expect(popover()).not.toBeNull();
    await interact(() => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await settle();
    expect(popover()).toBeNull();
  });

  it('says once, quietly, inside the popover that the catalog cannot be read — never a red alert', async () => {
    const root = await draw(daemon(false).client);
    await interact(() => must(root.querySelector<HTMLElement>('[data-runtime-chip="model"]'), 'the chip').click());
    await settle();

    const open = must(popover(), 'the popover');
    expect(open.querySelector('[role="alert"]')).toBeNull();
    const said = open.textContent?.match(/not connected to Ferrets yet/g) ?? [];
    expect(said).toHaveLength(1);
    // The reasoning levels do not need the catalog: they are still offered.
    expect(open.textContent).toContain('Low');
  });

  it('opens on the list of the chip that was tapped: that list holds focus, and another chip moves it', async () => {
    const root = await draw(daemon(true, { model: 'claude-opus-5' }).client);
    const speed = must(root.querySelector<HTMLElement>('[data-runtime-chip="speed"]'), 'the speed chip');
    await interact(() => speed.click());
    await settle();
    const open = must(popover(), 'the popover');
    const inList = (key: string): boolean =>
      open.querySelector(`[data-runtime-list="${key}"]`)?.contains(document.activeElement) === true;
    expect(speed.getAttribute('aria-expanded')).toBe('true');
    expect(inList('speed')).toBe(true);
    expect(open.querySelector('[data-runtime-list="speed"] [aria-checked="true"]')?.textContent).toContain('Normal');

    const effort = must(root.querySelector<HTMLElement>('[data-runtime-chip="effort"]'), 'the thinking chip');
    await interact(() => effort.click());
    await settle();
    expect(popover()).not.toBeNull();
    expect(effort.getAttribute('aria-expanded')).toBe('true');
    expect(inList('effort')).toBe(true);
    // The level the bar names is the level checked in its list.
    expect(open.querySelector('[data-runtime-list="effort"] [aria-checked="true"]')?.textContent).toContain('High');
  });

  it('switches to fast on the daemon’s fast action, closes, and names Fast on the bar', async () => {
    const { client, asked } = daemon(true, { model: 'claude-opus-5' });
    const root = await draw(client);
    await interact(() => must(root.querySelector<HTMLElement>('[data-runtime-chip="speed"]'), 'the chip').click());
    await settle();
    const fastChoice = must(
      [
        ...must(popover(), 'the popover').querySelectorAll<HTMLElement>(
          '[data-runtime-list="speed"] [role="menuitemradio"]',
        ),
      ].find(item => item.textContent?.includes('Fast')),
      'the Fast choice',
    );
    await interact(() => fastChoice.click());
    await settle();

    expect(asked.find(call => call.route === 'POST /v1/ferrets/:id/runtime')?.body).toEqual({
      action: 'fast',
      fast: true,
    });
    expect(popover()).toBeNull();
    expect(must(root.querySelector<HTMLElement>('[data-runtime-chip="speed"]'), 'the chip').textContent).toBe('Fast');
  });

  it('says in a sentence, not a dead choice, when the model in force has no fast mode', async () => {
    const root = await draw(daemon(true).client);
    await interact(() => must(root.querySelector<HTMLElement>('[data-runtime-chip="speed"]'), 'the chip').click());
    await settle();
    const list = must(popover()?.querySelector('[data-runtime-list="speed"]'), 'the speed list');
    expect(list.textContent).toContain('claude-sonnet-5 has no fast mode');
    expect(list.querySelector('[role="menuitemradio"]')).toBeNull();
  });
});

const choiceOf = (list: string, text: string): HTMLButtonElement =>
  must(
    [...document.querySelectorAll<HTMLButtonElement>(`[data-runtime-list="${list}"] [role="menuitemradio"]`)].find(
      item => item.textContent?.includes(text),
    ),
    `the ${text} choice of the ${list} list`,
  );

describe('the runtime picker reads the ferret as it stands NOW', () => {
  const CODEX = {
    harness: 'codex',
    source: 'codex-app-server',
    choices: [
      { value: 'gpt-5.5', label: 'GPT-5.5', reasoningEfforts: [{ value: 'medium' }, { value: 'high' }] },
      { value: 'gpt-5.6', label: 'GPT-5.6', reasoningEfforts: [{ value: 'medium' }, { value: 'xhigh' }] },
    ],
  };

  it('keeps a new Codex model when the thinking level is changed next (it used to send the old model back)', async () => {
    const { client, asked } = daemon(true, { harness: 'codex', model: 'gpt-5.5', effort: 'medium' }, CODEX);
    const root = await draw(client);
    await interact(() => must(root.querySelector<HTMLElement>('[data-runtime-chip="model"]'), 'the chip').click());
    await settle();
    await interact(() => choiceOf('model', 'GPT-5.6').click());
    await settle();
    await interact(() =>
      must(document.querySelector<HTMLElement>('[aria-label="Set GPT-5.6 reasoning to Extra high"]'), 'xhigh').click(),
    );
    await settle();
    expect(asked.filter(call => call.route === 'POST /v1/ferrets/:id/runtime').at(-1)?.body).toEqual({
      action: 'model',
      model: 'gpt-5.6',
      effort: 'xhigh',
    });

    // Now only the thinking level: the model in force is the one just chosen.
    await interact(() => choiceOf('effort', 'Medium').click());
    await settle();
    const posts = asked.filter(call => call.route === 'POST /v1/ferrets/:id/runtime');
    expect(posts.at(-1)?.body).toEqual({ action: 'model', model: 'gpt-5.6', effort: 'medium' });
  });

  it('enables the controls when a ferret that was working when the page opened goes idle', async () => {
    let state = 'working';
    let notify: (() => void) | undefined;
    const client = {
      call: async (route: string) => {
        if (route === 'GET /v1/ferrets/:ferretId')
          return ferretSummary({ id: 's-1', harness: 'claude-code', model: 'claude-opus-5', state, effort: 'high' });
        if (route === 'GET /v1/ferrets/:id/runtime-models') return CATALOG;
        return {};
      },
      subscribe: (_event: unknown, handler: (changed: { ferret: string; generation: number }) => void) => {
        notify = () => handler({ ferret: 's-1', generation: 2 });
        return () => undefined;
      },
    } as unknown as LiveRuntimesClient;
    const root = await draw(client);
    await interact(() => must(root.querySelector<HTMLElement>('[data-runtime-chip="effort"]'), 'the chip').click());
    await settle();
    expect(choiceOf('effort', 'Low').disabled).toBe(true);

    state = 'idle';
    await interact(() => notify?.());
    await settle();
    expect(choiceOf('effort', 'Low').disabled).toBe(false);
  });
});

describe('Fast is offered only when the catalog confirms it for the model in force', () => {
  const fastChoice = (): HTMLButtonElement => choiceOf('speed', 'Fast');
  const openSpeed = async (client: RuntimesClient): Promise<void> => {
    const root = await draw(client);
    await interact(() => must(root.querySelector<HTMLElement>('[data-runtime-chip="speed"]'), 'the chip').click());
    await settle();
  };

  it('draws Fast disabled, with a reason, while the catalog is still loading; Normal stays choosable', async () => {
    const pending = {
      call: async (route: string) => {
        if (route === 'GET /v1/ferrets/:ferretId')
          return ferretSummary({ id: 's-1', harness: 'claude-code', model: 'claude-opus-5', state: 'idle' });
        return new Promise(() => undefined);
      },
    } as unknown as RuntimesClient;
    await openSpeed(pending);
    expect(fastChoice().disabled).toBe(true);
    expect(fastChoice().textContent).toContain('Checking whether this model has Fast');
    expect(choiceOf('speed', 'Normal').disabled).toBe(false);
  });

  it('draws Fast disabled, with a reason, when the catalog cannot be read', async () => {
    await openSpeed(daemon(false, { model: 'claude-opus-5' }).client);
    expect(fastChoice().disabled).toBe(true);
    expect(fastChoice().textContent).toContain('the model list is unavailable');
    expect(choiceOf('speed', 'Normal').disabled).toBe(false);
  });

  it('draws Fast disabled, with a reason, when the model in force is not in the catalog', async () => {
    await openSpeed(daemon(true, { model: 'claude-mystery-9' }).client);
    expect(fastChoice().disabled).toBe(true);
    expect(fastChoice().textContent).toContain('this model is not in the list');
  });

  it('offers Fast when the catalog confirms the model has it', async () => {
    await openSpeed(daemon(true, { model: 'claude-opus-5' }).client);
    expect(fastChoice().disabled).toBe(false);
  });
});

describe('the runtime picker for a ferret on a harness this build has no behaviour for (through the route parser)', () => {
  it("draws its bar and says the one sentence in every list, never a parse error and never Claude's controls", async () => {
    const { client, asked } = daemon(true, { harness: THIRD_HARNESS_KEY });
    const root = await draw(client);
    await settle();
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.textContent).not.toContain('cannot read');
    const chip = must(root.querySelector<HTMLElement>('[data-runtime-chip="model"]'), 'the model chip');
    await interact(() => chip.click());
    await settle();
    const text = must(popover(), 'the popover').textContent ?? '';
    expect(text).toContain(unsupportedHarnessSentence(THIRD_HARNESS_KEY));
    expect(text).not.toContain('Opus 5');
    expect(asked.map(call => call.route)).not.toContain('GET /v1/ferrets/:id/runtime-models');
  });
});
