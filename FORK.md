# Fork ownership and upstream integration

This is [janbam/herdr-web](https://github.com/janbam/herdr-web), forked from [kcosr/herdr-web](https://github.com/kcosr/herdr-web). This ledger describes divergence in the tree containing this file, including changes not yet merged or released. [CHANGELOG.md](CHANGELOG.md) records release history; [README.md](README.md) documents usage.

Keep this ledger current whenever fork-owned behavior, dependencies, compatibility baselines, or merge hazards change. For each divergence, retain its rationale, source locations, invariants, and removal or integration conditions. Remove obsolete entries only after equivalent upstream behavior has been verified; do not accumulate a second chronological changelog.

## Integration reference

- Latest merged web-upstream release: `v0.6.2`, commit `3631731ace5234f1c0c599cc3bb87535bcc452ae`, which is now the shared ancestor with the inspected upstream.
- Web upstream inspected for this ledger: `92717f433b00881724b7f8bff328fb07d9fceab6`. Its post-release changelog-template reset is not part of the release merge; the fork retains its own Unreleased entries.
- Herdr itself is a separate upstream: the compatibility copy is based on Herdr `v0.9.5`, commit `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01`, terminal protocol `22`. Do not confuse a web-upstream merge with a Herdr vendor refresh.

## Fork-owned changes

### Owner-only Unix socket and SSH access

Introduced in [fork PR #1](https://github.com/janbam/herdr-web/pull/1), with deployment documentation in commit `d132180`.

- **Why:** loopback TCP is accessible to other local users; filesystem permissions provide the boundary needed for SSH-only access to this unauthenticated bridge.
- **Sources:** [bridge/src/web_bridge.rs](bridge/src/web_bridge.rs), [README SSH setup](README.md#ssh-only-access-via-unix-socket-fork-specific).
- **Preserve:** `--unix-socket PATH` replaces TCP entirely, is Unix-only, and rejects `--host`, `--port`, and `--allow-host`. The socket is `0600`; its parent must be private (`0700`) because chmod follows bind. Only a provably dead socket is reclaimed; live, inaccessible, and non-socket paths are left intact. Existing Host/Origin checks still apply through SSH forwarding.
- **Integration:** retain until upstream supplies an equivalent access boundary. Keep the installed-copy/systemd/SSH examples aligned with the listener; do not introduce a TCP listener into the socket-only setup.

### Device-pixel-aligned terminal metrics

Introduced in [fork PR #2](https://github.com/janbam/herdr-web/pull/2), commit `90e97a4`.

- **Why:** fractional display ratios produce hairline seams between per-cell background fills in pinned `ghostty-web` `0.4.0`.
- **Sources:** `FORK-OWNED` sections in [web/src/terminalRenderer.ts](web/src/terminalRenderer.ts), resize forwarding in [web/src/TerminalView.tsx](web/src/TerminalView.tsx), and [renderer regressions](web/src/terminalRenderer.test.ts).
- **Preserve:** round font metrics to device-pixel boundaries; remeasure and refit on device-pixel-ratio changes; forward resulting terminal dimensions to the bridge. This ports the font-metrics portion of ghostty-web PR #146, not its render-loop redesign. Keep the existing event-driven rendering behavior.
- **Removal:** after a dependency upgrade, verify equivalent metrics and display-ratio handling, then remove the superseded runtime overrides and watchers. An upstream PR's existence alone is not proof that the installed package includes the fix.

### Codeless Android terminal keys

Introduced in [fork PR #8](https://github.com/janbam/herdr-web/pull/8).

- **Why:** Firefox Android can receive special-key events with a correct `key` but an empty `code` from Unexpected-Keyboard, HeliBoard, and FlorisBoard. Pinned `ghostty-web` `0.4.0` otherwise drops these events, leaving the textarea's input deduplication suppressing the remaining Enter/Backspace/Delete path.
- **Sources:** `FORK-OWNED` keyboard normalization in [web/src/terminalRenderer.ts](web/src/terminalRenderer.ts) and real Ghostty/WASM input regressions in [web/src/terminalRenderer.test.ts](web/src/terminalRenderer.test.ts).
- **Preserve:** fill only missing codes for explicitly recognized non-numpad special keys through the existing custom-key hook. Keep composition and keyCode `229` guards, populated codes, printable input, modifiers, live application-cursor mode, and the original event's cancellation semantics. Delegate encoding to Ghostty except for the explicit custom chords documented below; do not add hardcoded arrow sequences or a second input path.
- **Removal:** after a dependency upgrade, verify equivalent codeless-key handling and single-emission behavior in Firefox Android before removing this normalization.

### Distinct Shift+Enter for agent editors

Introduced in [fork PR #9](https://github.com/janbam/herdr-web/pull/9).

- **Why:** pinned `ghostty-web` `0.4.0` encodes Shift+Enter as plain Enter, submitting prompts instead of inserting a newline in Pi, Codex, and Claude Code.
- **Sources:** the shared textarea/custom-key policy in [web/src/terminalRenderer.ts](web/src/terminalRenderer.ts), the on-screen shortcut encoder in [web/src/mobileTerminalControls.ts](web/src/mobileTerminalControls.ts), and their adjacent regression tests.
- **Preserve:** exact Shift+Enter sends CSI-u `ESC[13;2u` once from physical keyboards, soft keyboards, and the on-screen shortcut builder. Ordinary Enter and chords with additional modifiers retain existing behavior. Composition guards and keydown cancellation remain in place. This is a single-chord policy, not full Kitty keyboard protocol negotiation or foreground-app detection. Programs without CSI-u support need not treat it as a newline.
- **Removal:** remove only after equivalent distinct Shift+Enter encoding is verified for both direct terminal input and on-screen shortcuts. Do not replace it with LF, which loses chord identity and can submit shell commands.

### Firefox Android browser chrome and terminal swipes

Introduced in [fork PR #10](https://github.com/janbam/herdr-web/pull/10).

- **Why:** Firefox keeps its tabs and address bar expanded when the page has no native scroll range or the terminal cancels ordinary browser panning.
- **Sources:** the Firefox/coarse-pointer rules in [web/src/styles.css](web/src/styles.css), gesture arbitration and mouse-mode synchronization in [web/src/terminalRenderer.ts](web/src/terminalRenderer.ts), and [touch regressions](web/src/terminalRenderer.touch.test.ts).
- **Preserve:** keep the app fixed to `100dvh` while the document remains scrollable beyond `100lvh`; clip body overflow without introducing another scroll container. Ordinary terminal swipes still send remote scroll commands while allowing Firefox to animate its chrome. Use screen coordinates only for shared scrolling, retain client coordinates and cancellation for selection, and disable native panning before a mouse-reporting program receives a touch. Other engines and fine-pointer layouts retain their existing behavior.
- **Removal:** revisit only after real Firefox Android checks demonstrate equivalent toolbar collapse, terminal scroll distance, held-drag selection, and keyboard refitting without these adaptations.

### Herdr v0.9.5 compatibility baseline

Introduced in [fork PR #3](https://github.com/janbam/herdr-web/pull/3), commit `e86e0b1`.

- **Why:** keep the minimal private API/wire copy aligned with the reviewed Herdr release without vendoring the full application.
- **Sources:** [vendor/herdr-compat](vendor/herdr-compat/), [scripts/check-vendor.sh](scripts/check-vendor.sh), bridge schema fixtures, and [docs/vendoring.md](docs/vendoring.md).
- **Preserve:** Herdr runtime floor `v0.9.0`, exact terminal protocol `22`, pane-oriented ANSI attach, and narrow browser command exposure. Copied additive API fields are not authorization to expose new commands. Retain documented local socket/logging/rename/input adaptations and exact production-wire drift checks.
- **Current baseline:** the v0.9.5 refresh advances the source pin after verifying that the copied compatibility surface and terminal attach handlers are unchanged from v0.9.4. No vendored Rust changes are required.
- **Integration:** upstream web's v0.9.3 refresh was reconciled during the v0.6.2 merge by retaining the newer reviewed v0.9.4 copy, shims, and wire tests. Do not downgrade the pin or discard fork adaptations during later merges. Follow the vendoring guide for later refreshes.

### Background Web Push and portable crypto packaging

Introduced in [fork PR #4](https://github.com/janbam/herdr-web/pull/4), commits `8b97307` and `5f50657`.

- **Why:** deliver working → blocked/idle notifications to Firefox Android while the page is closed or suspended, including with an SSH-only bridge.
- **Sources:** [bridge/src/push_notifications.rs](bridge/src/push_notifications.rs) and [tests](bridge/src/push_notifications/tests.rs), routes/activity-watcher hooks in [web_bridge.rs](bridge/src/web_bridge.rs), [browser enrollment](web/src/pushNotifications.ts), [settings UI](web/src/PushNotificationSettings.tsx), [push worker](web/public/push-worker.js), [bridge dependencies](bridge/Cargo.toml), and [tarball packaging](scripts/package-tarball.sh). Setup and limitations live in [README](README.md#web-push-notifications-fork-specific) and [docs/packaging.md](docs/packaging.md).
- **Preserve:** opt-in per-browser/per-bridge preferences and test delivery; explicit `HERDR_WEB_PUSH_SUBJECT`; session-private, owner-only signing keys/subscriptions retained across upgrades. Browser enrollment requires HTTPS or device-local localhost; the Capacitor embedded browser is not supported. Synthetic worker scopes isolate bridge subscriptions without controlling app pages.
- **Transition policy:** only ordered events from one daemon subscription establish prior status. The first event seeds status without alerting; startup/reconnect snapshots are not catch-up notifications. Reset/reconcile tracking when streams or terminal identities change. An already-running agent can finish without an alert before an event baseline is established.
- **Security/delivery policy:** send only pane IDs and destination states, never titles, prompts, or terminal output. Preserve Host/Origin checks, bounded enrollment/request/queue/concurrency limits, Mozilla/Firebase HTTPS endpoint validation, no redirects or ambient proxies, and credential-free logs. Prune definitively expired subscriptions; retain them on transient failures. Delivery is best-effort, not a durable alert history.
- **Packaging:** encryption uses `ece`/OpenSSL, signing uses `p256`, and delivery uses `reqwest` with native TLS. Source builds require OpenSSL development libraries and `pkg-config`; desktop packaging explicitly selects static OpenSSL and refuses external `libssl`/`libcrypto` linkage. Preserve that portability guard when changing dependencies or build scripts.
- **Integration:** upstream v0.6.2 event recovery is integrated into the activity watcher. Successful subscriptions request browser resync while creating a fresh push tracker; stream errors are rejected before transition processing. Preserve rebaselining and the no-snapshot-transition policy during later changes. Replace this implementation only after equivalent enrollment isolation, privacy, background delivery, and packaging behavior are verified.

## Known upstream work not integrated

No functional web-upstream work through v0.6.2 remains unintegrated. [PR #95](https://github.com/kcosr/herdr-web/pull/95) event recovery, subscription regressions, and Android release metadata are merged. The historical [upstream compatibility report](docs/compatibility-v0.9.3.md) describes upstream's v0.9.3 validation, not this fork's newer baseline.

## Upstream merge checklist

1. Read this ledger before merging or resolving conflicts. Fetch and inspect `upstream/main`, record the merge base and target commit, and distinguish web-upstream changes from Herdr compatibility changes.
2. Map overlapping files to the ownership entries above. Reconcile behavior and invariants, not just conflict markers. Preserve fork changes unless reviewed upstream behavior supersedes them; ask before materially changing a security boundary or product behavior.
3. If compatibility files change, follow [docs/vendoring.md](docs/vendoring.md), including the exact drift check against the reviewed Herdr checkout. Keep the baseline, script pin, schema fixtures, and documentation consistent.
4. Run the repository check suite and targeted regressions for affected entries. Smoke-test SSH-only access, terminal display-ratio/refit behavior, and real background push when those paths change; verify release linkage when crypto or packaging changes. Report any platform checks not performed.
5. Update this file in the same change: advance integration references after an actual merge, reconcile pending upstream work, and amend or remove superseded divergence entries. Update usage docs and the changelog where their truth changes.
