import { implementCli } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { desktopBrowserOpener } from './adapters/pair/browser-opener.ts';
import { QrCodeTerminal } from './adapters/pair/qr-terminal.ts';
import { ProcessTerminalSize } from './adapters/pair/screen.ts';
import { sweepPairingRedirectState } from './adapters/pairing-redirect-sweep.ts';
import { IntlLocalTime } from './adapters/passkey/local-time.ts';
import { deviceVerbs } from './lib/device/commands.ts';
import { DeviceController } from './lib/device/controller.ts';
import { ProtocolDeviceGateway } from './lib/device/gateway.ts';
import { pairVerb } from './lib/pair/commands.ts';
import { PairController } from './lib/pair/controller.ts';
import { ProtocolPairingGateway } from './lib/pair/gateway.ts';
import { passkeyVerbs } from './lib/passkey/commands.ts';
import { PasskeyController } from './lib/passkey/controller.ts';
import { ProtocolPasskeyGateway } from './lib/passkey/gateway.ts';
import { BINARY_NAME, ExitStatus, hostFacilities } from './shell.ts';

/**
 * Access's `fy` half (§2.3): `fy pair`, `fy device ls|grant|revoke`, `fy passkey window`. Today's composition root
 * (`cli/bin/program.ts`), narrowed to these verbs: the controllers, renderers, prompts and exit codes are today's;
 * the gateways call `ctx.client` with the manifest's route keys instead of the HTTP client and the admin token.
 *
 * Host facilities `CliContext` does not carry yet (a clock, a prompt, a progress line, `<FY_HOME>`, the binary
 * name) come from `shell.ts`, and the `--open` browser launcher, the redirect sweep, the QR encoder and the
 * terminal width from `adapters/`, as today. Each is a port the kernel's CLI context still has to offer.
 *
 * `fy daemon config` (`lib/grants`) is not wired: the manifest declares no such verb and its routes are Gate's.
 */
export default implementCli(manifest, {
  build(ctx) {
    const { client, io } = ctx;
    const state = ctx.ownState;
    const host = hostFacilities(io, ctx);
    const exit = new ExitStatus();
    const out = {
      success: (message: string) => io.out(`${message}\n`),
      error: (message: string) => io.err(`${message}\n`),
      setExitCode: (code: number) => exit.setExitCode(code),
    };

    // `fy pair`: one construction. The screen goes out uncoloured, a QR's only job being contrast.
    const pair = (): PairController => {
      const stateHome = host.stateHome();
      return new PairController({
        gateway: new ProtocolPairingGateway(client),
        screen: { write: text => io.out(`${text}\n`) },
        progress: host.progress,
        exit,
        clock: host.clock,
        qr: new QrCodeTerminal(),
        terminal: new ProcessTerminalSize(),
        browser: desktopBrowserOpener(stateHome, state),
        redirectSweeper: { sweep: async () => void (await sweepPairingRedirectState(state, host.clock.now())) },
        binaryName: BINARY_NAME,
      });
    };

    // `fy device …` reads and changes what each paired device may do; revoking asks unless `--yes`.
    const device = (): DeviceController =>
      new DeviceController({
        gateway: new ProtocolDeviceGateway(client),
        out,
        prompt: host.prompt,
        interactive: io.isTty,
        clientName: BINARY_NAME,
      });

    // The owner's passkey recovery verb, sent with the host's own credential: the one caller "at the machine".
    const passkey = (): PasskeyController =>
      new PasskeyController({
        gateway: new ProtocolPasskeyGateway(client),
        out,
        time: new IntlLocalTime(),
        binaryName: BINARY_NAME,
      });

    return {
      verbs: {
        pair: pairVerb(pair, io, exit),
        ...deviceVerbs(device, io, exit),
        ...passkeyVerbs(passkey, io, exit, BINARY_NAME),
      },
    };
  },
});
