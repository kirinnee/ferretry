/**
 * THE ONE MAP of what each palette is CALLED on screen. Every picker, tooltip and aria-label reads a palette's name from
 * here (through `PALETTES` in `catalog.ts`), so changing how palettes are named (a colour word or a proper name) is an edit to
 * this file alone. The ids are what a device stored and never change with a name.
 *
 * Owner (C59 O6, !A605): PROPER NAMES, each distinct and evocative, never a plain colour word. High contrast keeps its
 * functional name: it is the accessibility palette, and what it does is what a person looks for.
 */
import type { PaletteId } from '@ferretry/plugin-layouts/contract';

export const PALETTE_NAMES: Readonly<Record<PaletteId, string>> = Object.freeze({
  studio: 'Inkwell',
  geist: 'Skyline',
  mission: 'Sonar',
  neo: 'Pop Art',
  hacker: 'Terminal',
  vintage: 'Rustbelt',
  vaporwave: 'Vaporwave',
  mesh: 'Gradient mesh',
  aurora: 'Aurora',
  afterglow: 'Afterglow',
  briefing: 'Briefing',
  contrast: 'High contrast',
});
