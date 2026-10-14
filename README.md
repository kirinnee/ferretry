# Navigation + setup redesign — screenshots

Evidence for the PR on `feat/ux-hierarchy`. Captured from the PWA harness on the PR head.

- `sheets/` — one contact sheet per changed screen, **every theme family, light + dark** side by side
  (studio, mission, neo, geist, contrast, phosphor, blueprint, broadsheet, wayfinding, ledger, ma).
- `themes/` — the individual frames behind the sheets: `<screen>--<family>-<mode>.png`
  (390 px phone frames are `*-mobile`, 1440 px desktop frames are `*-desktop`).
- `walk/studio-{dark,light}/` — every frame of the CI Settings walk (`scripts/ci/pwa-screenshot-proof.sh`)
  at 390 px and 1440 px: Settings home, sections, every machine tab, every Machine-tab panel, every
  inline flow, and every step of the full-screen setup (`setup-*`).

## Contact sheets

### L1 — app bar (desktop): text links, current page underlined, Find as a search box
![](sheets/sheet-appbar-desktop.png)

### L1 — phone bottom bar: Sessions · Projects · Find · Settings · More
![](sheets/sheet-tabbar-mobile.png)

### L2 — Settings home on a phone: grouped cards on a recessed ground
![](sheets/sheet-settings-home-mobile.png)

### L2 + L3 — Settings sidebar (selected pill, no side bar) and underlined machine tabs (desktop)
![](sheets/sheet-machine-runtimes-desktop.png)

### L3 — phone tab strip scrolled to the current tab, with an edge fade
![](sheets/sheet-machine-runtimes-mobile.png)

### Machine tab — Daemons merged in as "Connection and security"
![](sheets/sheet-machine-panels-desktop.png)

### Full-screen setup (desktop): numbered, named steps; actions pinned to the bottom
![](sheets/sheet-setup-desktop.png)

### Full-screen setup (phone): segments + step names; Back / Skip / Import pinned above the home indicator
![](sheets/sheet-setup-mobile.png)

### Inline stepper inside Settings (Add a runtime)
![](sheets/sheet-stepper-inline-desktop.png)
