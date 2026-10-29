# Mac mini AK — справочник для агентов

Читать перед любой работой на этой машине. Файл только дополняется снизу; устаревшее зачёркивается, не удаляется.
Инструкции для Kay (ИИ-ассистента станции) — отдельно, в `~/commands.md`.

## Машина

- Mac mini Late 2014 (`Macmini7,1`), Intel Core i5-4260U (2 ядра / 4 потока), 4 ГБ ОЗУ, SSD 931 ГБ.
- **macOS 12.7.6 Monterey (21H1320) — последняя для этой модели, обновлений больше не будет.** Не Linux: утилиты BSD.
- В `boot-args` есть `-lilubetaall`, `keepsyms=1 debug=0x100` — загрузчик с Lilu, не трогать.
- Учётная запись `exrectormini`, **автовход включён**. Сон и сон дисплея запрещены (держат LOST и caffeinate).
- Назначение: круглосуточная станция **LOST** (таймер «Лебедя», терминал, модули). Всё остальное вторично.

## Доступ

- С MacBook в домашней сети: `ssh mac-mini-ak` (`Mac-mini-AK.local`, ключ `~/.ssh/id_ed25519_macmini_ak`).
- Через Tailscale (MacBook вне дома или на точке доступа iPhone):
  `ssh -o HostKeyAlias=mac-mini-ak.local -i ~/.ssh/id_ed25519_macmini_ak exrectormini@100.99.36.23`
- **`sudo` требует пароль владельца. Агент пароль никогда не вводит**, даже если владелец сам его прислал.
  Нужен root — открыть владельцу вкладку терминала с готовой командой `ssh -t … 'sudo …'`, пароль вводит он.
- Системный журнал читать **`/usr/bin/log`**: в zsh `log` — встроенная команда, она перехватывает вызов и молча
  ничего не выдаёт.

## Экраны

- `DS-HDMI` 1024×600 — главный, сенсорный: терминал LOST. Касания переводит `TouchBridge` (`~/TouchBridge`).
- `Waveshare-625` 1560×720 — табло таймера.

## Службы и автозапуск

| Что | Где | Назначение |
|---|---|---|
| `com.exrector.lost` | `~/Library/LaunchAgents` | ядро LOST (node, порт 8765), запускает нативное окно `~/LOST/LOST.app` |
| `com.exrector.lost-ups` | `~/Library/LaunchAgents` | агент ИБП (порт 8766) |
| `com.exrector.touchbridge` | `~/Library/LaunchAgents` | сенсорный экран |
| `com.rogueamoeba.loopbackd`, `aceagent`, `acetool` | LaunchAgents / LaunchDaemons | Loopback |
| `com.exrector.lost-boot-guard` | `/Library/LaunchDaemons` (root) | при каждой загрузке до входа чистит `/var/db/PanicReporter` (см. «Проблемы», п. 1) |
| Loopback.app | объекты входа, скрыто | держит виртуальное устройство «Apple Voice Processed Mic» |
| `com.exrector.applevoiceprocessing` | `~/Library/Application Support/AppleVoiceProcessor/` (**не** LaunchAgents) | шумодав Apple; его загружает LOST **только пока открыт чат AI** |

## LOST

- Файлы: `~/LOST`. Исходники и история — в репозитории на MacBook `~/Documents/PROJECTS/LOST` (журнал изменений `PORTING.md`).
- Проверка: `curl -s localhost:8765/__health`; ответ пульта: `curl "localhost:8765/__cmd?text=статус"` (только из дома).
- Журналы и состояние: `~/Library/Logs/LOST/` — `core.log`, `native-status.json`, `native-keys.log`
  (нажатия PF6 и перехваты фокуса), `native-audio.json`. Служебные команды окну — файл `native-command.txt`
  (`activate`, `desktop`, `diagnostics`, `microphone-chat-open|close`…).
- Установка новой нативной сборки: `cd ~/LOST && ./script/build_and_run.sh --build-only && python3 script/install_native.py`
  (таймер сохраняется). Перед заменой файлов — копия в `~/LOST-backups/`.
