import {
  type ClockPort,
  createFoundationPaths,
  type EnvironmentPort,
  type FileSystemFactory,
  type FileSystemPort,
  type FoundationPaths,
  type HomeLockFactory,
  resolveStateHome,
  type SerialExecutor,
  type SessionIndex,
  type SessionIndexFactory,
} from '../../lib/index.ts';
import { DaemonStorage } from './session-storage.ts';
import type { LayoutInitialization, StateHomeLayout } from './state-home-layout.ts';

export interface OpenedDaemonStorage {
  readonly paths: FoundationPaths;
  /**
   * The confined filesystem this home was opened through.
   *
   * Published so a later acquisition — the analytics materialization is the first — is confined by the
   * SAME port, under the lifetime lock this open is holding. A second port built from the same paths
   * would be a second set of rules over one home, and the rule that matters here is the one that
   * refuses a symlinked database file.
   */
  readonly fileSystem: FileSystemPort;
  readonly layout: LayoutInitialization;
  readonly storage: DaemonStorage;
}

export class DaemonStorageFactory {
  constructor(
    private readonly environment: EnvironmentPort,
    private readonly fileSystems: FileSystemFactory,
    private readonly layout: StateHomeLayout,
    private readonly locks: HomeLockFactory,
    private readonly indexes: SessionIndexFactory,
    private readonly clock: ClockPort,
    private readonly serial: () => SerialExecutor,
  ) {}

  async open(): Promise<OpenedDaemonStorage> {
    const home = resolveStateHome(this.environment.stateHomeInput());
    const paths = createFoundationPaths(home);
    const fileSystem = this.fileSystems.create(paths);
    // Refuse a foreign or unsupported home before creating anything, but decide for real under the
    // lifetime lock: this reading is stale the moment another daemon bootstraps the same home.
    const preliminary = await this.layout.inspect(paths, fileSystem);
    if (preliminary.kind === 'initialize') await fileSystem.ensureDirectory(paths.home, 0o700);
    const homeLock = await this.locks.acquire(paths, fileSystem);
    let layout: LayoutInitialization;
    let index: SessionIndex;
    try {
      layout = await this.layout.initialize(paths, fileSystem);
      index = await this.indexes.open(paths, fileSystem);
    } catch (error) {
      await homeLock.release();
      throw error;
    }
    const storage = new DaemonStorage(paths, fileSystem, index, this.clock, this.serial(), homeLock);
    try {
      // Version-1 directories predate the journal contract, so they are migrated under the home
      // lock before anything reads them. A version-2 session whose journal is already gone is NOT
      // touched here: opening the home must still succeed so rebuild can quarantine that one
      // session and keep every healthy sibling indexed.
      await storage.upgradeLegacySessions();
      await storage.repairSessionPermissions();
      return { paths, fileSystem, layout, storage };
    } catch (error) {
      await storage.close();
      throw error;
    }
  }
}
