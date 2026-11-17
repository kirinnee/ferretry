# P3 phase 1 — two design options for the pair page (THROWAWAY prototype)

Not for merge. Fake data, no daemon, no real pairing code. Phase 2 builds the owner's pick on top of P2 inside
`packages/plugins/access/app/features/pairing/`.

Both options draw the P2 relay-path content: the machine's name, "through the relay", the fingerprint behind a
**Details** toggle (no `127.0.0.1`), the visible **Name this device** field, ONE primary action **Pair this device**,
and a quiet **Not now**.

|                | A — "The burrow"                                                               | B — "The missing slot"                                                                               |
| -------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Mood           | calm, warm, illustrated                                                        | bold, playful, motion-led                                                                            |
| Hero           | a ferret peeks out of a hole while you decide                                  | the Fleet Grid logomark with its one empty slot — that slot is _this device_                         |
| Type           | Gelasio serif heading (already bundled for the Broadsheet family)              | heavy sans, tight tracking, hard offset shadow                                                       |
| Success motion | ferret rises and dooks (happy wiggle), paw waves, sparkles, green check pops   | device cell lands in the slot with a check, grid ripples outward from it, ring pulses, confetti pops |
| Reduced motion | final picture shown, nothing moves                                             | final picture shown, nothing moves                                                                   |
| Brand use      | Fleet Grid mark stays the logo (corner); ferret is an illustration, not a logo | reuses the Fleet Grid geometry exactly; no new mark                                                  |

Note on the ferret: the repo has no ferret artwork (brand = Fleet Grid, `docs/brand/`). A's ferret is a throwaway
illustration drawn in SVG for this exercise; its fur palette is the only set of literal colours (top of `proto.css`).
If A is picked, the artwork needs the owner's eye as a brand decision, not just a build.

## Run

```
cd packages/plugins/access/tests/integration/proto-p3
FY_FIXTURE_CACHE=off direnv exec . bun shoot.ts <outDir>   # builds the scene, writes shots + sheets + REPORT.txt
```

`scene.tsx?option=a|b&stage=confirm|pairing|paired&theme=studio-light|studio-dark&details=1&motion=reduced` is the live
scene (no `stage` = press the button and watch the real flow with a fake 1.1 s exchange). Frames are made by pausing
every Web Animation and seeking it to 0.25 s / 0.7 s / 1.5 s. The scene cache is keyed on the app's inputs, not this
folder, hence `FY_FIXTURE_CACHE=off`.

Shots: `shots/<a|b>/<390|1280>-<light|dark>-{1-pair,1b-details,2-success-f1..f3,3-success,4-success-reduced}.png` and
`shots/sheet-<a|b>-<light|dark>.png` (contact sheets).
