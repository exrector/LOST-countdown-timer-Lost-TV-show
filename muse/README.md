# Muse / Tomagochi module for LOST

The module hosts the preserved Muse Linux SDK on macOS, including Intel Monterey/Python 3.9. It reuses the already paired gadget; Bluetooth and the Pi are not needed at runtime.

The terminal AI UI supports PF3/AI+Enter activation, text streaming, and native hold-to-talk with RESET inside AI. An animated avatar and spoken replies are not implemented. Russian WAV input with a real text response was verified; actual KT USB capture awaits the user’s first recording/permission test. The SDK is pinned to upstream c9354b7a765cfb7dd3c4f1945a9ca838d871630c; see vendor/UPSTREAM.txt. See vendor/LICENSE and https://github.com/facebookincubator/muse-gadget-sdk. Current LinkSession includes send_voice, subscribe_chat and stream_tts; these APIs still need a macOS microphone/player/UI adapter and live voice verification.

Private state is outside the checkout: ~/Library/Application Support/LOST Muse/state/{identity.json,pairing.json,sdk_token}; owner-only files. The recovery originals are separate and never edited by the runtime. Do not run the same identity on two hosts. Stop the previous runtime before moving the latest state; refreshed credentials must travel together.

Install with muse/install.sh (LOST_MUSE_PYTHON selects Python). Optional LOST_MUSE_WHEELS selects a local wheelhouse for an offline Intel install. Dependencies are pinned in requirements.txt. Never put credentials under this public source directory.

LOST owns one Python child when the module is enabled. Hidden menu: МОДУЛИ → mUse → ВКЛЮЧИТЬ / ВЫКЛЮЧИТЬ / СОСТОЯНИЕ. Desired state is saved alongside the independent timer slots. The existing LOST LaunchAgent restores the module after login; no separate Muse LaunchAgent is installed. Disable waits for termination; exit stops the child; a parent-PID watchdog stops orphan children after a core crash. A lock prevents duplicate runtimes. Network losses retry through the SDK; process crashes retry through LOST. Revocation preserves credentials and stops automatic reconnection. Missing or invalid identity never creates a new gadget.

Only an acknowledged `registered with the Muse` sets ready. Starting, connecting, reconnecting, unavailable, error and revoked remain distinct. The logs and status file are under the private Muse home. Shell/file commands are the preserved SDK capabilities and execute as the signed-in macOS user, without adding sudo or changing accounts.

Network for this bring-up: router VPN, explicitly left enabled by the owner on 2026-10-25. This does NOT implement or prove the planned isolated US SSH/SOCKS route. HTTPS, token refresh and WSS currently use the router route. Do not claim fail-closed or per-process isolation until that transport is implemented and tested. No global route, macOS proxy or Tailscale settings are changed by this module.

Validation: node --test cast-app/test/*.test.cjs muse/supervisor.test.cjs. The local workstation Preview can exercise the real module with the private working state; stop it before handing that state to the mini. `muse/install.sh` alone never starts or pairs a device.

Side-chat IDs must be stable UUIDs for the real server; arbitrary readable names passed mocks but were rejected live. The runtime uses UUIDv5 derived from the existing gadget identity. Native microphone access is requested only on explicit RESET capture, never at startup. Capture uses AVAudioRecorder input only; timer output audio is unchanged.

### macOS permission policy diagnosis (2026-10-25)

The GUI uses LaunchServices and a tokenized lease so TCC identifies LOST itself. The explicit `authorize` operation requests consent without recording; opening AI can invoke it independently from hold-to-talk. On this inspected mini, disabled AMFI (`amfi=0x80`) still causes a system-level prompt-policy denial. Restoring AMFI/reboot was authorized by the owner but remains pending administrator authentication. Do not claim microphone consent was granted or bypass TCC silently.

## 2026-10-25 — полный аудит официального SDK

Проверенная карта установленной версии, голоса/transcript/TTS, всех команд Python и ESP32, визуализации и видео: [SDK-CAPABILITIES-2026-10-25.md](SDK-CAPABILITIES-2026-10-25.md). Она уточняет прежние предварительные утверждения: Python stream_tts существует, voice-modality на аккаунте не проверена; message.user даёт путь к transcript; display.set_caption не является стандартной advertised командой этой версии.

## 2026-10-26 — диалог в исходном терминале и Enter для голоса

- AI использует существующие console-container, >: и my-console. Отдельная панель, заголовок, кнопки и рамка удалены; история диалога и серые подсказки находятся в исходном терминале. Закрытие возвращает блокировку обычного числового ввода, окно кода имеет приоритет.
- RESET удерживается только для записи. Отпускание завершает WAV в локальном черновике в памяти, без POST; Enter вызывает отдельный нативный send. RESET перезаписывает черновик; Esc отменяет его. Закрытие/приоритет кода не отправляют запись.
- Ежесекундный enableConsole больше не очищает/блокирует поле, пока оно используется AI. Плашка паузы не перекрывает AI, сам таймер не меняется.
- Серверный message.user заменяет заглушку длительности текстом диктовки, с привязкой к ACK и фильтрацией чужих сообщений. Учтён вложенный result и позднее обновление с прежним seq; fingerprint-фильтр продолжает отсекать настоящие повторы.
- 70 Node tests и14 Python tests passed; Intel/ARM native builds succeeded. Нативный WKWebView Preview подтвердил общий ввод, Enter и диалог; ответы Preview явно тестовые. Физический RESET+KT полный цикл после этого обновления агентом не проверен. Native local capture test упёрся в отдельное разрешение Preview, не считается успешным тестом микрофона.
- Установлено на mini с backup ~/LOST-backups/terminal-dialog-20261026-113112, текущий Live сохранён; оба окна/Waveshare и UPS ready. Пользователь разрешил микрофон новой сборке; authorization3, KT USB Audio доступен.
- Реальный синтетический WAV принят рабочим Muse на mini; после исправления seq пришла настоящая русская расшифровка в пользовательской строке. Локальная STT не добавлялась. Служебная диагностика start/stop/cancel не содержит send.
