# Muse SDK: проверенный перечень для LOST

Проверка: 25 октября 2026. Исходники официального репозитория, а не только README; установленный mini проверен по SSH. Сеть/SDK/настройки при этом не менялись.

## Какая версия работает

- Официальный `facebookincubator/muse-gadget-sdk`, Python-пакет `musegadget` версии `0.1.0`, каталог `linux/src/musegadget`.
- Закреплённый commit `c9354b7a765cfb7dd3c4f1945a9ca838d871630c` совпал с текущим main. Все скачанные Python-файлы этого каталога побайтово совпали с vendored-копией LOST. Контрольные суммы четырёх ключевых файлов на mini совпали с локальной копией.
- На mini Python3.9.6, обычный процесс macOS Monterey, без Linux/VM. Название Linux относится к исходной целевой платформе SDK. Даже metadata регистрации пока содержит platform=linux/model_id=linux.
- Официальный Linux installer, systemd и BlueZ-паринг не переносились на Mac. Использована сохранённая пара, нативный macOS микрофон, наш адаптер чата, LaunchServices/launchd и оболочка LOST. Официальное Python-ядро сохранено.

Источник: [пакет и зависимости](https://github.com/facebookincubator/muse-gadget-sdk/blob/c9354b7a765cfb7dd3c4f1945a9ca838d871630c/linux/pyproject.toml), [CLI](https://github.com/facebookincubator/muse-gadget-sdk/blob/c9354b7a765cfb7dd3c4f1945a9ca838d871630c/linux/src/musegadget/cli.py).

## Текущая цепочка голоса

RESET удерживается в режиме AI → AVAudioRecorder записывает WAV на Mac → отпускание отправляет файл в текущую Muse-сессию → сервер обрабатывает речь → подписка приносит текст ответа → LOST показывает текст.

Локального распознавания речи у нас нет. Сейчас `send_voice(..., output_modality='text')`; пользовательская строка в истории — «Голосовое сообщение: N с». Отсутствие расшифровки на экране является ограничением нашего адаптера, а не доказательством отсутствия такой возможности сервера.

Физический голос пользователь подтвердил как работающий после восстановления AMFI и разрешения микрофона. Отдельно агентом проверены реальный русский WAV→ответ и реальный текстовый обмен через LOST. Голосовой ответ/TTS на аккаунте не испытывался.

## Python SDK: чат, аудио и события

| Возможность | API | Что действительно делает | LOST сейчас |
|---|---|---|---|
| Текстовый запрос | `send_chat(message, session_id, output_modality=...)` | Отправляет сообщение от зарегистрированного гаджета | Подключено, реальный ответ проверен |
| Голосовая заметка | `send_voice(wav_bytes, session_id, message=..., output_modality=...)` | WAV до2MiB; можно приложить текстовую инструкцию | Подключено; наш WAV monoPCM16k16bit |
| Отдельный разговор | `session_id` | Повторное использование ID продолжает side chat | Постоянный UUIDv5 для терминала |
| Основной чат | Без `session_id` | Сообщение в основной разговор Muse | Не выбран для терминала |
| Поток событий | `subscribe_chat()` | NDJSON, поступающие части и итоговые сообщения | Подключено |
| Голосовой ответ | `output_modality='voice'` + `stream_tts(message_id)` | Получение MP3 для voice-modality ответа; fallback двух URL | Не подключено, реальная доступность/русский голос не проверены |
| Универсальный поток HTTP | `stream_http()` | Запросы через существующий Noise-транспорт с ограниченным буфером | Внутренняя основа подписки; не готовый браузер |

Источник: [LinkSession](https://github.com/facebookincubator/muse-gadget-sdk/blob/c9354b7a765cfb7dd3c4f1945a9ca838d871630c/linux/src/musegadget/link_client.py).

SDK содержит `MuseTurn`, `ReplayScope`, `AgentStatus`, `Reply`, `TaskFinished`: связь ответа с запросом, фильтрация повторов, частичный/завершённый ответ и состояние задачи. Обрабатываются `agent.status`, `task.status`, `delta.message_start`, `delta.text_append`, `delta.message_done`, `message.assistant`. Можно показывать реальный публичный статус работы — например thinking/researching/planning/executing — если сервер его прислал. Это не проценты готовности и не внутренние рассуждения модели.

Наш адаптер использует собственную обработку событий и сохраняет ограниченную локальную историю; наличие `MuseTurn` в vendor ещё не означает, что весь его функционал уже включён в UI.

Источник: [muse_turn.py](https://github.com/facebookincubator/muse-gadget-sdk/blob/c9354b7a765cfb7dd3c4f1945a9ca838d871630c/linux/src/musegadget/muse_turn.py).

**Расшифровка собственной речи:** ESP32 Link-клиент получает `message.user`, сопоставляет с ACK голосового сообщения, удаляет строку вложения `[file:...]`, отбрасывает заглушку `[Voice note]` и показывает текст через HEARD. Можно перенести обработку того же события в LOST; локальная STT не требуется. Возврат transcript для каждой записи на нашем аккаунте отдельно ещё не проверялся.

Источник: [muse_chat_link.c, on_row](https://github.com/facebookincubator/muse-gadget-sdk/blob/c9354b7a765cfb7dd3c4f1945a9ca838d871630c/esp32/components/muse/muse_chat_link.c).

## Все стандартные команды установленного Python-гаджета

| Команда | Возможности и пределы |
|---|---|
| `system.run` | Bash-команда, cwd, timeout; stdout/stderr/exit code, признак timeout/truncation. По умолчанию120с, максимум600с; вывод ограничен96KiB на поток. |
| `file.read` | Абсолютный путь, offset/limit, base64; чтение до64KiB за вызов, повтор до eof. |
| `file.write` | Последовательные base64-части до64KiB, offset/final, optional SHA256, создание родителей/overwrite; атомарная замена после завершения. |
| `device.health` | Версия/hostname/load/disk; Linux uptime/memory/temperature/model через /proc и /sys. Эти Linux-поля на Mac не заполняются автоматически. |

Это уже объявленные cloud tools, а не будущая идея. На mini они исполняются от текущего пользователя, не как root. Доступ к файлам определяется правами этого пользователя; это не доступ только к LOST. Реальное выполнение команд/файлов через Muse в этом исследовании не запускалось.

Собственные команды добавляются schema в `commands_v2` и обработчиком. Поэтому чтение UPS, управление разрешёнными функциями LOST, Apple Music или датчиками технически возможно через наш код, но таких интеграций SDK за нас не создаёт.

Источники: [executor.py](https://github.com/facebookincubator/muse-gadget-sdk/blob/c9354b7a765cfb7dd3c4f1945a9ca838d871630c/linux/src/musegadget/executor.py), [fileops.py](https://github.com/facebookincubator/muse-gadget-sdk/blob/c9354b7a765cfb7dd3c4f1945a9ca838d871630c/linux/src/musegadget/fileops.py).

## Служебные возможности

- Сохранённая identity и пара, обновление токенов, выбор default VM, TLS/WebSocket+Noise, мультиплексирование потоков, регистрация гаджета и вызовы команд.
- Автопереподключение2/4/8/16/32/60с, сброс backoff после устойчивой сессии. Обработка отозванной пары. В LOST дополнительно запрещено её автоматическое удаление/создание новой идентичности.
- CLI `run`, `pair`, `info`, `unpair`, `send-user-msg`; последний позволяет локальным программам отправлять сообщения/события через Unix socket, без раздачи им credentials.
- Поэтому событие UPS можно превратить в сообщение Muse, но это наша интеграция; сам SDK не следит за UPS и не гарантирует расписания/фоновые задачи облачного ассистента.

Источник: [service.py](https://github.com/facebookincubator/muse-gadget-sdk/blob/c9354b7a765cfb7dd3c4f1945a9ca838d871630c/linux/src/musegadget/service.py), [Linux README](https://github.com/facebookincubator/muse-gadget-sdk/blob/c9354b7a765cfb7dd3c4f1945a9ca838d871630c/linux/README.md).

## Что может показывать интерфейс

Python SDK не поставляет окон, Canvas, шрифтов, картинок персонажа или готовой сцены. В LOST отображение делает WKWebView. Мы можем показывать поступающий текст, страницы истории, индикатор записи и громкости, состояние соединения и задачи; рисунок и оформление определяет наш интерфейс.

ESP32-часть содержит отдельный локальный procedural renderer64×64: boot/idle/listening/thinking/speaking/error/off. Есть моргание, дыхание, взгляд, жесты/волны; happy — реакция поверх состояния, не отдельный cloud emotion. Рот зависит от амплитуды0…1, не фонем. Текст/caption и progress — отдельные локальные поля. Перенос на LOST требует своего renderer/bindings; формат терминала не ограничивает набор возможных анимаций.

Источники: [muse_state.h](https://github.com/facebookincubator/muse-gadget-sdk/blob/c9354b7a765cfb7dd3c4f1945a9ca838d871630c/esp32/components/muse/muse_state.h), [muse_pixel.c](https://github.com/facebookincubator/muse-gadget-sdk/blob/c9354b7a765cfb7dd3c4f1945a9ca838d871630c/esp32/avatar/muse_pixel.c).

## ESP32: дополнительные команды, не установленные в LOST

Команды зависят от платы и build flags; это не единый обязательный набор каждого гаджета.

| Группа | Команды/возможности |
|---|---|
| Экран | `display.draw_url(url,row?)`, `display.draw_file(path,row?)`: baseline JPEG/rawRGB565. `path` — файл на Muse VM. `display.show_animation()` лишь возвращает существующий avatar/status после картинки; не выбирает эмоцию и не создаёт новую анимацию. |
| Звук | `voice.configure(volume?)`: настройка/чтение громкости0…100. |
| Фото | `camera.capture`: JPEG с камеры подходящей платы, результат base64; не камера Mac. |
| Датчики | `sensors.read`: температура/влажность, а на соответствующей SenseCAP-плате такжеCO2/TVOC, единицы/возраст показания. |
| Состояние/сеть | `device.health`; optional `device.discover`: обнаружение локальных устройств. |
| Обновление | `device.ota(url,force?)`: загрузка прошивки платы по HTTPS и перезапуск. Не updater LOST. |
| BLE | `ble.state`, `ble.power`, `ble.advertise`, `ble.scan`, `ble.connect`, `ble.disconnect`, `ble.discover`, `ble.read`, `ble.write`, `ble.subscribe`. Это реализация ESP32 BLE, не автоматическое управление Bluetooth Mac. |

В `app.c` также есть обработчики служебных `device.list_vms`, `device.set_vm`, `device.reset_vm`, `device.unpair`; наличие обработчика не означает его объявления как cloud tool в `commands_v2`.

В текущей стандартной регистрации НЕ найден `display.set_caption`: caption есть в локальном UI API, но нельзя обещать готовую удалённую команду с этим именем. Это уточняет старые предварительные заметки.

Источники: [noise_control.cpp, commands_v2](https://github.com/facebookincubator/muse-gadget-sdk/blob/c9354b7a765cfb7dd3c4f1945a9ca838d871630c/esp32/main/noise_control.cpp), [app.c](https://github.com/facebookincubator/muse-gadget-sdk/blob/c9354b7a765cfb7dd3c4f1945a9ca838d871630c/esp32/main/app.c), [ble_commands.c](https://github.com/facebookincubator/muse-gadget-sdk/blob/c9354b7a765cfb7dd3c4f1945a9ca838d871630c/esp32/main/ble_commands.c).

## Голосовые нюансы ESP32

Есть инфраструктура PTT, pre-roll, отмены/прерывания, локально удерживаемых заметок при потере связи и отображения transcript. Это код ESP32, не включённые функции нашего Python-клиента.

В `muse_chat_session.cpp` текущий default `VOICE_NOTE=1`. Комментарий прямо отмечает неработающий ASR за streaming dictation на момент этой версии. Поэтому наличие `/api/voice/dictation` в исходниках не доказывает готовый непрерывный разговор. В `start_tts()` ESP32 этой реализации тишина задаёт темп caption; предлагается подключить свой TTS. Это отличается от Python `stream_tts()` и требует отдельного реального теста voice-modality на аккаунте.

Источники: [muse_voice.c](https://github.com/facebookincubator/muse-gadget-sdk/blob/c9354b7a765cfb7dd3c4f1945a9ca838d871630c/esp32/components/muse/muse_voice.c), [muse_chat_session.cpp](https://github.com/facebookincubator/muse-gadget-sdk/blob/c9354b7a765cfb7dd3c4f1945a9ca838d871630c/esp32/components/muse/muse_chat_session.cpp).

## Видео и симулятор

- Видеопротокол: камера/клип телефона → экран ESP32 в LAN; H264 илиVP8. Не потоковая картинка от облачного Muse и не видеозвонок. В Python SDK LOST получателя нет.
- В репозитории есть Android/iOS тестовые приложения для этого видеопротокола; это не выбранная нами библиотека macOS.
- Есть нативный UI simulator для Intel/AppleSilicon Mac: SDL2/LVGL, окно412×412, тот же renderer и локальные сценарии. Это полезный визуальный прототип; сетевые/радио/audio службы там заменены адаптерами, готового работающего ассистента он не даёт. Совместимость его конкретной сборки с Monterey здесь не тестировалась.
- Есть рецепт генерации собственного C-avatar через Muse и локального preview. Не следует автоматически переносить стандартный Meta/Jollybot образ: его лицензия исключена из общей Apache-лицензии SDK.

Источники: [VIDEO.md](https://github.com/facebookincubator/muse-gadget-sdk/blob/c9354b7a765cfb7dd3c4f1945a9ca838d871630c/protocols/VIDEO.md), [simulator README](https://github.com/facebookincubator/muse-gadget-sdk/blob/c9354b7a765cfb7dd3c4f1945a9ca838d871630c/esp32/simulator/README.md), [AVATAR_RECIPE](https://github.com/facebookincubator/muse-gadget-sdk/blob/c9354b7a765cfb7dd3c4f1945a9ca838d871630c/esp32/tools/muse/AVATAR_RECIPE.md).

## Практический выбор для LOST

1. Доработать текущий терминал: вывод распознанного `message.user`, статусы фактической работы, удобная история. Без смены SDK/ОС.
2. Отдельно проверить voice-modality→MP3, и только после успешного теста добавить переключатель озвучивания.
3. При желании добавить собственного зелёного пиксельного персонажа внутри текущего AI-экрана. Он может реагировать на реальные состояния и амплитуду; отдельное окно не обязательно.
4. Расширять инструменты явно реализованными командами LOST/UPS/музыки. Способности облачного Muse (поиск, память, расписания, внешние сервисы) этим репозиторием полностью не определяются.

Документ — исследование; перечисленные дополнительные функции этим изменением не включались. Предыдущие журналы сохранены, спорные предварительные утверждения уточнены здесь.

## Дополнение после независимой проверки исходников

- В app.c также есть служебный обработчик bug.report; как и device.list_vms/set_vm/reset_vm/unpair, он не объявлен стандартным agent tool в текущем commands_v2.
- ESP32 PTT обычно ограничен15с; есть pre-roll и прерывание новой кнопкой. VAD auto-start/auto-stop не найден. До4 offline notes хранятся в RAM и не переживают reboot.
- Transcript через message.user реально извлекает muse_chat_link.c. Другая реализация, CONFIG_MUSE_HATCH с VOICE_NOTE=1, это событие автоматически не извлекает. Нельзя обещать одинаковый вывод transcript для обеих реализаций без доработки.
