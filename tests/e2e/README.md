# E2E journeys

E2E tests drive the compiled `fy` binary and its real external seams. Add a
`*.e2e.test.ts` file here, use `bun:test`, `should`, and the repository's AAA
comments, and keep the whole journey inside `withE2eEnvironment`.

```ts
import { it } from 'bun:test';
import should from 'should';
import { type FakeHarnessScenario, withE2eEnvironment } from './fixture';

it('should run an isolated journey', async () => {
  // Arrange
  const scenario = {
    version: 1,
    steps: [
      { type: 'say', text: 'ready' },
      { type: 'ask', text: 'Continue?', expect: 'yes' },
      { type: 'exit', code: 0 },
    ],
  } satisfies FakeHarnessScenario;

  await withE2eEnvironment(async environment => {
    await environment.setFakeHarnessScenario(scenario);

    // Act
    const fake = await environment.runFakeHarnessInTmux(['--fixture'], ['yes']);
    const actual = await environment.runFy(['--version']);

    // Assert
    should(fake.code).equal(0);
    should(fake.out).containEql('ready\nContinue?\n');
    should(actual.code).equal(0);
    should(actual.out).not.be.empty();
    should(actual.err).equal('');
  });
});
```

Fake-harness scenarios are data: `say` emits a line, `ask` emits a prompt and
checks one input line, `write` targets stdout or stderr exactly, and `exit` sets
the final code. Use `readFakeHarnessInvocations()` to assert the wrapper name,
arguments, and working directory. `runFy(args, env?)` always returns the
black-box result `{ code, out, err }`.

For daemon journeys, call `startDaemon({ command, env?, readyUrl?, timeoutMs? })`
with an absolute executable path. Build readiness URLs with `httpUrl()`, await
events with `awaitWebSocketEvent({ url?, predicate, timeoutMs? })`, and use
`webSocketUrl()` for the default event endpoint. `stopDaemon()` is available for
mid-journey assertions; final cleanup is automatic. Use `runTmux()` only when a
journey must inspect the isolated tmux server directly.

Every environment owns a temporary `HOME`, `FY_HOME`, XDG state, fake-agent
binary, dedicated real tmux socket, and independently reserved loopback ports.
Resolved paths into live fleet or Ferretry state are rejected. Cleanup stops the
daemon, kills the dedicated tmux server AND the daemon's own `<FY_HOME>/tmux.sock`
server, sweeps any other tmux process under the journey root by pid
(`scripts/test/tmux-sweep.ts`), releases ports, and removes temp state on success
or failure. A journey that times out never reaches its cleanup, so the fixture
also sweeps every undisposed root when the test process exits or is signalled,
and `run-e2e.sh` fails the tier if a tmux server is still running under its run
root at the end. Never bypass these helpers or reuse their resources across
journeys.

**No journey may launch a real harness.** Every environment writes fake `claude`
and `codex` into `paths.harnessBin`, which is first on every child's PATH —
including a daemon started with `useDaemonPrivateTmux`, which gets no `bin`
router. That matters because a generated runtime wrapper ends in `exec claude`
by NAME: before `harnessBin`, `agenda-lifecycle.e2e.test.ts` resolved that
name on the host PATH and ran the developer's real Claude Code in a tmux server
nothing killed. Children also get `FERRETRY_TEST=1`, which turns on the daemon's
launch guard (`packages/daemon/src/lib/tmux/harness-guard.ts`): a session whose
wrapper, `claude` or `codex` resolves into a real install fails with
`test mode refused to launch a real harness`. Install a journey-specific fake
with `installFakeHarness(name)` (scenario-driven) or write into `harnessBin`.

