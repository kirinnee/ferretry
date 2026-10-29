import { describe, expect, it } from 'bun:test';
import {
  SECRET_SCHEMA_VERSION,
  type SecretList,
  type SecretSummary,
  type SecretUseRequest,
  type SecretUseResult,
} from '@ferretry/protocol';
import { SecretController } from '../../../src/lib/secrets/controller';
import type { ISecretGateway, ISecretOutput } from '../../../src/lib/secrets/ports';

class SilentOutput implements ISecretOutput {
  success(): void {}
  error(): void {}
  setExitCode(): void {}
  raw(): void {}
}

class CapturingGateway implements ISecretGateway {
  used: SecretUseRequest | undefined;

  async list(): Promise<SecretList> {
    return { v: SECRET_SCHEMA_VERSION, health: 'ready', secrets: [], references: [] };
  }

  async put(name: string): Promise<SecretSummary> {
    return { name, createdAt: '2026-08-05T10:00:00.000Z', updatedAt: '2026-08-05T10:00:00.000Z' };
  }

  async remove(): Promise<void> {}

  async use(request: SecretUseRequest): Promise<SecretUseResult> {
    this.used = request;
    return { outcome: 'exited', exitCode: 0, stdout: '', stderr: '', truncated: false, used: [] };
  }
}

describe('fy secret use --timeout', () => {
  it('should hand the daemon the whole-millisecond budget the caller asked for', async () => {
    // Arrange
    const gateway = new CapturingGateway();
    const controller = new SecretController(gateway, new SilentOutput(), { read: async () => 'unused' }, '/work');

    // Act
    await controller.use(['env'], { timeout: '2500' });

    // Assert
    expect(gateway.used?.timeoutMs).toBe(2500);
  });

  it('should refuse a zero, negative, fractional or unsafe timeout without calling the daemon', async () => {
    // Arrange
    const gateway = new CapturingGateway();
    const controller = new SecretController(gateway, new SilentOutput(), { read: async () => 'unused' }, '/work');

    // Act + Assert
    for (const bad of ['0', '-5', '1.5', '9007199254740993']) {
      await expect(controller.use(['env'], { timeout: bad })).rejects.toThrow(/--timeout must be a positive whole/u);
    }
    expect(gateway.used).toBeUndefined();
  });
});
