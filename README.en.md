# Chat in Harness

> 中文版见 [README.md](README.md)

A floating window for `chat.deepseek.com` inside DeepSeek Harness Desktop — independent of any conversation.

It takes a browser lease from DSH, creates a `<webview>`, and navigates it to the official page. Everything that happens inside — login, PoW, streaming, uploads, fingerprinting — is the site's own code running as usual.

## What it does not do

This section matters more than the one above.

| Not | Why |
|---|---|
| No API calls | Never touches `/api/v0/*`, builds no requests, parses no responses |
| No credential storage | Never reads cookies or localStorage, no snapshots, no login replay |
| No script injection | Never injects or executes anything inside the page |
| No fingerprint spoofing | Only strips `Electron/x.y.z` from the UA, everything else untouched |
| No bulk operations | No concurrency, no queues, no retry storms |

The UA change exists because the site otherwise flags the Electron container as an abnormal environment. It is the only exception in the whole plugin.

## Features

- Two-row header: title (whale + Chat / zoom / opacity / maximize / hide) and navigation (back / forward / reload / address / open in browser)
- Drag, resize, remember position; double-click the title bar or use the button to maximize/restore; edge snapping
- `×` hides the window: collapses into the floating ball when enabled, otherwise disappears
- Chat capsule in the sidebar footer; settings page with two toggles (sidebar entry, floating ball), a status card (size / zoom / opacity) and a reset button
- UI language follows DSH: Chinese when the app is Chinese, English otherwise

## Install

```powershell
dsh plugin --profile desktop add https://github.com/qcann/dsh-chat-in-harness
```

Or from a release tarball:

```powershell
dsh plugin --profile desktop add https://github.com/qcann/dsh-chat-in-harness/releases/download/v1.0.0/dsh-chat-in-harness-1.0.0.tgz
```

Restart DSH afterwards. Requires DSH ≥ 0.2.1-rc.1 and Node ≥ 20.

## Known limits

- **Desktop only.** The web build has no `<webview>` host.
- **Restarting DSH requires logging in again.** The browser lease is an in-memory partition, so cookies are not persisted. That is DSH's behavior; this plugin does not work around it.
- **DSH shortcuts do not work while the page has focus.** Keystrokes go to the guest.
- **Layering.** The window sits at `z-index: 60`: menus (100) and modals (1000) cover it. It shares a layer with DSH's own floating panel and paints above it by DOM order.
- **Link allowlist.** Only `deepseek.com` and its subdomains stay inside the guest; everything else opens in the system browser.
- **In-page "Copy" buttons do not work.** DSH denies clipboard permissions to browser guests, so `navigator.clipboard` is blocked. Selecting text and pressing `Ctrl+C` works — that uses the native copy path.

## Risk notice

- Unofficial project. Not affiliated with DeepSeek. The icon is an original drawing, not the official mark.
- No proxying, no forwarding, no data storage. Whether accessing the site through a third-party container complies with its terms is your call.
- Use at your own risk: rate limits, site changes and DSH upgrades can all break it.

## Philosophy: restraint

Ten things are possible; do three. Every feature answers "what breaks without it"; nothing sits between the user and the site; errors appear where the user can see them; delete before adding.
