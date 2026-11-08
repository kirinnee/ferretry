import { describe, expect, test } from 'bun:test';
import { BUILT_IN_LAYOUTS } from '@ferretry/plugin-layouts/contract';
import { generated } from '../../../src/generated/surfaces.ts';
import { viewsOf } from '../../../src/layout/engine.ts';
import { checkLayout, chooseLayout } from '../../../src/layout/layout.ts';

/**
 * The layouts Layouts ships name views by id. The manifests are the truth for those ids, so the shipped default and
 * compact layouts are proved against the real compiled manifests: a renamed screen or panel fails here, not in a
 * browser that quietly draws the built-in instead of the layout it was served.
 */
const installed = viewsOf(generated.surfaces).installed;

describe('the shipped layouts against the generated surfaces', () => {
  for (const layout of BUILT_IN_LAYOUTS) {
    test(`the ${layout.id} layout names only views a manifest declares`, () => {
      expect(checkLayout(layout, installed)).toEqual([]);
    });

    test(`the ${layout.id} layout is accepted by chooseLayout, never refused for the built-in`, () => {
      expect(chooseLayout([layout], installed)).toEqual({ kind: 'applied', layout });
    });
  }
});
