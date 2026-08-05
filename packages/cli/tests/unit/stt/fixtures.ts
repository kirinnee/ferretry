import type { SttEnhancementRequest, SttEnhancementResult } from '@ferretry/protocol';
import type { ISttGateway, ISttOutput } from '../../../src/lib/stt/ports';

/** Captures what a controller printed. */
export class CapturingOutput implements ISttOutput {
  readonly lines: string[] = [];

  success(message: string): void {
    this.lines.push(message);
  }

  get text(): string {
    return this.lines.join('\n');
  }
}

export function enhancement(overrides: Partial<SttEnhancementResult> = {}): SttEnhancementResult {
  return {
    text: 'Never install at the repository root.',
    provider: 'groq',
    model: 'llama-3.3-70b',
    latencyMs: 320,
    ...overrides,
  };
}

/** A gateway answering from a fixed view and recording what was asked of it. */
export class RecordingSttGateway implements ISttGateway {
  readonly enhanced: SttEnhancementRequest[] = [];

  constructor(private readonly view: SttEnhancementResult = enhancement()) {}

  enhance(request: SttEnhancementRequest): Promise<SttEnhancementResult> {
    this.enhanced.push(request);
    return Promise.resolve(this.view);
  }
}
