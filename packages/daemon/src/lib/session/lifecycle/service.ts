import { createSessionRecord, lifecycleSessionId, transitionSessionRecord } from './policy.ts';
import type {
  CreateSessionLifecycleRequest,
  LifecycleClock,
  SessionLifecycleLauncher,
  SessionLifecycleRecord,
  SessionLifecycleRepository,
} from './types.ts';

/** Coordinates durable lifecycle decisions with injected persistence and terminal ports. */
export class SessionLifecycleService {
  constructor(
    private readonly repository: SessionLifecycleRepository,
    private readonly launcher: SessionLifecycleLauncher,
    private readonly clock: LifecycleClock,
  ) {}

  async create(request: CreateSessionLifecycleRequest): Promise<SessionLifecycleRecord> {
    const created = createSessionRecord(request, this.clock.now());
    await this.repository.write(created.record, created.event);
    return created.record;
  }

  async start(id: string): Promise<SessionLifecycleRecord> {
    const current = await this.require(id);
    const starting = transitionSessionRecord(current, 'starting', this.clock.now());
    await this.repository.write(starting.record, starting.event);
    try {
      await this.launcher.launch(starting.record);
    } catch (error) {
      const failed = transitionSessionRecord(
        starting.record,
        'failed',
        this.clock.now(),
        error instanceof Error ? error.message : String(error),
      );
      await this.repository.write(failed.record, failed.event);
      throw error;
    }
    const running = transitionSessionRecord(starting.record, 'running', this.clock.now());
    await this.repository.write(running.record, running.event);
    return running.record;
  }

  async createAndStart(request: CreateSessionLifecycleRequest): Promise<SessionLifecycleRecord> {
    const created = await this.create(request);
    return await this.start(created.config.id);
  }

  async stop(id: string, reason = 'stopped by client'): Promise<SessionLifecycleRecord> {
    const current = await this.require(id);
    if (current.state.status === 'stopped') return current;
    await this.launcher.stop(current);
    const stopped = transitionSessionRecord(current, 'stopped', this.clock.now(), reason);
    await this.repository.write(stopped.record, stopped.event);
    return stopped.record;
  }

  private async require(id: string): Promise<SessionLifecycleRecord> {
    const parsed = lifecycleSessionId(id);
    const record = await this.repository.read(parsed);
    if (!record) throw new Error(`session not found: ${id}`);
    return record;
  }
}
