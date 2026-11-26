import type { StatePort } from '@ferretry/kernel/contract';
import { WARDEN_STATE } from '../../contract/index.ts';
import type {
  AutoMoveMemory,
  ListedNoticesStore,
  MachineMembersStore,
  WardenRuntimeState,
  WardenStateStore,
} from '../lib/index.ts';

const AUTO_MOVE_KEY = 'autoMoveMemory';
/** The members each machine notice listed (`machine-notices.ts`), by notice ref: kept in the same file under its own key. */
const NOTICE_KEY = 'machineNotices';
/** What each machine notice last raised, by ref (`machine-notices.ts`), so a notice the owner closed stays closed after a restart. */
const LISTED_KEY = 'listedNotices';

/** A file the kernel found damaged is never read as empty: the sweep fails and says so. */
class WardenStateDamaged extends Error {
  constructor(sentence: string) {
    super(sentence);
    this.name = 'WardenStateDamaged';
  }
}

/**
 * The sweep's memory (`state/warden/state.json`). The sweep writes its whole document each time; the move ledger lives in
 * the same file under its own key, so a sweep write keeps it and a ledger write keeps the sweep's.
 */
export class StateWardenStateStore implements WardenStateStore {
  constructor(private readonly state: StatePort) {}

  async read(): Promise<unknown> {
    const read = await this.state.read(WARDEN_STATE);
    if (!read.ok) throw new WardenStateDamaged(read.error.sentence);
    if (read.value === undefined) return undefined;
    const {
      format: _format,
      [AUTO_MOVE_KEY]: _ledger,
      [NOTICE_KEY]: _notices,
      [LISTED_KEY]: _listed,
      ...sweep
    } = read.value as Record<string, unknown>;
    return sweep;
  }

  async write(state: WardenRuntimeState): Promise<void> {
    const written = await this.state.update(WARDEN_STATE, current => {
      const kept = current as Record<string, unknown> | undefined;
      const ledger = kept?.[AUTO_MOVE_KEY];
      const notices = kept?.[NOTICE_KEY];
      const listed = kept?.[LISTED_KEY];
      return {
        ...state,
        ...(ledger === undefined ? {} : { [AUTO_MOVE_KEY]: ledger }),
        ...(notices === undefined ? {} : { [NOTICE_KEY]: notices }),
        ...(listed === undefined ? {} : { [LISTED_KEY]: listed }),
        format: 1 as const,
      };
    });
    if (!written.ok) throw new WardenStateDamaged(written.error.sentence);
  }
}

/** The move's own ledger: what it moved and when, kept in the same file. */
export class StateAutoMoveLedger {
  constructor(private readonly state: StatePort) {}

  async read(): Promise<unknown> {
    const read = await this.state.read(WARDEN_STATE);
    if (!read.ok) throw new WardenStateDamaged(read.error.sentence);
    return (read.value as Record<string, unknown> | undefined)?.[AUTO_MOVE_KEY];
  }

  async write(memory: AutoMoveMemory): Promise<void> {
    const written = await this.state.update(WARDEN_STATE, current => ({
      ...(current as Record<string, unknown> | undefined),
      [AUTO_MOVE_KEY]: memory,
      format: 1 as const,
    }));
    if (!written.ok) throw new WardenStateDamaged(written.error.sentence);
  }
}

/** The members one machine notice listed, kept in the sweep's file under `machineNotices.<ref>`. */
export class StateMachineMembers implements MachineMembersStore {
  constructor(
    private readonly state: StatePort,
    private readonly ref: string,
  ) {}

  async read(): Promise<Readonly<Record<string, readonly string[]>>> {
    const read = await this.state.read(WARDEN_STATE);
    if (!read.ok) throw new WardenStateDamaged(read.error.sentence);
    const notices = (read.value as Record<string, unknown> | undefined)?.[NOTICE_KEY];
    const held = (notices as Record<string, unknown> | undefined)?.[this.ref];
    return typeof held === 'object' && held !== null ? (held as Record<string, readonly string[]>) : {};
  }

  async write(members: Readonly<Record<string, readonly string[]>>): Promise<void> {
    const written = await this.state.update(WARDEN_STATE, current => {
      const kept = current as Record<string, unknown> | undefined;
      const notices = { ...(kept?.[NOTICE_KEY] as Record<string, unknown> | undefined), [this.ref]: members };
      return { ...kept, [NOTICE_KEY]: notices, format: 1 as const };
    });
    if (!written.ok) throw new WardenStateDamaged(written.error.sentence);
  }
}

/** The members each machine notice last raised, kept in the sweep's file under `listedNotices.<ref>`. */
export class StateListedNotices implements ListedNoticesStore {
  constructor(private readonly state: StatePort) {}

  async read(ref: string): Promise<ReadonlySet<string>> {
    const read = await this.state.read(WARDEN_STATE);
    if (!read.ok) throw new WardenStateDamaged(read.error.sentence);
    const listed = (read.value as Record<string, unknown> | undefined)?.[LISTED_KEY];
    const held = (listed as Record<string, unknown> | undefined)?.[ref];
    return new Set(Array.isArray(held) ? held.filter((member): member is string => typeof member === 'string') : []);
  }

  write(ref: string, members: readonly string[]): Promise<void> {
    return this.change(listed => ({ ...listed, [ref]: [...new Set(members)].sort() }));
  }

  forget(ref: string): Promise<void> {
    return this.change(({ [ref]: _gone, ...rest }) => rest);
  }

  private async change(edit: (listed: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
    const written = await this.state.update(WARDEN_STATE, current => {
      const kept = current as Record<string, unknown> | undefined;
      return {
        ...kept,
        [LISTED_KEY]: edit((kept?.[LISTED_KEY] as Record<string, unknown> | undefined) ?? {}),
        format: 1 as const,
      };
    });
    if (!written.ok) throw new WardenStateDamaged(written.error.sentence);
  }
}
