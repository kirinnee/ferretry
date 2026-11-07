# @ferretry/app — the app shell

The shell holds no feature (design §5): router, layout engine, slots, theme, the sealed session client, the generated
per-daemon client with its hash guard (§9.6), the daemon list, the reference grammar, and the seams below. Every view is
a plugin's app half, read from the generated surfaces registry (`src/generated/surfaces.ts`).

| Import                  | What                                                                          |
| ----------------------- | ----------------------------------------------------------------------------- |
| `@ferretry/app`         | the public API: connect interface, client types, layout, slots, theme, refs   |
| `@ferretry/app/ui`      | the shared UI kit (primitives, sheet, menu, tabs, picker, command bar, hooks) |
| `@ferretry/app/testing` | fakes for the connect interface                                               |

## Reaching a daemon: what Access and Connections provide

The shell holds no device key and chooses no carrier. Two plugin app halves provide them by attaching a `shell` section
to their default export:

```ts
import { provideToShell } from '@ferretry/app';

export default provideToShell(implementApp(manifest, { build }), {
  claims: ports => accessClaims(ports), // Access only: DeviceClaims
  carriers: ports => [direct(ports), relay(ports)], // Connections only: CarrierDialer[]
});
```

- **`DeviceClaims`** (Access): `claim(daemon)` answers the `device` session claim (the non-extractable key handle, from
  `ports.crypto.deviceKeyHandle`) or `undefined`; `pairingKey(daemonId)` answers the key a `pair` session registers;
  `forget(daemonId)` drops the key when the pairing is removed. `pairingKey` returns a memory-only key; persist it
  only inside its `save`, after validating the response.
- **`CarrierDialer`** (Connections): `{ id, order, dial(daemon) }`; the lowest `order` that answers a dial carries the
  session. With no carrier registered the shell dials the pairing's address directly.
- **`ConnectPorts`** is everything a provider may touch, bound once in `src/main.tsx`: the session crypto, WebCrypto,
  IndexedDB, the WebSocket opener, a timer, the clock, the daemon list, and `pairDirect` — which opens a `pair` session
  over the shell's own direct carrier, because pairing is never relayed.
- Only `access` may provide claims and only `connections` carriers (the kernel's `session.modes` / `carriers` takers);
  a skeleton half provides nothing. Neither provider ever gets a client or a transport: the bootstrap read is still the
  first call on every session, and the hash guard still sits in front of every call.
- Tests drive the shell with `fakeDeviceClaims` and `fakeCarrier` from `@ferretry/app/testing`.

## The shared UI kit

`@ferretry/app/ui` is today's PWA primitives and feature-free hooks, copied once so plugins import them instead of
re-copying: `Button`, `Badge`, `Card`, `BottomSheet`, `ContextMenu`, `SheetTabs`, `UnderlineTabs`, `PickerCombobox`,
`CommandBar`, `Spinner`, `useDialogFocus`, `useInputModality`, `useLayoutMode`, `cn`, the Trusted Types policies
(`trustedHighlight`, `trustedWorkerUrl`, `fragmentParsingPolicy`), and the rest. The stylesheet
(`src/ui/design-system.css`) and Tailwind are loaded once by the shell; `tailwind.config.ts` scans every plugin's
`app/` for utilities, so a plugin ships no CSS pipeline. A feature's own stylesheet comes with its app half.

## The service worker runs no plugin code

`sw.verified.js` (`src/worker/service-worker.ts`) is the signed-release check plus the shell's own push and
notification handling, copied from today's worker (`src/worker/notifications.ts`): a push is shown plainly, titled for
the machine whose registration received it, and a tap opens only this site's pages — only that machine's. **No plugin
code is compiled into it**: code evaluated in the worker's realm could rewrite the globals the release check serves
through before any event arrives. `scripts/build-release.ts` fails if any `packages/{core,plugins}/<id>/app/worker.ts`
exists. A plugin that needs worker behaviour asks for it as declarative data the worker interprets, through its own
contract — later; none does today.

## Layout

The owner's layout comes from the Layouts plugin (`GET /v1/layouts/current`, re-read on `layouts.changed`) through the
guarded `layouts` client, and applies on every device; this device's `--device` overrides (`fy:app:layout`, set from
the command bar) lie on top, field by field, with the Layouts daemon half's rules. With Layouts off the contract's
built-in default applies. The owner's theme tokens lie over this device's theme family.
