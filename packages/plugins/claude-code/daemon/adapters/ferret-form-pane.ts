import type {
  FerretId,
  FerretsApi,
  FormKey,
  HarnessDeliveryFailure,
  HarnessRefusal,
} from '@ferretry/core-ferrets/contract';
import { ApiError, REFUSAL_SENTENCES } from '@ferretry/kernel/contract';
import type { FerretPane } from '../lib/permission/service.ts';

/**
 * The ferret has no live terminal to read or press a key at. Named `PaneUnknown` because that is the name the answer
 * routes turn into `409 pane_unknown`.
 */
class PaneUnknown extends Error {
  constructor(readonly ferret: string) {
    super(`ferret ${ferret} has no live terminal to read or answer, so nothing was read or sent`);
    this.name = 'PaneUnknown';
  }
}

const PLUGIN_OFF = "the runner that owns this ferret's terminal is off";

/** A refusal of the form seam, as the answer routes give it: a closed code with its fixed sentence. */
function refused(ferret: string, failure: HarnessRefusal | HarnessDeliveryFailure): never {
  if ('unconfirmed' in failure)
    throw new ApiError(409, 'the key may not have reached the terminal', 'console_input_failed');
  switch (failure.refused) {
    case 'no_pane':
      throw new PaneUnknown(ferret);
    case 'not_ready':
      throw new PaneUnknown(ferret);
    case 'plugin_unavailable':
      throw new ApiError(503, PLUGIN_OFF, 'plugin_unavailable');
    case 'composer_occupied':
    case 'composer_unreadable':
      throw new ApiError(409, 'the terminal could not take the key', 'console_input_failed');
    default:
      throw new ApiError(409, REFUSAL_SENTENCES[failure.refused], failure.refused);
  }
}

/**
 * A ferret's own pane, reached the one way every pane is: through Ferrets' harness seam (`FerretHarness.form`), which is
 * the ferret's RUNNER acting on the pane it owns. It works for either harness, for a ferret started before this daemon
 * did (Ferrets finds the pane from the ferret's own record, not from a handle this plugin was once handed), and with
 * Vault's input holds applied by the runner itself. This adapter names no tmux pane and guesses no session name.
 */
export class FerretFormPane implements FerretPane {
  constructor(private readonly ferrets: Pick<FerretsApi, 'harness'>) {}

  private async form(ferret: string) {
    if (this.ferrets.harness === undefined) throw new ApiError(503, PLUGIN_OFF, 'plugin_unavailable');
    const harness = await this.ferrets.harness(ferret as FerretId);
    if (harness === undefined) throw new ApiError(404, `no ferret ${ferret}`, 'not_found');
    if (harness.form === undefined) throw new ApiError(503, PLUGIN_OFF, 'plugin_unavailable');
    return harness.form;
  }

  async capture(ferretId: string): Promise<string> {
    const read = await (await this.form(ferretId)).capture();
    if (!read.ok) return refused(ferretId, read.error);
    if (read.value.dead || !read.value.alive) throw new PaneUnknown(ferretId);
    return read.value.visible;
  }

  async key(ferretId: string, key: FormKey): Promise<void> {
    const pressed = await (await this.form(ferretId)).key(key);
    if (!pressed.ok) refused(ferretId, pressed.error);
  }
}
