/**
 * Layouts' wire schemas. Layouts and themes are NEW in 5.0 (today the layout is hard-coded in `App.tsx`); the shapes
 * follow design §5.3 field for field and the app shell's own reader (`packages/app/src/layout/layout.ts`,
 * `theme/tokens.ts`): the app parses what this daemon serves with its stricter schema and falls back to its built-in
 * layout on a refusal, so a field named here that the app does not read is a layout the app would refuse. Both are
 * items (§4.9, §4.11), so a catalog can share them.
 */
import { z } from 'zod';

const ID = /^[a-z][a-z0-9-]*$/;
export const LayoutIdSchema = z.string().max(40).regex(ID);
export type LayoutId = z.infer<typeof LayoutIdSchema>;
export const ThemeIdSchema = z.string().max(40).regex(ID);
export type ThemeId = z.infer<typeof ThemeIdSchema>;

/** Where the nav sits. */
export const NavSideSchema = z.enum(['left', 'right', 'top', 'bottom']);
export type NavSide = z.infer<typeof NavSideSchema>;

/**
 * A view name the layout refers to: a screen id (`board`, or qualified `board.board`), a panel id or a shell item.
 * Whether it is installed is the app's check and `fy plugin check`'s; this is the grammar both share.
 */
export const ViewNameSchema = z
  .string()
  .max(80)
  .regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?$/u);

const NavStyleSchema = z.enum(['rail', 'bar', 'list']);
const NavFields = { side: NavSideSchema, style: NavStyleSchema, items: z.array(ViewNameSchema).max(24) };
const NavSchema = z.strictObject({ ...NavFields, style: NavStyleSchema.default('rail') });
/** For overrides: no default, or laying the override over a layout would reset the keys it did not name. */
const NavPartialSchema = z.strictObject(NavFields).partial();

const SideSchema = z.strictObject({
  /** The second column: never, only on wide screens, or always. */
  show: z.enum(['never', 'wide-only', 'always']),
  /** What it holds: `none`, a screen, or `panels` (the `side` slot's panels). */
  holds: ViewNameSchema,
});

const DensitySchema = z.enum(['compact', 'comfortable']);
export type Density = z.infer<typeof DensitySchema>;

/** A slot name panels are placed in: a frame slot (`ferret.side`) or a plugin's own (`<plugin>.<name>`). */
export const SlotNameSchema = z
  .string()
  .max(80)
  .regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?$/u);

/** Overrides on narrow screens: every field optional, `nav` replaces field by field. */
const PhoneSchema = z.strictObject({
  nav: NavPartialSchema.optional(),
  side: SideSchema.partial().optional(),
  top: z.array(ViewNameSchema).max(8).optional(),
  density: DensitySchema.optional(),
});

/** `layouts/<name>.yaml`. */
export const LayoutSchema = z.strictObject({
  id: LayoutIdSchema,
  nav: NavSchema,
  side: SideSchema.default({ show: 'never', holds: 'none' }),
  top: z.array(ViewNameSchema).max(8).default(['daemon-picker', 'search']),
  'composer.tools': z.array(ViewNameSchema).max(16).optional(),
  /** Panels by slot name (`ferret.side`, `card.detail`, …). */
  panels: z.record(SlotNameSchema, z.array(ViewNameSchema).max(24)).default({}),
  density: DensitySchema.default('comfortable'),
  phone: PhoneSchema.optional(),
});
export type Layout = z.infer<typeof LayoutSchema>;

/** The built-in theme families the app ships (`theme/preferences.ts`); a theme item names the one it starts from. */
export const THEME_FAMILY_IDS = [
  'studio',
  'mission',
  'neo',
  'geist',
  'contrast',
  'phosphor',
  'blueprint',
  'broadsheet',
  'wayfinding',
  'ledger',
  'ma',
] as const;

const TokenValuesSchema = z.record(z.string().max(40), z.string().max(160));

/**
 * `themes/<name>.yaml`: a built-in family plus colour, type and spacing tokens laid over it, light and dark apart.
 * The token NAMES and the value grammar are the app shell's (`theme/tokens.ts`), which refuses a theme that names a
 * token it does not read; the daemon passes them through.
 */
export const ThemeSchema = z.strictObject({
  id: ThemeIdSchema,
  label: z.string().min(1).max(60),
  base: z.enum(THEME_FAMILY_IDS),
  light: TokenValuesSchema.default({}),
  dark: TokenValuesSchema.default({}),
});
export type Theme = z.infer<typeof ThemeSchema>;

