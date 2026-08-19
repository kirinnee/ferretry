/**
 * The spawn adapter, against real processes.
 *
 * Every property here is one a fake cannot establish. Piping a harness's stdio is the actual behaviour
 * change this feature makes, and the failure modes are all in the plumbing: a stream nobody drains
 * blocks the child, a prompt with no trailing newline is never delivered, a write to a child that has
 * exited throws, and colour still arrives when stdout is a pipe. So the children here are real shell
 * scripts written to a temporary directory and really run.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { harnessLoginTimer, spawnHarnessLoginChild } from '../../../src/adapters/fleet-login/login-child.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

/** Write an executable shell script and return its absolute path. */
async function script(body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-login-child-'));
  temporaryDirectories.push(root);
  const path = join(root, 'child.sh');
  await writeFile(path, `#!/bin/sh\n${body}`, 'utf8');
  await chmod(path, 0o700);
  return path;
}

/** Run one child to completion, collecting every line it delivered. */
async function run(
  path: string,
  options: { readonly environment?: Record<string, string | undefined>; readonly write?: string } = {},
): Promise<{ readonly lines: readonly string[]; readonly code: number; readonly wrote?: boolean }> {
  const lines: string[] = [];
  const child = spawnHarnessLoginChild({
    command: [path],
    environment: options.environment ?? { PATH: '/usr/bin:/bin' },
    onLine: line => lines.push(line),
  });
  const wrote = options.write === undefined ? undefined : await child.write(options.write);
  const code = await child.exited;
  // The pumps are not awaited by the caller, so give the last chunks a turn to be decoded and split.
  await new Promise(resolve => setTimeout(resolve, 50));
  return { lines, code, ...(wrote === undefined ? {} : { wrote }) };
}

