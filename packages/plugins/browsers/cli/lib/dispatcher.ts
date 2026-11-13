import type { TerminalIo, VerbInvocation } from '@ferretry/kernel/manifest';
import { EXIT_USAGE, flag, parseVerb, UsageError } from './args.ts';
import type { BrowserClient, ToolAnswer } from './client.ts';
import { PrivateText } from './private-text.ts';
import type { Plan, VerbSpec } from './plan.ts';
import {
  renderBrowserAction,
  renderControlView,
  renderLoginStatus,
  renderProxyTest,
  renderToolAnswer,
  screenshotPayload,
} from './render.ts';

/** What a verb needs from the machine it runs on. Composition supplies the real ones; tests supply fakes. */
export interface DispatcherPorts {
  /** The ferret this runs inside (`FY_SESSION_ID`), when there is one. */
  readonly ownFerret?: string | undefined;
  /** Standard input, as text; asked only by `--stdin`. */
  readStdin(): Promise<string>;
  /** Writes picture bytes to a path the person chose; relative paths are the working directory's. */
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
}

const JSON_FLAG = { json: flag.on('json') } as const;

/** What a verb ended with: its words, the same as data for `--json`, and whether it counts as done. */
interface Outcome {
  readonly text: string;
  readonly data: unknown;
  readonly ok: boolean;
}

/**
 * THE ONE DISPATCHER for every `fy browser …` verb. A verb is a row of the table: its words, its scope and a pure
 * builder from words to a {@link Plan}. This reads the words (`parseVerb`: unknown options refused), builds the plan,
 * performs it through the one {@link BrowserClient}, and prints the answer — human words, or JSON with `--json` — and
 * every refusal as a sentence on stderr with an exit code: 0 done, 1 refused or not matched, 2 mistyped.
 *
 * Nothing here is per verb.
 */
export class BrowserDispatcher {
  constructor(
    private readonly table: Readonly<Record<string, VerbSpec>>,
    private readonly client: BrowserClient,
    private readonly io: TerminalIo,
    private readonly ports: DispatcherPorts,
  ) {}

  /** The handler the shell calls for a declared verb line. */
  handler(line: string): (invocation: VerbInvocation) => Promise<number> {
    return async invocation => await this.run(line, invocation);
  }

  async run(line: string, invocation: VerbInvocation): Promise<number> {
    // Whatever standard input gave a verb, and whatever a plan says was typed: none of it is ever printed back.
    const typed: string[] = [];
    let hidden = new PrivateText(typed);
    const readStdin = async (): Promise<string> => {
      const text = await this.ports.readStdin();
      typed.push(text.replace(/\r?\n$/u, ''));
      hidden = new PrivateText(typed);
      return text;
    };
    try {
      const spec = this.table[line];
      if (spec === undefined) throw new UsageError(`${line} is not a browser verb`);
      const shape =
        spec.scope === 'local' ? spec.shape : { ...spec.shape, flags: { ...spec.shape.flags, ...JSON_FLAG } };
      const words = parseVerb(line, shape, invocation);
      const plan = await spec.plan(words, { readStdin });
      if ('scrub' in plan && plan.scrub !== undefined) {
        typed.push(...plan.scrub);
        hidden = new PrivateText(typed);
      }
      const ferret = this.ferretOf(line, spec, words.text('ferret'));
      const outcome = await this.perform(plan, ferret);
      const text = hidden.sealed(
        words.on('json') ? JSON.stringify(hidden.cleanData(outcome.data)) : hidden.clean(outcome.text),
      );
      if (outcome.ok) this.io.out(`${text}\n`);
      else this.io.err(`${text}\n`);
      return outcome.ok ? 0 : 1;
    } catch (error) {
      const message = hidden.sealed(hidden.clean(error instanceof Error ? error.message : String(error)));
      this.io.err(`${message}\n`);
      return error instanceof UsageError ? EXIT_USAGE : 1;
    }
  }

