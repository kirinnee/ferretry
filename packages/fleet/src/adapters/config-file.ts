import { z } from 'zod';
import { type FleetConfig, FleetConfigSchema } from '../lib/config.ts';

export class FleetConfigFileError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`invalid fleet config at ${path}: ${message}`);
    this.name = 'FleetConfigFileError';
  }
}

export class FileFleetConfigSource {
  constructor(private readonly path: string) {}

  async load(): Promise<FleetConfig> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) {
      throw new FleetConfigFileError(this.path, 'file does not exist');
    }

    let raw: unknown;
    try {
      raw = Bun.YAML.parse(await file.text()) ?? {};
    } catch (error) {
      throw new FleetConfigFileError(this.path, error instanceof Error ? error.message : String(error));
    }

    const parsed = FleetConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new FleetConfigFileError(this.path, z.prettifyError(parsed.error));
    }
    return parsed.data;
  }
}
