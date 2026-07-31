import type { SttEnhancementResult, SttModelStatus, SttTranscript } from '@ferretry/protocol';
import { assertWithinLimits, contentTypeFor, encodingOf } from './audio.ts';
import type { IAudioFileReader, ISttGateway, ISttOutput } from './ports.ts';
import {
  renderEnhancement,
  renderInstallStatus,
  renderModelList,
  renderSttStatus,
  renderTranscript,
} from './render.ts';

/** How often `--wait` asks the daemon how the installation is going. */
export const INSTALL_POLL_INTERVAL_MS = 2_000;

/** Waiting for a download must not hang a terminal forever. */
export const INSTALL_WAIT_TIMEOUT_MS = 1_800_000;

/** Sleeping between polls, injected so a test does not spend real seconds. */
export interface IDelay {
  wait(milliseconds: number): Promise<void>;
}

/** Options every dictation command accepts. */
export interface SttCommandOptions {
  readonly json?: boolean;
}

/** Flags that shape an install. */
export interface SttInstallOptions extends SttCommandOptions {
  /** Poll until the model is ready or the install fails, instead of returning immediately. */
  readonly wait?: boolean;
}

/** Flags that shape a transcription. */
export interface SttTranscribeOptions extends SttCommandOptions {
  /** Also pass the transcript through the enhancement provider. */
  readonly enhance?: boolean;
  readonly model?: string;
  readonly term?: readonly string[];
  readonly context?: string;
}

/** Flags that shape an enhancement. */
export interface SttEnhanceOptions extends SttCommandOptions {
  readonly model?: string;
  readonly term?: readonly string[];
  readonly context?: string;
}

/**
 * Drives `fy stt …`.
 *
 * Dictation runs entirely on the host: the daemon owns the model and the decoder process, and this
 * group installs the model, reports whether it is usable, and sends clips through it.
 */
export class SttController {
  constructor(
    private readonly gateway: ISttGateway,
    private readonly out: ISttOutput,
    private readonly files: IAudioFileReader,
    private readonly delay: IDelay,
  ) {}

  async status(options: SttCommandOptions): Promise<void> {
    const status = await this.gateway.status();
    this.#report(status, options, () => renderSttStatus(status));
  }

  async models(options: SttCommandOptions): Promise<void> {
    const response = await this.gateway.models();
    this.#report(response, options, () => renderModelList(response));
  }

  /**
   * Starts an installation, optionally waiting it out.
   *
   * Without `--wait` this returns as soon as the daemon has accepted the request, which is what a
   * script wants; with it, the command only ends once the model is usable or the install has failed.
   */
  async install(modelId: string, options: SttInstallOptions): Promise<void> {
    const id = identifier(modelId);
    const started = await this.gateway.install(id);
    if (options.wait !== true) {
      this.#report(started, options, () => `${id}: ${renderInstallStatus(started.install)}`);
      return;
    }
    const settled = await this.#awaitInstall(id, started);
    if (settled.state === 'error') throw new Error(`${id} failed to install: ${settled.install.message}`);
    this.#report(settled, options, () => `${id}: ${renderInstallStatus(settled.install)}`);
  }

  /**
   * Transcribes one audio file.
   *
   * The file is read and checked locally first: a clip past the daemon's limit is refused with its
   * length named, rather than uploaded in full and rejected with a bare 413.
   */
  async transcribe(path: string, options: SttTranscribeOptions): Promise<void> {
    const encoding = encodingOf(path);
    const audio = await this.files.read(path);
    assertWithinLimits(path, encoding, audio.byteLength);
    const transcript = await this.gateway.transcribe(audio, contentTypeFor(encoding));
    if (transcript.text.trim() === '') this.out.warn(`${path}: the model heard nothing`);
    if (options.enhance !== true) {
      this.#report(transcript, options, () => renderTranscript(transcript));
      return;
    }
    const enhanced = await this.#enhance(transcript.text, options);
    this.#report({ ...transcript, enhanced } satisfies EnhancedTranscript, options, () => renderEnhancement(enhanced));
  }

  async enhance(words: readonly string[], options: SttEnhanceOptions): Promise<void> {
    const text = words.join(' ').trim();
    if (text === '') throw new Error('enhance needs the text to clean up');
    const result = await this.#enhance(text, options);
    this.#report(result, options, () => renderEnhancement(result));
  }

  /** One enhancement request, built from the flags both `transcribe --enhance` and `enhance` accept. */
  async #enhance(text: string, options: SttEnhanceOptions): Promise<SttEnhancementResult> {
    const model = trimmed(options.model);
    const userContext = trimmed(options.context);
    const dictionary = (options.term ?? []).map(term => term.trim()).filter(term => term !== '');
    return await this.gateway.enhance({
      text,
      provider: 'groq',
      ...(model === undefined ? {} : { model }),
      ...(userContext === undefined ? {} : { userContext }),
      ...(dictionary.length === 0 ? {} : { dictionary: dictionary.map(term => ({ term })) }),
    });
  }

  /** Polls until the model is usable, the install fails, or the wait budget runs out. */
  async #awaitInstall(modelId: string, initial: SttModelStatus): Promise<SttModelStatus> {
    let status = initial;
    for (let waited = 0; status.state === 'installing'; waited += INSTALL_POLL_INTERVAL_MS) {
      if (waited >= INSTALL_WAIT_TIMEOUT_MS) {
        throw new Error(
          `${modelId} is still installing after ${INSTALL_WAIT_TIMEOUT_MS / 1000}s — check back with status`,
        );
      }
      await this.delay.wait(INSTALL_POLL_INTERVAL_MS);
      status = await this.gateway.modelStatus(modelId);
    }
    return status;
  }

  #report(payload: unknown, options: SttCommandOptions, human: () => string): void {
    this.out.success(options.json === true ? JSON.stringify(payload, null, 2) : human());
  }
}

/** The `--json` shape of an enhanced transcription: both texts, so neither is lost. */
type EnhancedTranscript = SttTranscript & { readonly enhanced: SttEnhancementResult };

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim() ?? '';
  return text === '' ? undefined : text;
}

function identifier(value: string): string {
  const id = value.trim();
  if (id === '') throw new Error('a model id is required');
  return id;
}
