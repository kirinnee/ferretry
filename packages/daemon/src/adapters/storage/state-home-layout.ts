import { basename, join } from 'node:path';
import {
  decideLayout,
  type FileSystemPort,
  type FoundationPaths,
  LAYOUT_VERSION_MODE,
  type LayoutDecision,
  layoutVersionContent,
  requiredLayoutDirectories,
  StateHomeLayoutError,
} from '../../lib/index.ts';

export interface LayoutInitialization {
  readonly created: boolean;
}

/** A directory bootstrap creates, with the only entries bootstrap itself can leave inside it. */
interface BootstrapDirectory {
  readonly path: string;
  readonly directories: ReadonlyMap<string, BootstrapDirectory>;
  readonly file: (name: string) => boolean;
}

function noFiles(): boolean {
  return false;
}

function bootstrapDirectory(
  path: string,
  children: readonly BootstrapDirectory[] = [],
  file: (name: string) => boolean = noFiles,
): BootstrapDirectory {
  return { path, directories: new Map(children.map(child => [basename(child.path), child])), file };
}

/**
 * The log directory holds log files and nothing else.
 *
 * Whoever supervises the daemon — launchd, systemd, or the CLI's own detached spawn — points both of
 * its streams at a single `<daemon>.log` here. A subdirectory, or a file that is not a log, is not
 * something our tooling produces, so it still reads as foreign state.
 */
function logFileOnly(name: string): boolean {
  return name.length > '.log'.length && name.endsWith('.log');
}

/** Atomic writes name their scratch file `<target>.<id>.tmp`, with a strict path-safe writer id. */
function scratchFileFor(...targets: readonly string[]): (name: string) => boolean {
  const suffix = '.tmp';
  const prefixes = targets.map(target => `${basename(target)}.`);
  return name => {
    if (!name.endsWith(suffix)) return false;
    const prefix = prefixes.find(candidate => name.startsWith(candidate));
    if (prefix === undefined) return false;
    return /^[a-zA-Z0-9-]+$/.test(name.slice(prefix.length, name.length - suffix.length));
  };
}

/**
 * The message-token key's own name — THE one spelling of it, exported so nothing spells it twice.
 *
 * TWO PROGRAMS HAVE TO AGREE ABOUT THIS STRING, which is exactly the shape of defect this repo has
 * shipped before with the layout marker: the codec publishes the file, and this recovery decides
 * whether a home holding it may still be claimed. A second literal that drifted would not fail
 * loudly — it would make a home carrying a perfectly good key read as foreign state and refuse to
 * boot for ever, and the only move left to its owner would be to delete an intact installation. So
 * the name is declared here, beside the rule that recognises it, and the codec derives its path from
 * this constant rather than repeating the string.
 *
 * The key is created once, on first use, by the same daemon that bootstraps the home, so a crash
 * between publishing it and writing the marker leaves a home holding exactly this file.
 *
 * It is recognised by EXACT basename and as a regular file only. Nothing wider: a directory of that
 * name, a symlink, or any other name under `state` is still foreign state, and the temporary that
 * publishes the key is recognised only under the temporary directory, by the scratch grammar.
 */
export const SESSION_MESSAGE_TOKEN_KEY_BASENAME = 'session-message-token.key';

function stateHomeKeyFile(name: string): boolean {
  return name === SESSION_MESSAGE_TOKEN_KEY_BASENAME;
}

export class StateHomeLayout {
  /**
   * The whole shape bootstrap can leave behind before the marker exists: the lifetime lock, the
   * required directories, and the marker's own scratch file. Every prefix of the bootstrap sequence
   * is a sub-shape of this tree, so recovery covers a crash at any point rather than only the fully
   * created scaffold. Anything outside the tree — an authoritative config or fleet document, index
   * or session content, an unexpected temporary file, an unknown name, or a known name of the wrong
   * type — is foreign state that keeps refusing.
   */
  private bootstrapShape(paths: FoundationPaths): BootstrapDirectory {
    const lockName = basename(paths.daemonLock);
    return bootstrapDirectory(
      paths.home,
      [
        bootstrapDirectory(paths.config),
        bootstrapDirectory(paths.fleet),
        bootstrapDirectory(paths.logs, [], logFileOnly),
        bootstrapDirectory(
          paths.state,
          [
            bootstrapDirectory(paths.index),
            bootstrapDirectory(paths.sessions),
            // The marker's scratch and the token key's scratch, and no other temporary name.
            bootstrapDirectory(
              paths.temporary,
              [],
              scratchFileFor(paths.layoutVersion, join(paths.state, SESSION_MESSAGE_TOKEN_KEY_BASENAME)),
            ),
          ],
          stateHomeKeyFile,
        ),
      ],
      name => name === lockName,
    );
  }

