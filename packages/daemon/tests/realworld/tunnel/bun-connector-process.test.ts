// Realworld: asserts wall-clock speed; the outcome depends on the machine, not the code.
import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import { BunConnectorProcesses } from '../../../src/adapters/tunnel/bun-connector-process.ts';
import { fakeCloudflared, removeTempDirectories, waitFor } from '../../integration/tunnel/support.ts';

afterEach(removeTempDirectories);

describe('the cloudflared process', () => {
  it('should kill a child that ignores its stop once the grace period is over', async () => {
    // Arrange
    const fake = await fakeCloudflared('stubborn');
    const lines: string[] = [];
    const processes = new BunConnectorProcesses(process.env, 200);
    const child = processes.spawn({ executable: fake.path, args: [], environment: {} }, line => lines.push(line));
    await waitFor(() => lines.some(line => line.includes('Registered')), 'the child to start');

    // Act
    const started = Date.now();
    child.terminate();
    const code = await child.exited;

    // Assert
    should(code).be.null();
    should(Date.now() - started).be.aboveOrEqual(150);
  });
});
