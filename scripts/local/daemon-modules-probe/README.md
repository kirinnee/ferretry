# Daemon modules probe

The measurements behind [docs/design/daemon-plugins.md](../../../docs/design/daemon-plugins.md). They are
heuristics, written so anybody can re-run them and judge them. They are not gates, and no task or CI job
runs them.

| Script            | Answers                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `modules.ts`      | The proposed module of a repository path. It is the one map the other scripts share.       |
| `attribute.ts`    | Which module each line of `packages/daemon/bin/fyd.ts` belongs to (§5 of the plan)         |
| `classify.ts`     | Which modules each `fyd.ts` commit changed, and the overlapping-PR clash scenarios (§7)    |
| `shared-lists.ts` | The `DAEMON_FEATURES` area split and the knip globs, measured on past commits (§4.3, §4.4) |

Run them from the repository root, in the devshell. `classify.ts` and `shared-lists.ts` call `gh pr view`
for PR open windows. `classify.ts` unpacks each commit's `packages/daemon/src` into a temporary directory,
and the run takes about two minutes.

```bash
bun scripts/local/daemon-modules-probe/attribute.ts --limit 6
bun scripts/local/daemon-modules-probe/classify.ts --rev c7e6beda1 --limit 6   # history from 2026-11-01T00:00:00Z by default
bun scripts/local/daemon-modules-probe/shared-lists.ts --rev c7e6beda1
```

The `--limit` setting changes the result, so the plan publishes the result at 3, 6 and 12 as a range,
not as one number.
