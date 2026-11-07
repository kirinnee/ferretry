/**
 * @ferretry/plugin-layouts/contract — wire schemas, port + token, events, config declarations, words.
 * Layouts offers the `layout` and `theme` item kinds (§4.11): data, changed with one or two `fy` commands.
 */
import { defineConfig, defineEvent, definePort, neverLoosens, type Word } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { configDef } from './core.ts';
import {
  type CurrentLayout,
  LayoutIdSchema,
  type LayoutList,
  LayoutSchema,
  LayoutSelectionSchema,
  ThemeSchema,
} from './wire.ts';

export * from './wire.ts';

export const LAYOUTS_WORDS: readonly Word[] = [
  { word: 'layout', means: 'where things sit in the app', insteadOf: [] },
  { word: 'theme', means: 'colours, type and spacing', insteadOf: ['skin'] },
];

// ─── port ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LayoutsApi {
  list(): Promise<LayoutList>;
  /** The owner's layout with overrides applied, falling back to the built-in default when it cannot be used. */
  current(): Promise<CurrentLayout>;
}
export const LayoutsPort = definePort<LayoutsApi>('layouts');
export const LAYOUTS_READ_MODELS = ['list', 'current'] as const;

// ─── events ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The layout or theme changed (after its write): "each takes effect at once on every open app, through a wake-up" (§5.3). */
export const LayoutsChanged = defineEvent('layouts.changed', z.strictObject({ layout: LayoutIdSchema }));

// ─── config (§9.2, §7.2): none of it can widen spend or authority ───────────────────────────────────────────────────

/** `config/layout.yaml`: the selection and its overrides. */
export const LAYOUTS_SELECTION = configDef(
  defineConfig({ file: 'layout.yaml', schema: LayoutSelectionSchema, axis: 'configure', loosens: neverLoosens }),
);

const ITEM_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** `config/layouts/<name>.yaml`. */
export const LAYOUTS_ITEMS = configDef(
  defineConfig({
    collection: 'layouts',
    name: ITEM_NAME,
    schema: LayoutSchema,
    axis: 'configure',
    loosens: neverLoosens,
  }),
);

/** `config/themes/<name>.yaml`. */
export const LAYOUTS_THEMES = configDef(
  defineConfig({
    collection: 'themes',
    name: ITEM_NAME,
    schema: ThemeSchema,
    axis: 'configure',
    loosens: neverLoosens,
  }),
);
