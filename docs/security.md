# How Ferretry keeps your machines safe

This page explains Ferretry's security model in plain words: what protects you, what each layer
stops, what to do when something goes wrong, and what is **not** protected. It describes what is
built on `main` today.

The detailed contracts live elsewhere. This page links to them and does not replace them:
[zero-trust design](design/zero-trust.md) · [pairing](pairing.md) · [grants](grants.md) ·
[relay protocol](relay-protocol.md) · [signed releases](pwa-release-signing.md) ·
[secrets](secrets.md) · [audit log](audit.md) · [one hacked machine, path by path](cross-daemon.md).

## The short version

- **Your phone holds a key that can't be copied.** No password or token is stored or sent anywhere.
- **Every connection is encrypted end to end**, between the app and your machine. The relay in the
  middle can't read it.
- **You unlock each machine once with your passkey** (Face ID, Touch ID or a PIN). Until you do, the
  machine refuses everything. After it, you have full access for **8 hours** by default.
- **Adding a device always asks for your passkey again**, even while unlocked.
- **Loosening any security setting only works at the machine**, with the `fy` command.
- **Each machine is separate.** A hacked machine can't sign in to your other machines.
- **The real weak spots** are a hacked computer, code running inside the app while a machine is
  unlocked, and a hacked web deploy the first time you open the app. They are listed honestly
  [below](#what-this-does-not-protect).

## Words used on this page

| Word               | Meaning                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| **machine**        | A computer running the Ferretry daemon (`fyd`). It runs your agents.                                     |
| **daemon**         | The Ferretry background program on a machine.                                                            |
| **app**            | The Ferretry web app (PWA) in your browser or on your home screen.                                       |
| **device**         | One browser or phone that is paired with a machine.                                                      |
| **relay**          | A server that passes encrypted traffic between your phone and a machine that has no public address.      |
| **carrier**        | How the app reaches a machine: **direct** (straight to it) or **relay**.                                 |
| **passkey**        | A login key kept by your phone's or computer's password manager, unlocked with your face, finger or PIN. |
| **unlock**         | One passkey confirmation that opens one machine for this device, for a set number of hours.              |
| **step-up**        | A passkey confirmation for one action, on top of the unlock.                                             |
| **at the machine** | Using the `fy` command on the machine itself. Nothing else counts — not even a browser on that machine.  |

## The layers

Each row is one protection. Read across to see what it stops.

| Layer                              | What it is                                                                                                                                                                                                               | What it stops                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| **Device key**                     | When you pair, the app makes a key the browser **won't let anyone export**. The machine keeps only the public half. One key per machine. The key is replaced every **30 days**.                                          | A copied browser profile, backup or stolen storage can't sign in. A key never works on a different machine.  |
| **Mutual handshake**               | Every connection, direct or relayed, starts with both sides proving who they are. The machine proves it matches the fingerprint in the pairing QR code. Your device proves it holds its key.                             | Someone pretending to be your machine. A captured message can't be replayed in another connection.           |
| **Encrypted channel**              | After the handshake, everything is encrypted between the app and the machine.                                                                                                                                            | The relay, Cloudflare, or anyone on your Wi-Fi reading or changing your traffic.                             |
| **Access lease + silent renewal**  | A connection's permission lasts **15 minutes**. The device renews it quietly by signing a fresh challenge.                                                                                                               | A connection living on after you revoke the device. Each renewal re-checks that the device is still allowed. |
| **12-hour cap**                    | No single connection lasts longer than **12 hours**. Then it opens a new one with a fresh proof.                                                                                                                         | One long-lived connection that never proves itself again.                                                    |
| **Passkey unlock**                 | Before you unlock, the machine answers **every** request with "unlock first". One passkey confirmation unlocks it for this device for **8 hours** (you can set 1 hour to 7 days). The **machine** checks the passkey.    | A stolen phone, a copied key or a stranger's device doing anything at all without your face, finger or PIN.  |
| **Fresh passkey to add a device**  | Making a pairing code, or giving another device more access, asks for your passkey **for that one act**, even inside an unlock. One confirmation adds one device.                                                        | A thief with your unlocked phone pairing a device of their own, or handing one more access.                  |
| **Per-device access**              | Each device has its own permissions. A new device gets full access behind its unlock. `fy pair --limited` makes one that can only read and chat. Any device can be narrowed later.                                       | A device doing more than you meant it to. No device can give another more than it has itself.                |
| **"At the machine" = only `fy`**   | Only the `fy` command on the machine skips the rules. It proves itself with a token file that only someone on the machine can read. A browser on the machine is an ordinary device.                                      | A tunnel or proxy to the machine (`ssh -L`, `cloudflared`, `tailscale serve`) being mistaken for you.        |
| **Settings only tighten remotely** | From any device you can make security stricter. Making it looser (a longer unlock, a switch turned off) only works at the machine: `fy daemon security set`.                                                             | A thief or a hacked app quietly weakening your settings.                                                     |
| **Idle expiry**                    | A device that **nobody used for 30 days** is removed and must pair again. "Used" means a real person touched it. An open tab doesn't count.                                                                              | A forgotten laptop or old phone keeping access forever.                                                      |
| **Instant revoke**                 | Removing a device closes every connection it has and ends its unlock, at once.                                                                                                                                           | A lost device staying connected.                                                                             |
| **Pairing limits**                 | A pairing code lasts **2 minutes** and works **once**. It is only sent after the machine has proved itself. A machine pairs at most **32 devices**, and at most **10 new devices an hour** on each carrier.              | Guessing or reusing a code. A flood of new devices through the relay.                                        |
| **Audit log + alerts**             | The machine keeps a log of who paired, what changed, terminals, secrets used and agents started. Names and ids only — never codes, keys or secret values. Your other devices are told when a device or passkey is added. | A new device sneaking in unnoticed. Not knowing what happened after the fact.                                |
| **Signed app releases**            | Every app release is signed. The installed app checks the signature before it updates.                                                                                                                                   | A hacked web deploy silently replacing an app you already installed.                                         |
| **Relay sees nothing inside**      | The relay only passes sealed messages. It sees addresses, timing and sizes — not content.                                                                                                                                | The relay operator reading chats, keystrokes, codes or keys.                                                 |
| **Secrets are used, never read**   | An agent names a secret. Ferretry runs a command with the value in that command only. No screen or API ever shows the value.                                                                                             | An agent or a device ever holding your credentials. See [secrets](secrets.md) for its limits.                |

### The unlock, and the trade-off it makes

The owner chose friendliness here: **"once we unlock the app with a passkey, feel free to do anything
(including start sessions)".**

- **Before the unlock:** the machine refuses everything except the few requests needed to unlock or
  add your first passkey.
- **After the unlock:** this device can do anything its permissions allow — terminals, files, secrets,
  settings, starting agents — with **no more prompts**, for the unlock period. It lasts across page
  loads and tabs on this device, and through a daemon restart or update. A revoke or the period ending
  locks it again.
- **Except adding access.** Pairing a new device, or giving a device more, always asks for a fresh
  passkey for that act.
- **Want more prompts?** In Settings › ‹machine› › Machine › Security, turn on **ask again for each
  change**. Then terminals, file writes, secrets, fleet changes, permission changes, removing devices,
  browser control and warden changes each ask again, for a window you choose (0 means every time).

**The cost, said plainly:** while a machine is unlocked, anyone holding your unlocked phone — or any
code running in the app — can do everything you could, on that machine, until the unlock ends. They
still can't add a device. Shorten the unlock, turn on "ask again for each change", or revoke the
device.

### Security settings

One **Security** section per machine, in the app (Settings › ‹machine› › Machine › Security) or at the machine
(`fy daemon security`).

| Setting                      | Default | Range                 |
| ---------------------------- | ------- | --------------------- |
| Unlock on open               | on      | on / off              |
| Unlock lasts                 | 8 hours | 1 hour – 7 days       |
| Ask again for each change    | off     | on / off              |
| Each confirmation lasts      | 15 min  | 0–60 (0 = always ask) |
| Replace the device key every | 30 days | 7–90 days             |
| Remove devices unused for    | 30 days | 1–90 days             |
| Connection lease             | 15 min  | fixed                 |

- **Tightening** (shorter times, a switch turned on) works from any unlocked device that may manage pairing.
- **Loosening** works **only at the machine**: `fy daemon security set <setting> <value>`. The app
  tells you the exact command.
- **One exception — a longer unlock.** You can raise "Unlock lasts" (up to 7 days) from a paired device.
  The app asks for your passkey for that one change, then applies it at once and logs it.
- **A damaged settings file fails safe**: unlock on for 1 hour, ask every time, rotate keys weekly.
- Every change is written to the audit log.

## Threats, and what happens

| If…                                                                                     | What the attacker can do                                                                                                                                               | What they can't do                                                                                                                       |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Your phone is stolen, and it's locked**                                               | Nothing.                                                                                                                                                               | Use the app's key — it only works in the unlocked browser.                                                                               |
| **Your phone is stolen, unlocked, but no machine is unlocked**                          | Nothing on your machines. Every request is refused until someone unlocks with your passkey.                                                                            | Unlock without your face, finger or PIN.                                                                                                 |
| **Your phone is stolen, unlocked, and a machine is unlocked**                           | **Everything you could do on that machine** until the unlock ends: terminals, secrets, starting agents.                                                                | Pair a device of their own or give one more access (fresh passkey). Loosen settings (only `fy`). Outlast a revoke.                       |
| **Someone copies your browser storage or a backup**                                     | Nothing.                                                                                                                                                               | Sign in. The device key can't be exported, so a copy is useless.                                                                         |
| **The relay or Cloudflare is hacked**                                                   | See when you connect, from which IP, for how long, and message sizes and timing (keystroke rhythm on a terminal). Drop or delay traffic.                               | Read or change anything you send. Pretend to be your machine. Learn your device id, codes or keys.                                       |
| **The app's web deploy is poisoned**                                                    | If you have **never installed** the app, or the deploy ships a **new service worker**, run its own code in the app — with full access on any machine that is unlocked. | Silently replace an app you already installed with different files: the signed release check refuses it. Add a device without a passkey. |
| **A malicious website**                                                                 | Nothing special. It is a different site.                                                                                                                               | Read the app's keys or storage. Embed the app (it refuses to be framed). Use your passkey (passkeys are tied to the app's address).      |
| **A local tunnel or proxy to the machine** (`ssh -L`, `cloudflared`, `tailscale serve`) | Reach the machine as an ordinary **device**: it must pair and unlock like any device.                                                                                  | Count as "at the machine". Only the `fy` token file does that.                                                                           |
| **One of your machines is hacked**                                                      | See [below](#if-one-machine-is-hacked).                                                                                                                                | See below.                                                                                                                               |
| **You lose your passkey**                                                               | Nothing — this is a lockout, not an attack.                                                                                                                            | —                                                                                                                                        |

### If one machine is hacked

Say machine **A** is taken over, and you also use machines **B** and **C** from the same phone. The
full path-by-path check is [cross-daemon.md](cross-daemon.md).

**A hacked machine CAN:**

- Do anything on **itself**: read its sessions, run commands, read its own secrets.
- See whatever **you send to it**: chats, files, and any setup you clone **into** it. The Clone
  screen warns you about this.
- **Lie to you** about its own content: fake transcripts, fake names, fake messages.
- **Offer commands to B if you clone from A to B.** Clone copies hooks, MCP servers and settings,
  which run on B. The Clone preview lists every command, setting and script in full, and you can leave
  any component out. B still asks for its own passkey before it copies. **Read that list, and don't
  clone from a machine you don't trust.**
- **Write any words in its own notifications** — but every notification starts with your name for
  the machine it came from.

**A hacked machine CANNOT:**

- **Sign in to B or C as your phone.** Each machine has its own device key on your phone, and every
  proof is tied to one connection with one machine.
- **Use your passkey or your unlock on B or C.** B's passkey challenge only travels inside your
  encrypted connection with B, and B only accepts it from your B device key.
- **Copy any key off your phone.** Keys can't be exported.
- **Change your phone's record or key for B.** Each is stored under B's own fingerprint, which A
  can't fake.
- **Read your B or C traffic on the relay.** It's encrypted end to end.
- **Send notifications as B, or hide B's.** Each machine has its own notification subscription on
  your phone, and a tap on A's notification only opens A's pages.
- **Write files outside B's setup folder through Clone.** Odd paths are refused before anything is
  planned.
- **Run code in the app** with the data it sends. The app blocks inline scripts, shows text as text,
  and runs drawings and HTML previews in locked-down frames. On Chrome and Edge, Trusted Types also make
  the browser refuse any markup the app's own highlighter didn't write. No path was found.

**Why the last point matters:** the app is one website for all your machines. If code ever did run
inside the app (a poisoned deploy, or a bug), it would have **full access on every machine you have
unlocked**, until each unlock ends — even after you close and reopen the page. It still can't copy the
keys or add a device.

## What to do when something goes wrong

### Lost or stolen phone

1. **Revoke the device.** At the machine: `fy device ls`, then `fy device revoke <device>`. Or from
   another device: Settings, open the machine and its **Machine** tab, then **Devices**, find the device and tap **Revoke**. This
   closes its connections, ends its unlock and forgets its passkeys, at once.
2. Do this on **every** machine that phone was paired with.
3. Check the audit log for what it did: Settings › ‹machine› › Machine › Security log, or `fy daemon audit` at the machine.
4. If it could have reached an unlocked machine, assume it could do anything there: check sessions,
   terminals and secrets used in the log, and rotate secrets if in doubt.

### A device you don't recognise was paired

1. Tap **Remove it** on the in-app notice, or run `fy device revoke <device>` at the machine.
2. Look at the audit log for when and over which carrier it was paired.
3. Ask who could have paired it: that needs `fy pair` at the machine, or a fresh passkey on a device
   you own.

### You lost your passkey

1. At the machine, run `fy passkey window <device>`. This re-opens that device's passkey sign-up for
   **10 minutes, for one passkey**.
2. On the device, open Settings › ‹machine› › Machine › Security and tap **Add a passkey**.

### One machine was hacked

1. **Stop using it from the app** and take it offline.
2. On your phone, **remove that machine** from the app (Settings, open the machine, its **Machine** tab › **Host checks**). This deletes its device
   key and its notification subscription from the phone.
3. **Don't clone from it.** If you already cloned from it, check the other machine's Components tab:
   everything it copied says **Copied from** it.
4. Rotate any secrets and accounts that machine held. Treat everything on it as exposed.
5. Rebuild it, install Ferretry fresh, and pair again.

### The app's signing key or deploy was compromised

Follow [If the key is compromised](pwa-release-signing.md#if-the-key-is-compromised). In short:
remove the secret, make a new key, deploy, then on each device clear the site's data and reinstall.
Until then, revoke devices or shorten the unlock on your machines: a poisoned app has full access on
any unlocked machine.

### The relay is misbehaving

Nothing to rotate: the relay never holds a key or code. Use the **direct** carrier if you can reach
the machine, or [run your own relay](cloudflare-relay-self-hosting.md).

## What this does not protect

Said plainly, because "zero trust" sounds like more than it is:

- **Anything inside an unlock.** While a machine is unlocked for a device, that device — and any code
  running in the app on it — has full access there, with no more prompts, until the unlock ends. Closing
  the page does **not** end it. Only adding a device still asks. This is the price of "unlock once".
- **A hacked machine.** Everything ends on the machine. Malware running as your user can read the
  daemon's state, its token file and its secrets.
- **Code running inside the app.** It can _use_ every machine's key (never copy it) and raise passkey
  prompts. **Only accept a passkey prompt you expected** — the prompt names the machine and the act.
- **A first passkey is not proven to be real hardware.** In a new device's first 10 minutes, code in
  the app could register a software passkey instead. Your other devices are told when a passkey is
  added.
- **The first time you open the app.** Your browser trusts whatever the site serves at that moment.
  A deploy that ships a new service worker can replace the checker; this is only sometimes detected.
- **Chatting with agents.** An agent that is allowed to use tools will run commands when asked. Access
  settings don't change what an agent will do.
- **Someone at the machine.** `fy` with the token file is never limited. Anyone at an unlocked keyboard
  has the machine.
- **The 30-day idle window.** A device used once a month never expires. Revoke devices you stopped
  using.
- **Relay metadata.** The relay sees your machine's fingerprint, IP addresses, timing and sizes.
- **Being cut off.** A relay or network can drop your traffic.
- **Device health.** Nothing checks your phone's OS version, screen lock or disk encryption.
- **Clone from a machine you don't trust.** The preview shows every command, but only you can decide
  to leave one out.

## Known gaps

| Gap                                                                                                       | Where it is declared               |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Code in the app has full access on every unlocked machine                                                 | [zero-trust](design/zero-trust.md) |
| A refusal before a route runs (no credential, switched-off grant, missing step-up) isn't in the audit log | [audit](audit.md)                  |
| A real authenticator's passkey ceremony is tested only with software authenticators                       | [zero-trust](design/zero-trust.md) |
| A clone made with `fy` (no browser) records the source only by the name it gave itself                    | [cross-daemon](cross-daemon.md)    |
| A machine chooses the words after its own name in its notifications                                       | [cross-daemon](cross-daemon.md)    |
