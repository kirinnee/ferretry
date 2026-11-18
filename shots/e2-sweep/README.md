# E2 screen sweep: v4 vs v5 (fake data)

Both daemons run on one rich fake v4 home (sweep slot 6: the v4 4.291.19 daemon, and the 5.0 daemon on a converted copy of the same home).
v4 app = the hosted 4.291.19 release. v5 app = `vite build` of `origin/rebuild/5.0-after` at `e1b898d058`, daemon built from the same commit.
Folder per screen, then `v4/` and `v5/`; file `<page>-<viewport>-<scheme>.png` (1280 desktop, 390 phone; 2x; light and dark).
A page taller than the window is captured at up to 2000 px (desktop) / 2600 px (phone) tall. `log-v4.jsonl` and `log-v5.jsonl` hold the page text and the size of each shot.
No real data and no pairing codes appear in any shot. v4's connection preference was set to Auto (its default is Relay only); the hosted relay is switched off in both.
Owner-only v5 tabs ask for a passkey ("Confirm it's you"); the capture cancelled that prompt, so those tabs show "Reading ...".
