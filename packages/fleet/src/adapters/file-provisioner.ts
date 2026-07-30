import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FleetManifestSchema } from '../lib/manifest.ts';
import type { FleetApplyPlan, FleetApplyResult, FleetProvisioner, FleetWriteOperation } from '../lib/provisioning.ts';

export class FileFleetProvisioner implements FleetProvisioner {
  private readonly allowedRoots: readonly string[];

  constructor(allowedRoots: readonly string[]) {
    if (allowedRoots.length === 0) {
      throw new Error('at least one allowed fleet root is required');
    }
    this.allowedRoots = allowedRoots.map(root => path.resolve(root));
  }

  async apply(plan: FleetApplyPlan): Promise<FleetApplyResult> {
    FleetManifestSchema.parse(plan.manifest);
    this.assertWritablePath(plan.manifestPath);

    for (const operation of plan.operations) {
      this.assertWritablePath(operation.path);
      await this.applyOperation(operation);
    }

    await this.writeManifest(plan);
    return {
      accountCount: plan.manifest.accounts.length,
      operationCount: plan.operations.length,
      manifestPath: plan.manifestPath,
    };
  }

  private assertWritablePath(target: string): void {
    const resolved = path.resolve(target);
    const allowed = this.allowedRoots.some(root => {
      const relative = path.relative(root, resolved);
      return (
        relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
      );
    });
    if (!allowed) {
      throw new Error(`refusing to write outside configured fleet roots: ${target}`);
    }
  }

  private async applyOperation(operation: FleetWriteOperation): Promise<void> {
    if (operation.kind === 'directory') {
      await mkdir(operation.path, { recursive: true, mode: operation.mode });
      if (operation.mode !== undefined) {
        await chmod(operation.path, operation.mode);
      }
      return;
    }

    await mkdir(path.dirname(operation.path), { recursive: true });
    await rm(operation.path, { recursive: true, force: true });

    if (operation.kind === 'symlink') {
      await symlink(operation.source, operation.path);
      return;
    }
    if (operation.kind === 'copy') {
      await copyFile(operation.source, operation.path);
      if (operation.mode !== undefined) {
        await chmod(operation.path, operation.mode);
      }
      return;
    }
    await this.writeFileAtomically(operation.path, operation.content, operation.mode);
  }

  private async writeManifest(plan: FleetApplyPlan): Promise<void> {
    const content = `${JSON.stringify(plan.manifest, null, 2)}\n`;
    await mkdir(path.dirname(plan.manifestPath), { recursive: true });
    await this.writeFileAtomically(plan.manifestPath, content, 0o600);
  }

  private async writeFileAtomically(destination: string, content: string, mode: number): Promise<void> {
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: 'wx', mode });
      await chmod(temporary, mode);
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