Run the tier with `task test:e2e`. It typechecks the harness and runs without a
coverage ledger. CI runs it as the `E2E` workflow (`scripts/ci/e2e.sh`), split
by test across four parallel shards and reported as one `E2E Journeys` status.
Each shard uploads its journeys' screens, step log and JUnit report as the
`e2e-evidence-<shard>-<attempt>` artifact. The tier is advisory until two weeks of
runs have measured its flake rate, and then it becomes a required check. See
[CI/CD](../../docs/standards/ci-cd/index.md#e2e-tier).

**A journey that waits on purpose ends its title in `[slow]`.** Examples are a page
left idle for minutes and a relay restarted again and again under a live page. Pull
requests do not run these journeys. `E2E Slow` runs them nightly, and on
pull requests that touch the relay or connection code. Run one tier and one share
locally with `FY_E2E_TIER=fast|slow|all FY_E2E_SHARD=i/N task test:e2e`.
`scripts/ci/e2e-shards.ts` balances the shards by `timings.json`, and a new journey
counts as 10 s until the timings are regenerated from a run's JUnit reports. See
[CI/CD](../../docs/standards/ci-cd/index.md#e2e-tier).

**Every other journey ends at the runner's ceiling** (`journey_timeout_ms` in
`scripts/test/run-e2e.sh`, 150 s). Do not give an `it` a longer timeout of its own:
`scripts/test/e2e-journey-timeouts.ts` refuses one, and a `setDefaultTimeout` above the
ceiling, before any journey runs. Two journeys once declared 600 and 900 seconds, and a
hang in either held its shard for that long. A journey that really needs longer is waiting
on purpose, so it belongs in `[slow]`.

**No browser call can wait forever.** On hosted runners Bun sometimes stops servicing the
DevTools pipe Playwright uses to drive Chrome, after the launch has succeeded. Playwright is
never told: Chrome logs `Could not write into pipe`, or reads EOF and exits, and every call
without its own timeout (`evaluate`, a CDP `send`, `newPage`) waits forever. The browser from
`launchChromiumWithRetry` (`support/relay-harness.ts`) watches for both signs. It also covers a
third form, where Bun stops writing to Chrome and nothing at all is logged: a call still
pending after 10 s asks Chrome's browser process for its version, and no reply within 5 s
counts as a lost pipe. When it sees any of these, every pending and later call on that browser and its contexts, pages and CDP sessions
fails at once with `browser has disconnected: …`, which the product journeys' retry already
handles. A call that carries no timeout of its own and never answers fails after 60 s and
says which call it was. A polling loop that counts a failed read as "not yet" must rethrow
`isLostBrowser(error)`, or it polls a dead browser until its own deadline.

## Browser journeys

`support/relay-harness.ts` adds the four things a browser journey needs that the
fixture has no opinion about, each registered on a teardown that releases on
pass, failure and interrupt:

- `startRendezvous(root, teardown)` — `packages/relay`'s own `relayFetch` and
  `RendezvousDurableObject` in their own OS process, over real WebSockets, with
  every frame in both directions appended to a JSONL observation log. See
  `scripts/test/rendezvous-process.ts` for exactly what Bun substitutes for the
  Workers runtime and what it therefore cannot prove.
- `startDirectSinkhole(teardown)` — a loopback address that accepts a TCP
  connection, **counts** it, and destroys it. Advertise it as the daemon's
  `publicUrl` so a browser's direct attempt demonstrably happens and
  demonstrably fails at transport; on one machine, "direct is unreachable" has
  to be arranged rather than assumed.
- `startRelayDirectory()` — the hosted directory advertisement, on loopback. This
  is how **both** ends find one rendezvous: the bundle is built with its origin as
  the compiled directory constant and the daemon runs with
  `FY_RELAY_DIRECTORY_ORIGIN` set to it, so neither end is told an address and the
  journey exercises the shipped default rather than a spelling of it. Only the
  ORIGIN has to exist before the build; `publish(relayUrl)` sets the address once
  the rendezvous has a port. It counts reads, so "the browser discovered the
  rendezvous" is an assertion rather than an inference. One per process and not
  torn down per journey — the bundle memo is keyed on its origin, so a second
  directory would mean a second full `vite build`. Its listener is `unref()`ed;
  accepted keep-alive sockets remain owned by their clients/server timeout and
  may live until those owners close them.
- `buildPwaBundle(directoryOrigin)` / `startPwaOrigin(dist, teardown)` — the REAL
  `vite build` output on a loopback origin, under the published site's own
  `public/_headers` CSP and `public/_redirects` SPA routes. Built once per suite
  run into `$FY_E2E_RUN_ROOT`, never into a journey's own root: that root is
  removed when its journey disposes, and the next journey then serves nothing. A
  second, different `directoryOrigin` is refused rather than silently ignored.
- `launchChrome(teardown, { userAgent? })` — real Chrome via `playwright-core`,
  resolved at runtime from `packages/pwa` because this repository installs
  isolated and `playwright-core` is not resolvable from `tests/`.

Point the daemon at a document with `--config <path outside FY_HOME>`. A
`config/daemon.json` written into an empty `FY_HOME` makes that home "non-empty
with no layout-version marker" and the daemon refuses to open it.

**A script you SPAWN belongs in `scripts/test/`, not in `support/`.** `support/`
is for modules a test imports; `scripts/test/` is for executables started by
path — `fake-harness.ts`, `fake-daemon.ts`, `bootstrap-only-fyd.ts`,
`rendezvous-process.ts`. `knip.json` makes `scripts/test/*.ts` an entry point for
exactly that reason, so a spawned script placed under `support/` has no importer
and the dead-code gate reports it as unused. That is the gate being right.
`tests/e2e/tsconfig.json` already includes `scripts/test/**/*.ts`, so nothing
there escapes the typecheck.

`relay-browser-pairing.e2e.test.ts` is the journey those pieces exist for, and
it is green: a real Chrome, holding a link the compiled `fy pair` printed,
redeems a first pairing over a real rendezvous against the compiled daemon after
demonstrably failing on the advertised direct address, reconnects on an
authenticated relay session, and renders a live event — with the pairing code,
the device token, the device name and the event payload absent from every frame
the relay handled. The daemon's document declares **no** rendezvous and the
minted fragment is asserted to be the one `v1` form carrying no `relay=`, so the
browser's only route to the address is the directory read the journey counts.
Its first test guards every moving part of the harness itself, so a red journey
is a statement about the product rather than the scaffolding.

The relay journey writes a step ledger to `$FY_E2E_RELAY_REPORT` (default
`<tmpdir>/fy-e2e-relay-journey.md`) on every run. The harness-guard test neither
writes nor truncates that report. A journey failure names the step that broke,
not the earliest step never reached.

`support/seeded-session.ts` is the one place in this tier that imports daemon
internals rather than driving the compiled binary. The daemon has no
session-create route, so the live-event leg needs a session seeded through the
daemon's own storage and the protocol's own schemas before boot. Read its header
before copying the pattern: it states exactly what that substitutes.

Known and deliberately not taken: `wrangler` 4.93 is on the devshell `PATH` and
its `workerd` starts, but that binary's newest supported compatibility date is
older than `packages/relay/wrangler.jsonc` pins, so `wrangler dev` refuses the
Worker. Running it would mean overriding the deployment's compatibility date,
and it would cost the frame observation log unless a recording proxy went in
front. Reconsider if the toolchain moves.

## Relay recovery

`relay-reconnect.e2e.test.ts` kills the rendezvous process mid-session (`RendezvousProcess.restart()`
restarts it on the same port, allowlist kept) and measures, with nothing clicked, how long the real
Chrome PWA takes to come back and whether composer sends land exactly once in the daemon's send
ledger. Also: an idle case (`FY_E2E_IDLE_MINUTES`, default 3) and a frozen-renderer case
(`FY_E2E_FREEZE_SECONDS`, default 75; `SIGSTOP` on the renderer). Numbers go to
`$FY_E2E_RECONNECT_REPORT`; recovery budget is `FY_E2E_RECONNECT_BUDGET_MS` (default 10000).