- Подпись LOST закреплена за идентификатором `com.exrector.lost.native`: пересборка не сбрасывает доступ к микрофону.
- PF6 (PF18 на клавиатуре станции) сворачивает и разворачивает станцию. Пока станция на экране, LOST раз в 2 с
  сам забирает фокус — это киоск, другие программы уходят за него; для работы на Mac нажать PF6.

## Звук и голос AI

- Микрофон `KT USB Audio` стоит **внутри корпуса**: шум вентилятора и эхо корпуса.
- Цепочка шумодава: KT → программа шумодава Apple (`~/Projects/apple-voice-processing`, VoiceProcessingIO) →
  Loopback «Apple Voice Processed Mic» → LOST. Пока чат AI закрыт — служба выгружена, LOST пишет сырой KT.
- **На Monterey шумодав Apple приглушает весь остальной звук, пока он инициализирован** (настройка появилась
  только в macOS 14). Поэтому только на время чата; режим «ожидания» тоже приглушает — проверено, отброшен.
- Устройство Loopback задаётся `~/Library/Application Support/Loopback/Devices.plist` (Pass-Thru). Без запущенного
  Loopback.app устройства нет. Если пропадёт — восстановить файл из Time Machine (ниже).
- Распознаёт речь Muse (сервис Meta), по-русски плохо. Локальный whisper на этом CPU проверен и отвергнут:
  small ≈ 27 с на 30 с речи.
- Журнал AI (Muse): `~/Library/Application Support/LOST Muse/logs/runtime.log`. Сервер Muse сам рвёт сессию примерно
  раз в 13 мин и иногда отвечает HTTP 502 — это их сторона. Внутренние циклы SDK не трогать.

## Сеть

- Tailscale — приложение 1.102.4 из App Store, выход в интернет через exit-ноду в США.
- Домашний роутер Keenetic с AdGuard VPN и блокировкой «мимо туннеля»: **без VPN дома не работают Claude Code
  и Codex** (региональные ограничения). У владельца жёсткий DPI — при сетевых сбоях сначала проверять блокировки.

## Резервные копии

- Time Machine на NAS: `/Volumes/Резервные копии Mac_mini_AK_LOST/<дата>.previous/SSD — данные/…`.
  Кириллица в пути ломает прямой `cp` — брать путь из `find … -exec cp {} …`.
- Копии перед изменениями LOST: `~/LOST-backups/`.

## Известные проблемы и решения

1. **Окно «Вы выключили компьютер из-за возникшей проблемы» при каждой загрузке, после него «Ход установки»
   (`Installer Progress.app`) висит невидимым на переднем плане и клавиатура не доходит до LOST.**
   Причина (найдено 2026-10-29): после неудачного выхода из сна 28.10 осталась ссылка
   `/var/db/PanicReporter/current.panic` → отчёт `Sleep Wake Failure…`. Пока она лежит, каждый вход считается
   «после паники», как бы ни выключали. Удалить ссылку (каталог доступен на запись всем, sudo не нужен);
   `lost-boot-guard` чистит его при каждой загрузке. Убивать `Installer Progress` бесполезно — macOS запускает его
   снова. Следствие в настройках — `lastLoginPanic` в `/Library/Preferences/com.apple.loginwindow`.
2. **Mac уходил в сон от короткого нажатия кнопки питания и не просыпался (EFI).** Это и создало п. 1.
   Владельцу предложено `sudo pmset -a powerbutton 0`.
3. **LOST падал, когда другая программа перестраивала звук** (NSException в `AVAudioPlayerNode.play`) — исправлено
   перехватом в `native/Sources/LOSTObjC.m`.
4. **Оранжевая точка микрофона горит, хотя никто не пишет** — зависшее состояние после перезапуска `coreaudiod`;
   лечится перезагрузкой.
5. **Пустые экраны без Dock и меню** — это тот же зависший «Ход установки» (п. 1), не LOST.

## Правила для агентов здесь

- Без согласия владельца ничего не делать в графическом сеансе (osascript, нажатия, запуск программ) и не
  перезагружать. Проверки, которые меняют звук или экран станции, — объявлять заранее.
- «Команды» (Shortcuts) в проверках запускать только с заведомо несуществующим именем.
- Не устанавливать Docker, не предлагать платное.
- Записи об изменениях — в `PORTING.md` репозитория LOST и сюда, только дополняя.

---
_Создан 2026-10-29 (Claude)._
