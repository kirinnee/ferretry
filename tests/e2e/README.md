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
daemon, kills the dedicated tmux server, releases ports, and removes temp state
on success or failure; the suite runner also handles interrupts. Never bypass
these helpers or reuse their resources across journeys.

Run the tier with `task test:e2e`. It typechecks the harness and runs without a
coverage ledger. The separate CI job is still pending lead-owned wiring, so a
regression test placed here is not yet a guard.

## Browser journeys

`support/relay-harness.ts` adds the four things a browser journey needs that the
fixture has no opinion about, each registered on a teardown that releases on
pass, failure and interrupt:

- `startRendezvous(root, teardown)` — `packages/relay`'s own `relayFetch` and
  `RendezvousDurableObject` in their own OS process, over real WebSockets, with
  every frame in both directions appended to a JSONL observation log. See
  `support/rendezvous-process.ts` for exactly what Bun substitutes for the
  Workers runtime and what it therefore cannot prove.
- `startDirectSinkhole(teardown)` — a loopback address that accepts a TCP
  connection, **counts** it, and destroys it. Advertise it as the daemon's
  `publicUrl` so a browser's direct attempt demonstrably happens and
  demonstrably fails at transport; on one machine, "direct is unreachable" has
  to be arranged rather than assumed.
- `buildPwaBundle()` / `startPwaOrigin(dist, teardown)` — the REAL `vite build`
  output on a loopback origin, under the published site's own
  `public/_headers` CSP and `public/_redirects` SPA routes. Built once per suite
  run into `$FY_E2E_RUN_ROOT`, never into a journey's own root: that root is
  removed when its journey disposes, and the next journey then serves nothing.
- `launchChrome(teardown, { userAgent? })` — real Chrome via `playwright-core`,
  resolved at runtime from `packages/pwa` because this repository installs
  isolated and `playwright-core` is not resolvable from `tests/`.

Point the daemon at a document with `--config <path outside FY_HOME>`. A
`config/daemon.json` written into an empty `FY_HOME` makes that home "non-empty
with no layout-version marker" and the daemon refuses to open it.

`relay-browser-pairing.e2e.test.ts` is the journey those pieces exist for. Its
first test guards every moving part of the harness itself and is green. Its
second test is the journey: twelve of its thirteen steps pass — including a real
Chrome redeeming a first pairing over the relay against the compiled daemon —
and the thirteenth fails because a §14 stream session opens over the rendezvous
and carries no frames. It records a step ledger, fails naming the step, and
writes the whole ledger to `$FY_E2E_RELAY_REPORT` (default
`<tmpdir>/fy-e2e-relay-journey.md`).

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
