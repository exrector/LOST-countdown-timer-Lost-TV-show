# Проверка четырёх Muse capabilities на Mac mini AK

2026-10-26, macOS Monterey 12.7.6 / Intel / Python 3.9.6. Все времена MSK.

## Исправленная ошибка

Исходный `Executor.file_op` запускал `python -m musegadget.fileops` с `cwd='/'`
и чистым окружением без PYTHONPATH. Путь, добавленный в sys.path родительского
runtime, дочернему процессу не передавался. Реальный file.write на собственном
fixture завершился `ModuleNotFoundError: No module named 'musegadget'`.

Локальный `MacExecutor` в executor_adapter.py запускает тот же неизменённый
stdlib-only fileops.py по фиксированному абсолютному пути. Сохраняются Python
интерпретатор, stdin JSON, cwd, timeout, account и upstream _child_options.
Runtime устанавливает этот класс до вызова cli.main; CLI разрешает Executor
внутри cmd_run. Новых команд, прав, зависимостей и PYTHONPATH нет; SDK не менялся.

## Ожидалось / фактически

| Проверка | Ожидалось | Фактически | Итог |
|---|---|---|---|
| device.health, offline + live | Статус устройства | ok; version, hostname, load, disk_gb | ОК с ограничением ниже |
| system.run, offline | stdout/stderr, exit 7, заданный cwd | Точные fixture stdout/stderr; exit 7; pwd совпал | ОК |
| system.run timeout, offline | Убить shell и child process group | timeout 200ms, exit -SIGKILL; group и child исчезли | ОК |
| system.run, live | printf marker + uname -s + id -un | Точный marker, Darwin, текущий пользователь; stderr пуст, exit 0 | ОК |
| file.write, offline | Два чанка, атомарный final, SHA256 | До final старые байты; после final новые; открытый старый inode сохранил старые данные | ОК |
| file.write, offline | overwrite=false / неверный SHA не меняют target | Оба отказа, target сохранён, partial удалён | ОК |
| file.write, live | 33 байта, фиксированные base64/SHA, final=true | complete=true; 33 байта; SHA совпал; mode0600 внутри dir0700 | ОК |
| file.read, offline | limit/offset/eof/base64 | offset2/limit4; cap65536; tail/eof; EOF empty; binary roundtrip | ОК |
| file.read, live | Прочесть записанные 33 байта | Точный base64, next_offset33, eof=true, SHA совпал | ОК |
| Shell FD, offline | Нет накопления дескрипторов | 20 запусков: FD before/max/after = 5/5/5 | ОК, upstream warning ниже |

**Ограничение health:** uptime_s, memory_mb, temperature_c и model отсутствуют,
поскольку Linux /proc и /sys на macOS нет. Эти поля не реализованы этим patch.
Нельзя считать health полностью соответствующим перечислению в Linux description.

**Upstream ResourceWarning:** успешный system.run не закрывает pipe явно до
деструктора; Python сообщает unclosed-file warnings. Рост FD на 20 реальных
последовательных запусках не обнаружен. system_run не переписывали.

## Единственный live batch

Один prompt через прежний приватный LOST side-chat. Временный gate допускал
только точные параметры собственного fixture, один вызов каждого метода;
посторонние и повторные действия не исполнялись. Gate и trace удалены после batch.

| Метод | Реальный invoke → result_sent | Correlation hash | Результат |
|---|---|---|---|
| device.health | 18:16:24.763 → .766 | 0d6a57771498 | ok, 4 доступных поля |
| system.run | 18:16:40.665 → .692 | 5cfb04797dea | ok, stdout matches, exit0 |
| file.write | 18:16:43.925 → .989 | a5a44c752089 | ok, path/size/SHA verified |
| file.read | 18:16:48.295 → .371 | 5e9318396079 | ok, base64/SHA/eof verified |

SHA256 реального файла: `da344a641faf431533952f1729169c84d79254889c069734c437e2bc1378f3de`.
Base64: `TE9TVF9DQVBTXzIzZmIxNGVjYzBhNwpiaW5hcnk6AP8K`.
Независимое чтение fixture на диске подтвердило те же байты и hash. В собственном
завершённом ответе side-chat присутствовали этот base64 и shell marker; сырой чат
в evidence не копировался. Текст «успех» модели не служил доказательством выполнения.
result_sent подтверждает локальную отправку, а не отдельный RPC ACK Muse.

Временная директория и её единственный файл удалены; копия 33 fixture-байт
сохранена в приватной папке передачи вместе с безопасным evidence JSONL.

## Регрессии

14 актуальных canonical chat tests + 4 transport tests + 8 новых actual-executor
tests прошли на mini. Offline tests используют Account.current, реальные shell
subprocess и файловый worker, только собственные TemporaryDirectory(mode0700).
Identity, credentials и сеть не используются. Runtime после удаления gate
загружен штатным Muse module restart; остальные модули не перезапускались.
