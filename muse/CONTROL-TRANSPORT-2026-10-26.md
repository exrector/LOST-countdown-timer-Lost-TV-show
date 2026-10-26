# Muse control и chat: Mac mini AK, 2026-10-26

## Изменение

LOST сохраняет один Muse runtime, одну регистрацию гаджета и прежний приватный
side-chat. `runtime.py` включает `separate_chat=True`: control соединение обслуживает
только `/link-control`, а отдельное Noise соединение без `link.register` обслуживает
`/chat/subscribe`, текст и голос. Identity, pairing и набор команд не меняются.

Подписка и отправка используют один и тот же исходный side-chat ID. Основной чат
и экспериментальные режимы не используются. Vendored SDK восстановлен побайтово;
изменений SDK, heartbeat, nonce и диагностических маркеров в production нет.

При остановке control сессии закрываются chat task и socket. При обрыве HTTP chat
его соединение и подписка создаются заново; control остаётся зарегистрированным.
Отказ авторизации chat закрывает control, чтобы штатный Service заново получил
leased VM bearer. Ответ subscribe 404 не закрывает исправный HTTP канал: первый
POST по-прежнему может создать side-chat.

## Доказательства и границы

Все времена MSK, на целевом Intel Mac mini; других хостов/SSH не использовали.

- До исправления: регистрация подтверждена, node_id совпал, API вернул одну VM.
  Во время контрольных turn входящего `link.invoke` не было. Изменение chat.device_id
  и heartbeat проблему не устранило.
- Без предварительной SSE, основной чат: 17:38:24.876 получен device.health,
  17:38:24.877 executor ok, 17:38:24.879 link.result sent.
- При SSE на общей control/chat сессии входящие команды вновь не наблюдались.
- Раздельные соединения, исходный LOST side-chat: 17:50:40.492 получен
  link.invoke device.health; 17:50:40.493 executor ok; 17:50:40.494 link.result sent,
  один correlation ref `2c69c12ad02f`. В 17:50:44 завершён ответ в LOST side-chat,
  содержащий SUCCESS и не содержащий TIMEOUT.

Тем самым устранён наблюдавшийся конфликт совместного использования Noise
соединения постоянной chat подпиской и control потоком. Внутренний механизм
сервисной диспетчеризации не установлен. Текст модели не использован как
доказательство факта вызова: invoke/executor/result подтверждены локальным логом.
Одноразового nonce proof получения конкретного payload не проводили; после
указания пользователя новые chat requests прекращены. После удаления временной
диагностики новых живых вызовов не делали.

## Проверки

Canonical `test_chat_adapter.py`: 14 тестов прошли на mini без изменения их
assertions (ASR, повторный seq, поздний transcript, голос, приватность).
`test_chat_transport.py`: 4 offline теста прошли. Настоящие Noise handshake,
шифрование и framing выполняются поверх очередей без сети, identity и credentials.

Проверены единственная регистрация; разделение HTTP и control; коррелированный
invoke/result при открытой SSE; правильный side-chat для subscribe/text/voice;
закрытие обоих соединений; восстановление после HTTP drop; первый POST после
subscribe 404; отказ chat-auth с закрытием control для refetch; реальный macOS
health executor.

## Сверенные реализации

- [rjohnt/muse-gadget-macos, 098532c](https://github.com/rjohnt/muse-gadget-macos/tree/098532c00fe530933a92fe7266b9c83d420aa8aa):
  host.py использует upstream Service/LinkSession, без нашей SSE подмены.
  Pinned SDK b1a382 также отправляет chat.device_id=node_id и регистрируется как
  linux/homehub; эти поля сами по себе не объясняют проблему.
- [Официальный ESP32 chat](https://github.com/facebookincubator/muse-gadget-sdk/blob/c9354b7a765cfb7dd3c4f1945a9ca838d871630c/esp32/components/muse/muse_chat_session.cpp):
  отдельный ClientSession для chat HTTP, без link.register.
- [Официальный ESP32 control](https://github.com/facebookincubator/muse-gadget-sdk/blob/c9354b7a765cfb7dd3c4f1945a9ca838d871630c/esp32/main/noise_control.cpp):
  отдельный control; формат link.result method/id/ok/payload совпадает с Linux.
- [wong2/muse-client, 35989f6](https://github.com/wong2/muse-client/tree/35989f6e2ff9c42849b709f41879bfcfc6f8751d):
  chat reference, не gadget control; не объявляет локальные команды.

После финальной загрузки в 18:00:23: один runtime PID29900, core PID23000,
GUI PID23014. В текущей сессии две Noise handshake, один link.register и один ack.
Таймер Live не остановлен (516 → 514 секунд), UPS/VPN/Flame/Muse ready,
chat idle/available. Дополнительно прошли 7 Node gateway/supervisor fixture tests.