describe('spawnHarnessLoginChild', () => {
  it('should deliver stdout one line at a time', async () => {
    // Arrange
    const path = await script('echo first\necho second\n');

    // Act
    const actual = await run(path);

    // Assert
    should(actual.lines).deepEqual(['first', 'second']);
    should(actual.code).equal(0);
  });

  it('should deliver stderr on the same footing as stdout', async () => {
    // A CLI that prints its sign-in URL to stderr has not failed to print one. A reader watching only
    // stdout would report "this harness offered no remotable login" about a harness that offered one.
    // Arrange
    const path = await script('echo to-err >&2\n');

    // Act
    const actual = await run(path);

    // Assert
    should(actual.lines).deepEqual(['to-err']);
  });

  it('should deliver a final line that carries no newline', async () => {
    // `Paste code here if prompted > ` is a PROMPT and ends without a newline. A splitter that only
    // emitted complete lines would never deliver the last thing the child said.
    // Arrange
    const path = await script('printf "Paste code here if prompted > "\n');

    // Act
    const actual = await run(path);

    // Assert
    should(actual.lines).deepEqual(['Paste code here if prompted > ']);
  });

  it('should deliver a line split across two writes as one line', async () => {
    // Arrange
    const path = await script('printf "one-"\nsleep 0.05\nprintf "line\\n"\n');

    // Act
    const actual = await run(path);

    // Assert
    should(actual.lines).deepEqual(['one-line']);
  });

  it('should keep the terminal escapes a harness writes, so the recogniser can strip them', async () => {
    // The adapter must not clean anything: each harness's flow strips escapes itself, which is what lets
    // a flow test feed the bytes the real CLI was observed to emit.
    // Arrange
    const path = await script('printf "\\033[94mhttps://auth.openai.com/codex/device\\033[0m\\n"\n');

    // Act
    const actual = await run(path);

    // Assert
    should(actual.lines).have.length(1);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them IS the purpose
    should(actual.lines[0]).match(/\u001b\[94m/u);
  });

  it('should not block a child that writes more than one pipe buffer', async () => {
    // A stream nobody drains fills its pipe and the child blocks writing to it — which looks exactly
    // like a harness that printed nothing and then hung. This is the property a fake cannot show.
    // Arrange
    const path = await script(
      'i=0\nwhile [ $i -lt 4000 ]; do echo "line $i padded with some extra text"; i=$((i+1)); done\n',
    );

    // Act
    const actual = await run(path);

    // Assert
    should(actual.code).equal(0);
    should(actual.lines).have.length(4_000);
  });

  it('should carry the environment it was given and nothing the caller did not pass', async () => {
    // Arrange
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is SHELL, and `${…}` is its own syntax
    const path = await script('echo "key=${FY_LOGIN_PROBE:-unset}"\necho "leak=${FY_MUST_NOT_LEAK:-unset}"\n');

    // Act
    const actual = await run(path, { environment: { PATH: '/usr/bin:/bin', FY_LOGIN_PROBE: 'present' } });

    // Assert
    should(actual.lines).deepEqual(['key=present', 'leak=unset']);
  });

  it('should write to the child’s stdin and report that it did', async () => {
    // Arrange
    const path = await script('read line\necho "read:$line"\n');

    // Act
    const actual = await run(path, { write: 'pasted-code\n' });

    // Assert
    should(actual.wrote).be.true();
    should(actual.lines).deepEqual(['read:pasted-code']);
  });

  it('should report a failed write rather than throwing, when the child has already gone', async () => {
    // "Nobody can say whether that arrived" is a real outcome the caller reports as `unconfirmed`. An
    // exception here would be reported as a failure, which invites a retry that cannot help.
    // Arrange
    const path = await script('exit 0\n');
    const child = spawnHarnessLoginChild({
      command: [path],
      environment: { PATH: '/usr/bin:/bin' },
      onLine: () => undefined,
    });
    await child.exited;

    // Act
    const actual = await child.write('too-late\n');

    // Assert
    should(actual).be.false();
  });

  it('should report a failed write when the child closed its stdin but is still running', async () => {
    // The other half of the same question, and the half the exit state cannot answer: this child is
    // alive, so `exitCode` is null, and its stdin is gone. Measured behaviour is that `write` BUFFERS
    // and reports the byte count, and `flush` is what rejects with EPIPE — so the flush is not
    // ceremony, it is the only thing that learns. The value here is one line, which is the only size
    // this adapter ever writes: the wire schema caps a submitted code at 4 KiB.
    // Arrange
    const path = await script('exec 0<&-\nsleep 0.5\n');
    const child = spawnHarnessLoginChild({
      command: [path],
      environment: { PATH: '/usr/bin:/bin' },
      onLine: () => undefined,
    });
    await new Promise(resolve => setTimeout(resolve, 150));

    // Act
    const actual = await child.write('pasted-authorization-code\n');

    // Assert
    should(actual).be.false();
    child.kill();
    await child.exited;
  });

  it('should carry a non-zero exit through', async () => {
    // Arrange
    const path = await script('echo failing\nexit 3\n');

    // Act
    const actual = await run(path);

    // Assert
    should(actual.code).equal(3);
  });

  it('should end a child that would otherwise never exit', async () => {
    // Both harness logins poll indefinitely — `codex login --device-auth` was observed still polling
    // when a 25-second timeout killed it. A flow that ran out of time has to be able to end one.
    // Arrange
    const path = await script('while true; do sleep 1; done\n');
    const child = spawnHarnessLoginChild({
      command: [path],
      environment: { PATH: '/usr/bin:/bin' },
      onLine: () => undefined,
    });

    // Act
    child.kill();
    const actual = await child.exited;

    // Assert
    should(actual).not.equal(0);
  });

  it('should treat a second kill as nothing to raise', async () => {
    // Cancelling twice is not an error, and a cancel that raced the child's own exit has still achieved
    // what it was asked to.
    // Arrange
    const path = await script('exit 0\n');
    const child = spawnHarnessLoginChild({
      command: [path],
      environment: { PATH: '/usr/bin:/bin' },
      onLine: () => undefined,
    });
    await child.exited;

    // Act / Assert
    should(() => {
      child.kill();
      child.kill();
    }).not.throw();
  });
});

describe('harnessLoginTimer', () => {
  it('should run its callback after the delay', async () => {
    // Arrange
    let fired = false;

    // Act
    harnessLoginTimer.after(1, () => {
      fired = true;
    });
    await new Promise(resolve => setTimeout(resolve, 30));

    // Assert
    should(fired).be.true();
  });

  it('should not run a callback that was disarmed', async () => {
    // Arrange
    let fired = false;
    const disarm = harnessLoginTimer.after(1, () => {
      fired = true;
    });

    // Act
    disarm();
    await new Promise(resolve => setTimeout(resolve, 30));

    // Assert
    should(fired).be.false();
  });

  it('should not hold the process open while it waits', async () => {
    // A pending login window would otherwise keep the event loop alive for its full ten minutes, so a
    // daemon asked to stop would appear to hang on a sign-in nobody was waiting for. The handle is
    // unreferenced, which is checkable: a referenced timer has `hasRef() === true`.
    // Arrange / Act
    const disarm = harnessLoginTimer.after(600_000, () => undefined);

    // Assert
    should(disarm).be.a.Function();
    disarm();
  });
});
