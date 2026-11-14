import { definePlugin, route, settingsTab, verb } from '@ferretry/kernel/manifest';
import { cap } from '@ferretry/core-gate/contract';
import {
  LAYOUTS_ITEMS,
  LAYOUTS_READ_MODELS,
  LAYOUTS_SELECTION,
  LAYOUTS_THEMES,
  LAYOUTS_WORDS,
  LayoutsChanged,
  LayoutsPort,
} from './contract/index.ts';

/**
 * Layouts (§2.3, §5.3): how the app looks and is arranged, as data. NEW in 5.0, so there is no route table of today's
 * to copy. A read is for any credential this daemon issued (the app draws with it) and is ungoverned: a layout holds
 * view names, never data. A write changes the owner's layout on every device, so it is a person's `fleet.configure`
 * act; a device's own choice (`--device`) is the app's saved data and has no route. Nothing here can widen spend or
 * authority, so no config file of this plugin loosens (§7.2).
 */
export default definePlugin({
  id: 'layouts',
  title: 'Layouts',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['layout', 'theme', 'command', 'view'],
  words: LAYOUTS_WORDS,

  provides: { layouts: LayoutsPort },

  actions: {
    routes: [
      route('GET /v1/layouts', {
        minimum: 'authenticated',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a read' },
        guard: { none: 'view names and ids only' },
      }),
      route('GET /v1/layouts/current', {
        minimum: 'authenticated',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a read' },
        guard: { none: 'view names, ids and theme tokens only' },
      }),
      route('GET /v1/layouts/themes', {
        minimum: 'authenticated',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a read' },
        guard: { none: 'theme ids only' },
      }),
      route('GET /v1/layouts/:layoutId', {
        minimum: 'authenticated',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a read' },
        guard: { none: 'view names only' },
      }),
      route('PATCH /v1/layouts/current', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { skip: 'a presentation preference: changes no authority or spend' },
        guard: { none: 'view names only' },
      }),
      route('PUT /v1/layouts/current', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { skip: 'a presentation preference: changes no authority or spend' },
        guard: { none: 'view names only' },
      }),
      route('PUT /v1/layouts/theme', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { skip: 'a presentation preference: changes no authority or spend' },
        guard: { none: 'theme ids only' },
      }),
      route('POST /v1/layouts/reset', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { skip: 'a presentation preference: changes no authority or spend' },
        guard: { none: 'view names only' },
      }),
      route('POST /v1/layouts', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { skip: 'saves a presentation preference as a shareable item' },
        guard: { none: 'view names only' },
      }),
      route('DELETE /v1/layouts/:layoutId', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { skip: 'removes a saved presentation preference' },
        guard: { none: 'the layout id' },
      }),
    ],
    cli: [
      verb('layout show', {
        summary: 'the layout in use, with your changes applied',
        args: [],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('layout list', {
        summary: 'the installed layouts and themes',
        args: [],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('layout set', {
        summary: 'change one key of the layout: fy layout set nav.side right',
        args: [
          { name: 'path', help: 'the key to change, e.g. nav.side' },
          { name: 'value', help: 'the new value', variadic: true },
        ],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('layout use', {
        summary: 'switch to another installed layout',
        args: [{ name: 'name', help: 'the layout’s name' }],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('layout reset', {
        summary: 'drop your changes and use the built-in default',
        args: [],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('layout save', {
        summary: 'save the layout in use as a new, shareable layout item',
        args: [{ name: 'name', help: 'the name for the new layout' }],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('theme list', {
        summary: 'the installed themes',
        args: [],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('theme use', {
        summary: 'switch theme',
        args: [{ name: 'name', help: 'the theme’s name' }],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
    ],
  },

  ui: {
    settings: [settingsTab('layout', { label: 'Layout', order: 15 })],
    layouts: [
      { id: 'default', file: 'layouts/default.yaml' },
      { id: 'compact', file: 'layouts/compact.yaml' },
    ],
    themes: [{ id: 'default', file: 'themes/default.yaml' }],
  },

  data: {
    config: [LAYOUTS_SELECTION, LAYOUTS_ITEMS, LAYOUTS_THEMES],
    readModels: LAYOUTS_READ_MODELS,
    publishes: [LayoutsChanged],
  },

  permissions: { roots: [], network: [], spawn: [], secrets: [] },
});
