import type { SessionView } from '@ferretry/protocol';
import type { IMigrationGateway } from '../../../src/lib/migration/ports.ts';
import { capturedPresenter } from '../session/controller-doubles.ts';
import { sessionView } from '../session/session-fixtures.ts';

interface MigrationCall {
  readonly id: string;
  readonly agent: string;
  readonly model?: string;
  readonly allowContextDowngrade?: boolean;
  readonly requestId?: string;
}

class RecordingMigrationGateway implements IMigrationGateway {
  readonly calls: MigrationCall[] = [];

  constructor(
    private readonly response: SessionView = sessionView({
      agent: 'codex-secondary',
      model: 'gpt-5.6-sol',
      runtimeGeneration: 2,
    }),
  ) {}

  migrate(
    id: string,
    agent: string,
    model?: string,
    allowContextDowngrade?: boolean,
    requestId?: string,
  ): Promise<SessionView> {
    this.calls.push({
      id,
      agent,
      ...(model === undefined ? {} : { model }),
      ...(allowContextDowngrade === undefined ? {} : { allowContextDowngrade }),
      ...(requestId === undefined ? {} : { requestId }),
    });
    return Promise.resolve(this.response);
  }
}

export function migrationHarness(gateway = new RecordingMigrationGateway()) {
  const { io, presenter } = capturedPresenter();
  return { gateway, io, presenter };
}
