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
its borders, with the used radii (scaled down together when two corners would overlap, as CSS does). It skips what it
cannot judge: a box that paints nothing, a phrase that wraps over lines, content outside the box, a box under 28px a side,
and anything a browser skips (a closed `<details>`).

It runs at 390 and 1440, light and dark, in the default look (Studio) and the roundest looks:

- `packages/app/tests/integration/round-safe-settings.visual.test.ts`: every settings tab of every plugin, Studio, Gen Z and
  Neumorphism.
- `packages/plugins/access/tests/integration/app/daemons-round-safe.visual.test.ts`: the daemons page in each of its states
  (plain, Back, device-refused notice, both) in Studio and every look that rounds, plus the ferret centred within 2px.

A new surface that breaks the rule fails these at the look that shows it. Fix the surface (or the token), never the gate.
