---
id: theme
title: Theme and Round-Safe Geometry
---

# Theme and Round-Safe Geometry

The app draws in one of sixteen **styles** (how things are drawn: type, radii, strokes, shadows, spacing) and one of the
**palettes** (which colours), in light or dark. A style may round its controls into pills and its panels past 20px
(Gen Z, Neumorphism, Glass, Lucid, Briefing). **Every surface is written for the highest rounding, not only for the
default.** The owner has said this twice (r11-3 Themes gate line 3, then 2026-11-25: "for high rounded, we need to take
that into consideration when writing — now its just looks buggy"), so it is a rule of the theme and a gate, not a
per-component fix.

The token layer is [`packages/app/src/styles/`](../../../packages/app/src/styles/themes.css): `tokens/base-style.css` holds
every style-owned token's default, `style/<id>.css` one style's values, `tokens/floors.css` the touch-target floors.

## The rule

Two halves, both in `tokens/base-style.css` under "ROUND-SAFE GEOMETRY", so every panel, banner, toast, dialog, input and
tile inherits them:

1. **The radius is capped by the box.** "Fully round" is `--radius-round` (= `--radius-cap`, 22px: half of the 44px touch
   target). A single-line control, 28 to 44px tall, is still a full pill, because the browser clamps a radius to half the
   box's height. A tall or multi-line box, such as a banner, a tile or a panel, gets an ordinary 22px corner and is **never a
   stadium**. A style says `var(--radius-round)` and **never** `999px`; `--radius-pill` is the same value.
2. **Inline padding grows with the radius.** A style states the padding it wants (`--pad-control-x-want`,
   `--pad-panel-want`); what a control or a panel gets (`--pad-control-x`, `--pad-panel`) is never less than half its own
   corner radius, so text never meets the curve.

## Writing a surface

| You are drawing       | Use                                                      | Never                                         |
| --------------------- | -------------------------------------------------------- | --------------------------------------------- |
| A panel, banner, tile | `rounded-panel` and `p-panel` / `px-panel`               | `rounded-control` on a multi-line box         |
| A button, field, chip | `rounded-control` and `px-control-x` (or `kt-btn`)       | A literal `px-1` on a box that paints a curve |
| A fully round thing   | `var(--radius-round)` in CSS, `rounded-pill` in Tailwind | `999px`, `9999px` in a style or a component   |
| A dot or an avatar    | `rounded-full` on a square box                           | `rounded-full` on a box that can grow tall    |

A centred figure is centred with `margin-inline: auto`, not by hoping the column is as wide as the figure.

## The gate

[`tests/support/browser/round-safe.ts`](../../../packages/app/tests/support/browser/round-safe.ts) is geometric, not a human
look. It reads every rounded, painted box on a page in a real browser and fails when the four corners of any content inside
it (a line of text, an icon, a nested button) fall outside the box's **inner rounded rectangle**: the border box inset by
its borders, with the used radii (scaled down together when two corners would overlap, as CSS does).

**Partly inside is a miss.** Content in the box's normal flow that is only part of the way inside (a button 4px past the
banner's left edge near its bottom corner, the owner's bug) fails, whichever edge or corner it crosses. Content that sits
outside the box altogether, or out of flow (`position: absolute` / `fixed`: a popover, a badge), or that a clipping or scrolling
box cuts (`overflow` other than `visible`, an ellipsis: a truncated title is judged where it is seen), is judged only where it
sits inside the box.

**Current limits (what it cannot judge):** a box that paints nothing (no fill, border or shadow), a phrase that wraps over
lines, a box under 28px a side (a dot, a badge, a check mark), a painted child or icon in a box that clips to its own curve, and
anything a browser skips (a closed `<details>`). It reads a page as drawn: a state nobody opens (a hover, a menu, a route with
no fake data) is not judged. The gate is judged itself: `tests/unit/round-safe.test.ts` holds its arithmetic, and
`daemons-round-safe.visual.test.ts` moves the banner's button 18px left and 8px down in a real browser and expects red.

It runs at 390 and 1440, light and dark, in the default look (Studio) and the roundest looks (Gen Z, Neumorphism; the
daemons page also Glass, Lucid and Briefing):

- `packages/app/tests/integration/round-safe-routes.visual.test.ts`: the whole route inventory of the real app over one fake
  machine: the machine's home, standalone Settings (this device), Ferrets, Chat, Agenda, Board, Projects, PRs & CI, Sharing,
  Lessons, Insights, Warden, the machine's settings, and the pairing page. `NOT_DRAWN` in that file names what the fake
  machine cannot draw (PR list rows and CI pages: no GitHub read; Sharing's other tabs).
- `packages/app/tests/integration/round-safe-first-run.visual.test.ts`: the first run walked page by page (start, install,
  daemon, open, pair, every page of the setup flow, the end page).
- `packages/app/tests/integration/round-safe-settings.visual.test.ts`: every settings tab of every plugin.
- `packages/app/tests/integration/round-safe-specimen.visual.test.ts`: the component specimen (panels, callouts, menus, fields,
  tables, code blocks, buttons).
- `packages/app/tests/integration/round-safe-machine-stop.visual.test.ts`: the full-page "cannot use this machine" screens, in
  every end state.
- `packages/plugins/access/tests/integration/app/daemons-round-safe.visual.test.ts`: the daemons page in each of its states
  (plain, Back, device-refused notice, both), plus the ferret centred within 2px.
- `packages/plugins/access/tests/integration/app/pair-round-safe.visual.test.ts`: the empty pair view and its opened
  scanner, paste and help states, the confirm screen and the failure panel.

A new surface that breaks the rule fails these at the look that shows it. Fix the surface (or the token), never the gate. A new
route goes into `ROUTES` of the routes test, a new full-page state into its own scene test.
