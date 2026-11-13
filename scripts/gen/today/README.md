# Today's descriptor tables (`routes.json`)

A frozen snapshot of what 4.x serves — routes, sockets, member routes and agent tools — so the
descriptor-parity check can compare a 5.0 manifest against today.

## Regenerate

```sh
bun scripts/gen/today/extract.ts \
  --ref ~/Workspace/personal/ferretry/.worktrees/rebuild-ref \
  --out scripts/gen/today/routes.json
```

`source` in the file is the reference checkout's commit (`git rev-parse HEAD`; pass `--source <sha>` for a
non-git copy). Unresolved values and skipped objects are listed on stderr. Test: `bun test scripts/gen/today/extract.test.ts`.

## Current output (reference `bb89d054d`)

**481 rows**: route 415, socket 5, member 10, tool 51. Unresolved values: 0.

Why 415 routes against ~388 `minimum:` literals: many routes take `minimum`/`caller`/`capability`/`noStore` from a
shared constant (`{ ...USE, method, path }`), so the literal count under-counts. The extractor resolves those spreads.
22 `method` + `path` objects are skipped on purpose: they are audit rules (`AuditedRouteRule`), which carry neither
`minimum` nor `needs`. They are listed on stderr.

## What is extracted

Real AST pass (`oxc-parser`). Directories: `packages/daemon/src/lib/{api/routes,runtime/mounts,catalog-members}`
for routes, `packages/cli/src/lib/mcp` for tools.

- **route** — object with `method` + `path` + `minimum`. **socket** — the same plus `accept`.
  **member** — `method` + `path` + `needs: 'key'|'unlocked'` (stored as `member`).
- Key is `METHOD /path`; template paths are resolved through constants, `:name` / `*rest` captures stay as written.
- Fields: `minimum`, `caller`, `capability {capability, axis, narrowing?}`, `wardenRemedy`, `noStore`, `precedence`,
  `member`, `catalog` (no route declares one today), and presence-only `ferretDoor`, `privilegedOnly`,
  `unlockExempt`, `consultsGrants`, `compress`, `available`. `from` is `file:line` of the object literal.
- **tool** — object with a string `name` + `description` + `inputSchema`. Key is the MCP name (`terminal_read`);
  `wire` (an addition to the brief's row shape) is the daemon-side name (`terminal.read`) from `tool` / `configTool` /
  `lessonTool`.
- Constants resolve through same-file and relative-imported `const`s, block scopes, object spreads, member access,
  `as const` / `satisfies`, template literals and `+`. Anything else becomes `unresolved:<source text>`.

## What is not extracted

- Handler bodies, schemas and responses: this is the declaration table only.
- Routes built at runtime (a path computed by a call or a function parameter). Those would show as `unresolved:`; there are none today.
- Values imported from another package (`@ferretry/protocol`): only relative imports are followed.
- Wrappers that re-spread a route (`agentControlledRoutes`, `auditedSocketRoutes`) add no rows; the underlying declaration is the row.
- Tools with no string wire name (`MCP_SEARCH_TOOLS`, the instructions tool) have no `wire`; `secure.preapprove`
  (accepted but unlisted by the daemon) is not in the MCP table, so it is not a row.
- Anything outside the directories above, and `.test.ts` files.