/**
 * The keys of a layout that `config/layout.yaml` may change, field by field, so `fy layout set nav.side right` stores
 * `overrides: { nav: { side: right } }` and nothing else. Every nested object is partial.
 */
export const LayoutOverridesSchema = z.strictObject({
  nav: NavPartialSchema.optional(),
  side: SideSchema.partial().optional(),
  top: z.array(ViewNameSchema).max(8).optional(),
  'composer.tools': z.array(ViewNameSchema).max(16).optional(),
  panels: z.record(SlotNameSchema, z.array(ViewNameSchema).max(24)).optional(),
  density: DensitySchema.optional(),
  phone: PhoneSchema.optional(),
});
export type LayoutOverrides = z.infer<typeof LayoutOverridesSchema>;

/**
 * `config/layout.yaml`: which layout and theme are in use for the owner, and the keys changed from it. An ordinary,
 * non-loosening config file (§7.2). A device's own choice (`--device`) is the app's saved data (§9.4), not this file.
 */
export const LayoutSelectionSchema = z.strictObject({
  layout: LayoutIdSchema.default('default'),
  theme: ThemeIdSchema.default('default'),
  overrides: LayoutOverridesSchema.default({}),
});
export type LayoutSelection = z.infer<typeof LayoutSelectionSchema>;

// ─── routes ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const LayoutSummarySchema = z.strictObject({
  id: LayoutIdSchema,
  /** Shipped by a plugin (built in) or saved by the owner. */
  origin: z.enum(['built-in', 'saved']),
});
export type LayoutSummary = z.infer<typeof LayoutSummarySchema>;
export const ThemeSummarySchema = z.strictObject({ id: ThemeIdSchema, origin: z.enum(['built-in', 'saved']) });
export type ThemeSummary = z.infer<typeof ThemeSummarySchema>;

/** `GET /v1/layouts`. */
export const LayoutListSchema = z.strictObject({
  layouts: z.array(LayoutSummarySchema),
  themes: z.array(ThemeSummarySchema),
  current: z.strictObject({ layout: LayoutIdSchema, theme: ThemeIdSchema }),
});
export type LayoutList = z.infer<typeof LayoutListSchema>;

/** `GET /v1/layouts/themes`. */
export const ThemeListSchema = z.strictObject({ themes: z.array(ThemeSummarySchema), current: ThemeIdSchema });
export type ThemeList = z.infer<typeof ThemeListSchema>;

/** `GET /v1/layouts/current`: the layout with the owner's overrides applied, ready to draw. */
export const CurrentLayoutSchema = z.strictObject({ layout: LayoutSchema, theme: ThemeSchema });
export type CurrentLayout = z.infer<typeof CurrentLayoutSchema>;

/** A reason a layout cannot be used: an unknown view name or slot. A layout cannot break the app (§5.3). */
export const LayoutIssueSchema = z.strictObject({ path: z.string(), message: z.string() });
export type LayoutIssue = z.infer<typeof LayoutIssueSchema>;

/**
 * `PATCH /v1/layouts/current`: `fy layout set nav.side right` is one change; a path is dotted. A value for a list key
 * (`nav.items`, `top`, `composer.tools`, `panels.<slot>`) is an array, or text split at commas.
 */
export const LayoutSetRequestSchema = z.strictObject({
  changes: z
    .array(z.strictObject({ path: z.string().min(1).max(120), value: z.unknown() }))
    .min(1)
    .max(20),
});
export type LayoutSetRequest = z.infer<typeof LayoutSetRequestSchema>;

/** `PUT /v1/layouts/current` (`fy layout use compact`) and `PUT /v1/layouts/theme` (`fy theme use dusk`). */
export const LayoutUseRequestSchema = z.strictObject({ layout: LayoutIdSchema });
export const ThemeUseRequestSchema = z.strictObject({ theme: ThemeIdSchema });

/** `POST /v1/layouts` (`fy layout save mine`): save the current one as a new layout item. */
export const LayoutSaveRequestSchema = z.strictObject({ id: LayoutIdSchema });

export const LayoutAppliedSchema = z.strictObject({ current: LayoutSchema });
export const ThemeAppliedSchema = z.strictObject({ current: ThemeSchema });
export const LayoutRemovedSchema = z.strictObject({ id: LayoutIdSchema, removed: z.literal(true) });

export const LAYOUT_CODES = {
  invalid: 'layout_invalid',
  unknown: 'layout_unknown',
  builtIn: 'layout_built_in',
  exists: 'layout_exists',
  themeUnknown: 'theme_unknown',
  /** The daemon has no door to write `config/` with, so it can show a layout but not change one. */
  noConfigDoor: 'layout_config_unavailable',
} as const;
