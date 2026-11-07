/**
 * Layouts' wire schemas. Layouts and themes are NEW in 5.0 (today the layout is hard-coded in `App.tsx`); the shapes
 * follow design §5.3 field for field. Both are items (§4.9, §4.11), so a catalog can share them.
 */
import { z } from 'zod';

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const LayoutIdSchema = z.string().max(64).regex(ID);
export type LayoutId = z.infer<typeof LayoutIdSchema>;
export const ThemeIdSchema = z.string().max(64).regex(ID);
export type ThemeId = z.infer<typeof ThemeIdSchema>;

/** Where the nav sits. */
export const NavSideSchema = z.enum(['left', 'right', 'top', 'bottom']);
export type NavSide = z.infer<typeof NavSideSchema>;

/** A view name the layout refers to: a screen id, a panel id or a slot entry. Checked against the installed views by `fy plugin check`. */
const ViewNameSchema = z.string().min(1).max(64);

const NavSchema = z.strictObject({
  side: NavSideSchema,
  style: z.enum(['rail', 'bar']),
  items: z.array(ViewNameSchema),
});

/** `layouts/<name>.yaml`. */
export const LayoutSchema = z.strictObject({
  id: LayoutIdSchema,
  nav: NavSchema,
  /** The second column: none, only on wide screens, or always; and what it holds (a screen or panels). */
  side: z.strictObject({ show: z.enum(['none', 'wide-only', 'always']), holds: ViewNameSchema }),
  top: z.array(ViewNameSchema).default([]),
  'composer.tools': z.array(ViewNameSchema).default([]),
  /** Panels by slot name (`ferret.side`, `card.detail`, …). */
  panels: z.record(z.string(), z.array(ViewNameSchema)).default({}),
  density: z.enum(['compact', 'comfortable']),
  /** Overrides on narrow screens. */
  phone: z.strictObject({ nav: NavSchema.pick({ side: true, items: true }) }).optional(),
});
export type Layout = z.infer<typeof LayoutSchema>;

/** `themes/<name>.yaml`: colour, type and spacing tokens. The token names are the app shell's. */
export const ThemeSchema = z.strictObject({
  id: ThemeIdSchema,
  tokens: z.record(z.string(), z.union([z.string(), z.number()])),
});
export type Theme = z.infer<typeof ThemeSchema>;

/**
 * `config/layout.yaml`: which layout and theme are in use for the owner, and the keys changed from it
 * (`fy layout set nav.side right`). An ordinary, non-loosening config file (§7.2). A device's own choice (`--device`)
 * is the app's saved data (§9.4), not this file.
 */
export const LayoutSelectionSchema = z.strictObject({
  layout: LayoutIdSchema.default('default'),
  theme: ThemeIdSchema.default('default'),
  overrides: LayoutSchema.omit({ id: true }).partial().default({}),
});
export type LayoutSelection = z.infer<typeof LayoutSelectionSchema>;

// ─── routes ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const LayoutSummarySchema = z.strictObject({
  id: LayoutIdSchema,
  /** Shipped by a plugin (built in) or saved by the owner. */
  origin: z.enum(['built-in', 'saved']),
});
export const ThemeSummarySchema = z.strictObject({ id: ThemeIdSchema, origin: z.enum(['built-in', 'saved']) });

/** `GET /v1/layouts`. */
export const LayoutListSchema = z.strictObject({
  layouts: z.array(LayoutSummarySchema),
  themes: z.array(ThemeSummarySchema),
  current: z.strictObject({ layout: LayoutIdSchema, theme: ThemeIdSchema }),
});
export type LayoutList = z.infer<typeof LayoutListSchema>;

/** `GET /v1/layouts/current`: the layout with the owner's overrides applied, ready to draw. */
export const CurrentLayoutSchema = z.strictObject({ layout: LayoutSchema, theme: ThemeSchema });
export type CurrentLayout = z.infer<typeof CurrentLayoutSchema>;

/** A reason a layout cannot be used: an unknown view name or slot. A layout cannot break the app (§5.3). */
export const LayoutIssueSchema = z.strictObject({ path: z.string(), message: z.string() });
export type LayoutIssue = z.infer<typeof LayoutIssueSchema>;

/** `PATCH /v1/layouts/current`: `fy layout set nav.side right` is one change; a path is dotted. */
export const LayoutSetRequestSchema = z.strictObject({
  changes: z.array(z.strictObject({ path: z.string().min(1), value: z.unknown() })).min(1),
});
export type LayoutSetRequest = z.infer<typeof LayoutSetRequestSchema>;

/** `PUT /v1/layouts/current` (`fy layout use compact`) and `PUT /v1/layouts/theme` (`fy theme use dusk`). */
export const LayoutUseRequestSchema = z.strictObject({ layout: LayoutIdSchema });
export const ThemeUseRequestSchema = z.strictObject({ theme: ThemeIdSchema });

/** `POST /v1/layouts` (`fy layout save mine`): save the current one as a new layout item. */
export const LayoutSaveRequestSchema = z.strictObject({ id: LayoutIdSchema });

export const LayoutAppliedSchema = z.strictObject({ current: CurrentLayoutSchema.shape.layout });
export const LayoutRemovedSchema = z.strictObject({ id: LayoutIdSchema, removed: z.literal(true) });

export const LAYOUT_CODES = {
  invalid: 'layout_invalid',
  unknown: 'layout_unknown',
  builtIn: 'layout_built_in',
  exists: 'layout_exists',
} as const;