  /**
   * The shape that exists before bootstrap has run even once: the log directory, and its logs.
   *
   * The CLI creates this so the service manager has somewhere to write, which happens BEFORE the
   * daemon is launched and therefore before any lock, directory or marker of ours exists. It is
   * deliberately narrower than the bootstrap shape — without the lock there is no evidence that a
   * bootstrap of ours ever started, so a scaffold directory here is still foreign state.
   */
  private preBootstrapShape(paths: FoundationPaths): BootstrapDirectory {
    return bootstrapDirectory(paths.home, [bootstrapDirectory(paths.logs, [], logFileOnly)]);
  }

  private async holdsOnlyBootstrapEntries(node: BootstrapDirectory, fileSystem: FileSystemPort): Promise<boolean> {
    for (const entry of await fileSystem.listDirectory(node.path)) {
      if (!entry.directory) {
        // A recognised NAME is not enough: bootstrap writes ordinary files, so a symlink, socket or
        // device wearing one of those names is somebody else's state and still refuses. `directory`
        // being false would have admitted every one of them. `=== true` is deliberate — a source
        // that does not classify its entries fails closed rather than being read as "ordinary".
        if (entry.regularFile !== true || !node.file(entry.name)) return false;
        continue;
      }
      const child = node.directories.get(entry.name);
      if (child === undefined || !(await this.holdsOnlyBootstrapEntries(child, fileSystem))) return false;
    }
    return true;
  }

  private async isRecoverableBootstrap(paths: FoundationPaths, fileSystem: FileSystemPort): Promise<boolean> {
    // The lifetime lock is the first entry BOOTSTRAP puts in the home, so an unmarked home without it
    // was never produced by an interrupted bootstrap of ours. That reasoning does not cover the log
    // directory: the CLI writes that one earlier, before it ever launches us, so a home holding only
    // logs and no lock is a legitimate pre-bootstrap state rather than somebody else's data.
    const held = (await fileSystem.information(paths.daemonLock)) !== undefined;
    const shape = held ? this.bootstrapShape(paths) : this.preBootstrapShape(paths);
    return await this.holdsOnlyBootstrapEntries(shape, fileSystem);
  }

  async inspect(paths: FoundationPaths, fileSystem: FileSystemPort): Promise<LayoutDecision> {
    const marker = await fileSystem.readText(paths.layoutVersion);
    const entries = await fileSystem.listDirectory(paths.home);
    const recoverableBootstrap =
      marker === undefined && entries.length > 0 && (await this.isRecoverableBootstrap(paths, fileSystem));
    const decision = decideLayout(
      marker,
      entries.map(entry => entry.name),
      recoverableBootstrap,
    );
    if (decision.kind === 'refuse') throw new StateHomeLayoutError(paths, decision);
    return decision;
  }

  /** Callers must already hold the lifetime lock: this reads and writes the layout as one owner. */
  async initialize(paths: FoundationPaths, fileSystem: FileSystemPort): Promise<LayoutInitialization> {
    const decision = await this.inspect(paths, fileSystem);

    for (const directory of requiredLayoutDirectories(paths)) await fileSystem.ensureDirectory(directory, 0o700);
    if (decision.kind === 'initialize') {
      await fileSystem.writeTextAtomic(paths.layoutVersion, layoutVersionContent());
    } else {
      await fileSystem.setMode(paths.layoutVersion, LAYOUT_VERSION_MODE);
    }
    for (const reservedFile of [paths.daemonConfig, paths.fleetManifest]) {
      if ((await fileSystem.information(reservedFile)) !== undefined) await fileSystem.setMode(reservedFile, 0o600);
    }
    await fileSystem.sweepTemporaryFiles();
    return { created: decision.kind === 'initialize' };
  }
}
