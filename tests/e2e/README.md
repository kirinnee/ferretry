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
coverage ledger. Playwright is intentionally not installed yet; add it when PWA
browser journeys land. The separate CI job is still pending lead-owned wiring.
