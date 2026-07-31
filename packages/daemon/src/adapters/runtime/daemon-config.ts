import {
  type DaemonConfig,
  defaultDaemonConfig,
  parseDaemonConfig,
  type FileSystemPort,
  type FoundationPaths,
} from '../../lib/index.ts';

/** Durable daemon configuration adapter; the state filesystem keeps the document private and atomic. */
export class FileDaemonConfig {
  constructor(
    private readonly paths: FoundationPaths,
    private readonly files: FileSystemPort,
  ) {}

  async load(): Promise<DaemonConfig> {
    const text = await this.files.readText(this.paths.daemonConfig);
    if (text === undefined) {
      const config = defaultDaemonConfig();
      await this.files.writeTextAtomic(this.paths.daemonConfig, `${JSON.stringify(config, null, 2)}\n`);
      return config;
    }
    return parseDaemonConfig(JSON.parse(text));
  }
}