  /** Whose pages: the ferret a person names, the one this runs inside, or none (the machine's, or this host's). */
  private ferretOf(line: string, spec: VerbSpec, named: string | undefined): string | undefined {
    const ferret = named?.trim() === '' ? undefined : named?.trim();
    switch (spec.scope) {
      case 'page':
        return ferret;
      case 'whole': {
        const own = this.ports.ownFerret?.trim();
        const chosen = ferret ?? (own === undefined || own === '' ? undefined : own);
        if (chosen === undefined) throw new UsageError('no ferret id; run inside a ferret or pass --ferret <id>');
        return chosen;
      }
      case 'person':
        if (ferret === undefined)
          throw new UsageError(
            `${line} is a person’s action on a ferret: pass --ferret <id> (a ferret cannot take a page over from itself)`,
          );
        return ferret;
      case 'machine':
      case 'local':
        return undefined;
    }
  }

  private async perform(plan: Plan, ferret: string | undefined): Promise<Outcome> {
    switch (plan.kind) {
      case 'tool': {
        const answer = await this.client.tool(plan.tool, plan.input, ferret);
        return await this.fromTool(answer, plan.screenshotTo);
      }
      case 'wait': {
        const answer = await this.client.wait(plan.input, plan.totalMs, ferret);
        return { ...toolOutcome(answer), ok: !answer.isError && answer.matched !== false };
      }
      case 'control': {
        const view = await this.client.control(plan.action, plan.key, ferret as string);
        return { text: renderControlView(view), data: view, ok: true };
      }
      case 'view': {
        const view = await this.client.view(ferret as string);
        return { text: renderControlView(view), data: view, ok: true };
      }
      case 'whole': {
        const result = await this.client.browser(ferret as string, plan.body);
        if (plan.shows === 'screenshot' && plan.screenshotTo !== undefined) {
          await this.ports.writeFile(plan.screenshotTo, Buffer.from(screenshotPayload(result), 'base64'));
          const text = `screenshot written to ${plan.screenshotTo}`;
          return { text, data: { screenshot: plan.screenshotTo }, ok: true };
        }
        const text = renderBrowserAction(result, plan.shows === 'text');
        return { text, data: stripPicture(result), ok: true };
      }
      case 'login': {
        const status = await this.client.login(plan.body);
        return { text: renderLoginStatus(status), data: status, ok: true };
      }
      case 'proxy-test': {
        // A proxy that does not work is an answer, not a crash: one line, exit 1, no stack.
        const result = await this.client.proxyTest(plan.proxy);
        return { text: renderProxyTest(result), data: result, ok: result.reachable };
      }
      case 'print':
        return { text: plan.text, data: { text: plan.text }, ok: true };
      case 'refuse':
        return { text: plan.message, data: { error: plan.message }, ok: false };
    }
  }

  private async fromTool(answer: ToolAnswer, screenshotTo: string | undefined): Promise<Outcome> {
    const outcome = toolOutcome(answer);
    if (!outcome.ok || screenshotTo === undefined) return outcome;
    if (answer.picture === undefined)
      return { text: `${answer.text}\nthe daemon returned no screenshot bytes`, data: outcome.data, ok: false };
    await this.ports.writeFile(screenshotTo, Buffer.from(answer.picture.base64, 'base64'));
    const text = `${answer.text}\nscreenshot written to ${screenshotTo}`;
    return { text, data: { ...(outcome.data as object), screenshot: screenshotTo }, ok: true };
  }
}

/** A tool's answer as an outcome; the picture's bytes never go to a screen or into `--json`. */
function toolOutcome(answer: ToolAnswer): Outcome {
  return {
    text: renderToolAnswer(answer),
    data: {
      text: answer.text,
      ...(answer.surfaces.length === 0 ? {} : { surfaces: answer.surfaces }),
      ...(answer.matched === undefined ? {} : { matched: answer.matched }),
    },
    ok: !answer.isError,
  };
}

/** A whole-browser answer as data, without the screenshot's bytes. */
function stripPicture(result: unknown): unknown {
  const body = result as { result?: Record<string, unknown> };
  if (body.result === undefined || !('screenshotBase64' in body.result)) return result;
  const { screenshotBase64: _bytes, ...rest } = body.result;
  return { ...body, result: rest };
}
