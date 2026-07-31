import { describe, it } from 'bun:test';
import should from 'should';
import type { z } from 'zod';
import { BrowserController } from '../../../src/lib/browser/controller';
import type { BrowserCommand, IBrowserIo } from '../../../src/lib/browser/types';
import { actionResult, status } from './fixtures';

interface Sent {
  readonly path: string;
  readonly method: string | undefined;
  readonly body: unknown;
}

function harness(
  payload: unknown,
  options: { selfSessionId?: string; writeFails?: string; rejectWith?: unknown } = {},
) {
  const sent: Sent[] = [];
  const out: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  const written: Array<{ path: string; base64: string }> = [];

  const io: IBrowserIo = {
    success: message => out.push(message),
    warn: message => out.push(message),
    error: message => errors.push(message),
    setExitCode: code => exitCodes.push(code),
  };
  const gateway = {
    // biome-ignore lint/suspicious/useAwait: the port is async; this double answers synchronously.
    request: async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
      sent.push({
        path,
        method: init?.method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if ('rejectWith' in options) throw options.rejectWith;
      return schema.parse(payload);
    },
  };
  const screenshots = {
    write: async (path: string, base64: string): Promise<void> => {
      if (options.writeFails) throw new Error(options.writeFails);
      written.push({ path, base64 });
    },
  };
  const controller = new BrowserController(gateway, io, screenshots, {
    ...(options.selfSessionId ? { selfSessionId: options.selfSessionId } : {}),
  });
  return { sent, out, errors, exitCodes, written, run: (command: BrowserCommand) => controller.run(command) };
}

describe('issuing browser calls', () => {
  it('should GET the status and render it', async () => {
    // Arrange
    const { sent, out, run } = harness(status(), { selfSessionId: 'sess-1' });

    // Act
    const actual = await run({ command: 'status' });

    // Assert
    should(actual).equal(0);
    should(sent[0]?.path).equal('/v1/sessions/sess-1/browser');
    should(sent[0]?.method).equal('GET');
    should(out[0]).containEql('browser running');
  });

  it('should POST an action as JSON', async () => {
    // Arrange
    const { sent, out, run } = harness(actionResult(), { selfSessionId: 'sess-1' });

    // Act
    await run({ command: 'navigate', url: 'https://example.com/a' });

    // Assert
    should(sent[0]?.method).equal('POST');
    should(sent[0]?.body).deepEqual({ action: 'navigate', url: 'https://example.com/a' });
    should(out[0]).equal('Example A\nhttps://example.com/a');
  });

  it('should print only the text a read fetched', async () => {
    // Arrange
    const { out, run } = harness(actionResult({ text: 'body copy' }), { selfSessionId: 'sess-1' });

    // Act
    await run({ command: 'read' });

    // Assert
    should(out).deepEqual(['body copy']);
  });

  it('should reach the daemon-global login route with no session in scope', async () => {
    // Arrange
    const { sent, out, run } = harness({ state: 'open', profilePrimed: true });

    // Act
    const actual = await run({ command: 'login', action: 'status' });

    // Assert
    should(actual).equal(0);
    should(sent[0]?.path).equal('/v1/browser/login');
    should(out[0]).containEql('browser login window: open');
  });
});

describe('screenshots', () => {
  it('should write the bytes and report where they went', async () => {
    // Arrange
    const { written, out, run } = harness(actionResult({ screenshotBase64: 'aGk=' }), { selfSessionId: 'sess-1' });

    // Act
    const actual = await run({ command: 'screenshot', output: 'shot.png' });

    // Assert — kteam printed nothing here, so a successful capture looked like a no-op.
    should(actual).equal(0);
    should(written).deepEqual([{ path: 'shot.png', base64: 'aGk=' }]);
    should(out).deepEqual(['screenshot written to shot.png']);
  });

  it('should report a response that carried no screenshot bytes', async () => {
    // Arrange
    const { written, errors, exitCodes, run } = harness(actionResult(), { selfSessionId: 'sess-1' });

    // Act
    const actual = await run({ command: 'screenshot', output: 'shot.png' });

    // Assert
    should(actual).equal(1);
    should(written).be.empty();
    should(errors[0]).containEql('no screenshot bytes');
    should(exitCodes).deepEqual([1]);
  });

  it('should report a failure to write the file', async () => {
    // Arrange
    const options = { selfSessionId: 'sess-1', writeFails: 'permission denied' };
    const { errors, run } = harness(actionResult({ screenshotBase64: 'aGk=' }), options);

    // Act
    const actual = await run({ command: 'screenshot', output: '/root/shot.png' });

    // Assert
    should(actual).equal(1);
    should(errors).deepEqual(['permission denied']);
  });
});

describe('failures', () => {
  it('should report a malformed daemon response instead of rendering undefined', async () => {
    // Arrange — kteam cast the response and printed whatever fell out of it.
    const { errors, exitCodes, run } = harness({ state: 'running' }, { selfSessionId: 'sess-1' });

    // Act
    const actual = await run({ command: 'status' });

    // Assert
    should(actual).equal(1);
    should(errors).have.length(1);
    should(exitCodes).deepEqual([1]);
  });

  it('should report a transport failure', async () => {
    // Arrange
    const { errors, run } = harness(undefined, {
      selfSessionId: 'sess-1',
      rejectWith: new Error('fyd is unavailable'),
    });

    // Act
    const actual = await run({ command: 'reload' });

    // Assert
    should(actual).equal(1);
    should(errors).deepEqual(['fyd is unavailable']);
  });

  it('should report a missing session target before calling the daemon', async () => {
    // Arrange
    const { sent, errors, run } = harness(status());

    // Act
    const actual = await run({ command: 'status' });

    // Assert
    should(actual).equal(1);
    should(sent).be.empty();
    should(errors[0]).containEql('--session');
  });

  it('should stringify a non-Error rejection', async () => {
    // Arrange
    const { errors, run } = harness(undefined, { selfSessionId: 'sess-1', rejectWith: 'not an error object' });

    // Act
    await run({ command: 'reload' });

    // Assert
    should(errors).deepEqual(['not an error object']);
  });
});
