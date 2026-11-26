import type { HarnessScreenReader, HarnessScreenReading, RunSpec } from '@ferretry/core-ferrets/contract';
import type { PaneState, TmuxCommandPort } from './contracts.ts';
import { TmuxController } from './controller.ts';
import { turnLookOf, type FrameDigest } from './turn-look.ts';

interface RegisteredScreen {
  readonly key?: string;
  readonly screenReader?: HarnessScreenReader;
}
export interface LaunchChain extends RegisteredScreen {
  readonly through: ReadonlySet<string>;
  readonly harness: string;
}
export function launchChainOf(spec: RunSpec): LaunchChain | undefined {
  const harness = spec.execChain?.at(-1) ?? spec.harness;
  return harness === undefined
    ? undefined
    : {
        through: new Set(spec.execChain?.slice(0, -1)),
        harness,
        key: spec.harness,
        screenReader: spec.screenReader,
      };
}
const UNKNOWN: HarnessScreenReading = { working: true, atPrompt: false, composer: null };

/** Identity is the registered launch key. Screen content can never select a reader or a legacy family. */
function readerFor(launch: RegisteredScreen | undefined): HarnessScreenReader | undefined {
  if (launch?.screenReader === undefined)
    return launch?.key === 'claude-code' || launch?.key === 'codex'
      ? undefined
      : { key: launch?.key ?? '', read: () => UNKNOWN };
  return launch.key === launch.screenReader.key ? launch.screenReader : { key: launch.key ?? '', read: () => UNKNOWN };
}

export function harnessController(port: TmuxCommandPort, launch: RegisteredScreen | undefined): TmuxController {
  return new TmuxController(port, undefined, readerFor(launch));
}

/** A turn look already holds a masked frame; the registered plugin reads that same frame. */
export function readHarnessPane(pane: PaneState, launch: RegisteredScreen | undefined): PaneState {
  const reader = readerFor(launch);
  if (reader === undefined) return pane;
  let screen: HarnessScreenReading;
  try {
    screen = reader.read(pane);
  } catch {
    screen = UNKNOWN;
  }
  return {
    ...pane,
    screen,
    promptReady: screen.atPrompt && (screen.composer?.text === '' || screen.composer?.placeholder === true),
  };
}

export function harnessTurnLook(pane: PaneState, digest: FrameDigest, launch: RegisteredScreen | undefined) {
  return turnLookOf(readHarnessPane(pane, launch), digest);
}
