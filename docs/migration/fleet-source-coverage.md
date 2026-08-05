# Fleet source coverage

This declaration accompanies the daemon-scoped Fleet read surface. It records
what was inspected in the source fleet and kteam implementations, what
Ferretry already carries, and the integration boundary that remains explicit.

| Source capability examined                                                                                                 | Ferretry carrier                                                                                                               | Coverage                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kfleet/config.yaml` `profiles`, `agents`, `variants`, and account routes materialise distinct wrappers and homes.         | `packages/fleet/src/lib/{config,profiles,plan,provisioning,wrappers}.ts` and `packages/fleet/src/adapters/file-provisioner.ts` | **PORTED.** The provisioning domain owns declared accounts, layered settings/assets, plans, wrappers and manifest publication.                                                                                                |
| `modules/kteam-ts/src/fleet-inventory.ts` `listWrappers()` projects wrapper names, harness family and launchability.       | `packages/pwa/src/features/fleet/{fleet-model,fleet-surface}.ts(x)`                                                            | **PARTIAL.** The read model shows daemon-provided wrapper evidence, accounts and blocked wrappers; it is mounted only in `packages/pwa/harness/main.tsx` while the daemon Settings tab frame is not on `main`.                |
| `modules/kteam-ts/src/harness.ts` `resolveBinary()` distinguishes an executable found on PATH from other runtime facts.    | `FleetSurface` says exactly “Found locally. Sign-in and provider access have not been verified.”                               | **PARTIAL.** The UI preserves the source limitation. It does not claim a PATH lookup proves authentication.                                                                                                                   |
| Sibling `fix/harness-preflight` `accountLaunchability()` / `readHarnessPreflight()` uses the start path's executable rule. | **GAP — deliberately no duplicate detector.**                                                                                  | That branch is committed but not yet on `main`; Fleet must rebase onto it and consume its evidence before it is mounted in the daemon-scoped Settings frame.                                                                  |
| Owner default rule: choose Claude when both are usable; otherwise choose Codex.                                            | `packages/pwa/src/features/fleet/fleet-model.ts` `defaultFleetHarness()`                                                       | **PORTED for the Fleet read model.** The rule has one commented function and only accepts positively launchable harness evidence. Future account/session creation must call the same policy after the Fleet daemon API lands. |
| Account creation, wrapper materialisation, skills, instructions, settings and environment editing.                         | **GAP.**                                                                                                                       | The existing provisioner can materialise a declared account, but no daemon mutation API or PWA form is mounted yet. No browser action writes host fleet state in this pass.                                                   |

## Mounting GAP

The expected daemon-scoped Settings frame is not present on `main` at this
commit. The first Fleet pass therefore ships as a tested, responsive harness
surface rather than inventing a second Settings frame. The required follow-up
is to rebase on the settings-frame and harness-preflight work, add the
daemon-authenticated read endpoint, and mount `FleetSurface` under that
daemon's Fleet tab. Until then the human journey remains CLI-only.
