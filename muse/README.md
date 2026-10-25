# Muse / Tomagochi module for LOST

The module hosts the preserved Muse Linux SDK on macOS, including Intel Monterey/Python 3.9. It reuses the already paired gadget; Bluetooth and the Pi are not needed at runtime.

This is the transport/runtime foundation. No avatar, voice UI or animated pet is implemented yet. The SDK is pinned to upstream c9354b7a765cfb7dd3c4f1945a9ca838d871630c; see vendor/UPSTREAM.txt. See vendor/LICENSE and https://github.com/facebookincubator/muse-gadget-sdk. Current LinkSession includes send_voice, subscribe_chat and stream_tts; these APIs still need a macOS microphone/player/UI adapter and live voice verification.

Private state is outside the checkout: ~/Library/Application Support/LOST Muse/state/{identity.json,pairing.json,sdk_token}; owner-only files. The recovery originals are separate and never edited by the runtime. Do not run the same identity on two hosts. Stop the previous runtime before moving the latest state; refreshed credentials must travel together.

Install with muse/install.sh (LOST_MUSE_PYTHON selects Python). Optional LOST_MUSE_WHEELS selects a local wheelhouse for an offline Intel install. Dependencies are pinned in requirements.txt. Never put credentials under this public source directory.

LOST owns one Python child when the module is enabled. Hidden menu: МОДУЛИ → mUse → ВКЛЮЧИТЬ / ВЫКЛЮЧИТЬ / СОСТОЯНИЕ. Desired state is saved alongside the independent timer slots. The existing LOST LaunchAgent restores the module after login; no separate Muse LaunchAgent is installed. Disable waits for termination; exit stops the child; a parent-PID watchdog stops orphan children after a core crash. A lock prevents duplicate runtimes. Network losses retry through the SDK; process crashes retry through LOST. Revocation preserves credentials and stops automatic reconnection. Missing or invalid identity never creates a new gadget.

Only an acknowledged `registered with the Muse` sets ready. Starting, connecting, reconnecting, unavailable, error and revoked remain distinct. The logs and status file are under the private Muse home. Shell/file commands are the preserved SDK capabilities and execute as the signed-in macOS user, without adding sudo or changing accounts.

Network for this bring-up: router VPN, explicitly left enabled by the owner on 2026-10-25. This does NOT implement or prove the planned isolated US SSH/SOCKS route. HTTPS, token refresh and WSS currently use the router route. Do not claim fail-closed or per-process isolation until that transport is implemented and tested. No global route, macOS proxy or Tailscale settings are changed by this module.

Validation: node --test cast-app/test/*.test.cjs muse/supervisor.test.cjs. The local workstation Preview can exercise the real module with the private working state; stop it before handing that state to the mini. `muse/install.sh` alone never starts or pairs a device.
