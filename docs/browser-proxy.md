# Browser user agent and proxy

Two things about how the machine's one agent browser (the Chrome the browser pane streams and the agents'
browser tools drive — see [browser-mode.md](browser-mode.md)) presents itself to the network.

## The user agent is the real browser's, honestly

A **headless** Chrome announces itself in its user agent: `…AppleWebKit/537.36 (KHTML, like Gecko)
HeadlessChrome/154.0.0.0 Safari/537.36`. That `HeadlessChrome` token is the **only** thing that differs from
the same Chrome with a window — its client hints (`Sec-CH-UA`) already say Google Chrome — and many sites
treat it as "a bot" and serve a block page.

What changes, exactly:

- A headless browser starts with one extra switch, `--user-agent=Mozilla/5.0 (<platform>) AppleWebKit/537.36
(KHTML, like Gecko) Chrome/<major>.0.0.0 Safari/537.36`.
- `<major>` is the installed Chrome's own version (what `chrome --version` prints), and `<platform>` is the
  platform token Chrome itself uses on this OS: `X11; Linux x86_64` / `X11; Linux aarch64`,
  `Macintosh; Intel Mac OS X 10_15_7` (the value Chrome has frozen at), or `Windows NT 10.0; Win64; x64`.
- If the version or the OS is not recognised, **no switch is passed** and the browser says whatever it says.
- A **Real window** browser is not headless and already sends the ordinary token, so nothing is passed.

What does NOT change: no other browser, device, OS or version is ever claimed, no client hint, screen,
WebGL, canvas, language or timezone value is touched, and no automation switch is hidden or added
([browser-mode.md](browser-mode.md) holds that line). The result is the string the same Chrome would send with
a window. It is not a disguise; a site that blocks automation on other evidence will still block it.

## Browser proxy

Set per machine, in `machine.yaml` or in the app under Settings › a machine › **Browser proxy**. Empty means
the browser goes direct (the default).

```yaml
browserProxy:
  url: socks5://proxy.example:1080 # http://, https:// or socks5:// — only scheme, host and port
  bypass: ['*.internal.example', '10.0.0.0/8', '<local>'] # optional: hosts that skip the proxy
  username: ${secret:PROXY_USER} # optional, both or neither
  password: ${secret:PROXY_PASSWORD}
```

- **The address never carries a user name or password.** `fy config check` and the app refuse
  `http://user:pass@host`. Credentials are `${secret:NAME}` references to the machine's secret store
  ([secrets.md](secrets.md): `fy secret set NAME`), so the value is in neither the file nor the app, and
  nothing here can read it back.
- **Applied at launch.** The browser reads the setting every time it starts, so a change applies the next
  time it starts; a browser already running keeps its network route until it stops (it stops after 15 idle
  minutes, or with `fy browser stop`).
- **A new or re-aimed proxy is held for the owner** ([config-files.md](config-files.md)): a writable proxy
  could aim a stored secret at somebody else's server, so setting one, or changing its address or secrets,
  waits for approval. Turning it off, or editing only the bypass list, applies at once.
- **Shown where you work.** A running browser that goes through a proxy carries a **via proxy** chip in the
  browser pane's status bar; its tooltip names the address and whether it signs in, never a credential.
- **`fy config check` validates it**: a bad scheme, an address with a path or credentials, a malformed
  bypass entry, a lone username or password, or a value that is not a `${secret:NAME}` reference.

### What Chrome is told

`--proxy-server=<url>`, `--proxy-bypass-list=<entries joined by ;>` when there are any, and
`--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, so WebRTC cannot reach around the proxy and
reveal this machine's address.

### Credentials

Chrome's `--proxy-server` has no place for a user name or password. When credentials are configured, the
daemon starts a **sign-in relay** on a loopback port (`127.0.0.1`, chosen by the OS) for the life of that
browser, points Chrome at it as a plain HTTP proxy, and the relay reaches the real proxy, adding the
credentials: HTTP Basic (`Proxy-Authorization`) for an `http`/`https` proxy, and username/password
(RFC 1929) for `socks5`. With no credentials there is no relay and Chrome talks to the proxy directly.

It **fails closed**: if a named secret is not in the store the browser refuses to start, with one sentence
naming the secret and `fy secret set NAME`; it never falls back to direct, and a relay failure answers the
page with an error rather than a direct connection.

### Honest limits

- **Loopback is open to this machine.** Any other process on this host can connect to the relay's port while
  the browser runs and borrow the proxy's credentials. It listens on loopback only and is closed with the
  browser, but a host you do not trust with a proxy login is not made safe by it.
- **The sign-in window is not proxied.** The window you open to sign in to a site yourself
  (the VNC login window) is a separate browser and goes direct.
- **A proxy does not make a bot a person.** Datacenter proxy addresses are still recognised as datacenter
  addresses; use a proxy whose exit you trust to look the way you need.
- **A missing `machine.yaml`** is read as "no proxy": a machine that has never been set up goes direct. An
  invalid file is refused at edit time by `fy config check`.
- **One proxy per machine.** There is no per-site or per-agent routing beyond the bypass list.
