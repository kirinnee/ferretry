/**
 * The `cloudflared` child as a real process: the token in its environment and NOT in its argument
 * vector, its log read line by line, and a stop that escalates when the child ignores it.
 */

import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import { BunConnectorProcesses, forEachLine } from '../../../src/adapters/tunnel/bun-connector-process.ts';
import { CLOUDFLARED_ARGUMENTS, connectorEnvironment } from '../../../src/lib/tunnel/index.ts';
import { connectorRecords, fakeCloudflared, removeTempDirectories, sha256, waitFor } from './support.ts';

afterEach(removeTempDirectories);

const TOKEN = 'fake-connector-token-PROCESS';

/** Whether a pid is still a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('the cloudflared process', () => {
  it('should hand the token to the child’s environment only, and read its log line by line', async () => {
    // Arrange
    const fake = await fakeCloudflared();
    const lines: string[] = [];
    const processes = new BunConnectorProcesses(process.env);

    // Act
    const child = processes.spawn(
      { executable: fake.path, args: CLOUDFLARED_ARGUMENTS, environment: connectorEnvironment(TOKEN) },
      line => lines.push(line),
    );
    await waitFor(() => lines.some(line => line.includes('Registered tunnel connection')), 'registration');
    const [record] = await connectorRecords(fake.record);
    // What any other user on this machine could read in a process list.
    const cmdline = await Bun.file(`/proc/${String(record?.pid)}/cmdline`)
      .text()
      .catch(() => '');
    child.terminate();
    child.terminate();
    const code = await child.exited;

    // Assert
    should(record?.argv).deepEqual([...CLOUDFLARED_ARGUMENTS]);
    should(record?.tokenSha256).equal(sha256(TOKEN));
    should(JSON.stringify(record).includes(TOKEN)).be.false();
    should(cmdline.includes(TOKEN)).be.false();
    should(lines[0]).match(/INF Starting tunnel/u);
    should(code).be.null();
    should(alive(record?.pid ?? 0)).be.false();
  });

  it('should report an exit code, and deliver a last line that had no newline', async () => {
    // Arrange
    const fake = await fakeCloudflared('partial');
    const exiting = await fakeCloudflared('exit:7');
    const lines: string[] = [];
    const processes = new BunConnectorProcesses(process.env);

    // Act
    const partial = processes.spawn({ executable: fake.path, args: [], environment: {} }, line => lines.push(line));
    const partialCode = await partial.exited;
    await waitFor(() => lines.length === 2, 'the unterminated line');
    const exited = await processes.spawn({ executable: exiting.path, args: [], environment: {} }, () => undefined)
      .exited;

    // Assert
    should(partialCode).equal(0);
    should(lines[1]).equal('2026-10-21T10:00:01Z INF Registered tunnel connection connIndex=3');
    should(exited).equal(7);
  });

  it('should kill a child that ignores its stop once the grace period is over', async () => {
    // Arrange
    const fake = await fakeCloudflared('stubborn');
    const lines: string[] = [];
    const processes = new BunConnectorProcesses(process.env, 200);
    const child = processes.spawn({ executable: fake.path, args: [], environment: {} }, line => lines.push(line));
    await waitFor(() => lines.some(line => line.includes('Registered')), 'the child to start');

    // Act
    child.terminate();
    const code = await child.exited;

    // Assert
    should(code).be.null();
  });

  it('should throw when the binary cannot be started at all', () => {
    const processes = new BunConnectorProcesses(process.env);
    should(() =>
      processes.spawn({ executable: '/nonexistent/cloudflared', args: [], environment: {} }, () => undefined),
    ).throw();
  });

  it('should split a stream into lines across chunk boundaries and characters', async () => {
    // Arrange
    const encoder = new TextEncoder();
    const bytes = encoder.encode('one\ntwö\nthr');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 6));
        controller.enqueue(bytes.slice(6));
        controller.close();
      },
    });
    const lines: string[] = [];

    // Act
    await forEachLine(stream, line => lines.push(line));

    // Assert
    should(lines).deepEqual(['one', 'twö', 'thr']);
  });
});
