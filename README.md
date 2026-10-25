# lost-timer

I coded the LOST countdown timer with JavaScript, jQuery, HTML, and CSS. Every 108 minutes the code must be entered into the terminal. Failure to enter the number will resulit in catastrophic failure. The number can only be entered wht there are 4 minutes left. If the timer reaches zero, the timer numbers get replaced by red and black Egyptian hieroglyphics and a voice saying "system failure" plays over and over again. So, enter the numbers, and save the world.

4 8 15 16 23 42

## Приложение для macOS Monterey

Оболочка на AppKit/WKWebView для Mac mini 2014: два окна в одном приложении, общий запуск и сохранение состояния. Сборка, установка и откат к Chrome описаны в [native/README.md](native/README.md). Команда `./script/build_and_run.sh --build-only` собирает приложение без остановки станции; `python3 script/install_native.py` устанавливает его с резервной копией и проверкой готовности.


## Первая установка на Intel Mac с Monterey

Корневой `LOST.app` содержит готовую Intel-сборку для macOS 12+. Установите Node.js 20+ и зависимости из корня проекта:

```sh
(cd cast-app && npm ci)
python3 cast-app/install-service.py --root "$PWD"
```

В `cast-app/config.json` задаются дисплей и режимы. Разрешённые отправители iMessage добавляются локально в `sleepFrom`; публичная конфигурация содержит пустой список. Запуск станции — `LOST.app`.

## Локальная разработка

`./script/build_and_run.sh --preview` открывает отдельный оконный Preview на текущем Mac, с собственным состоянием и портом 18765. Кнопка Run в Codex запускает именно Preview. Нужны Command Line Tools и Node.js. Рабочая станция на mini не затрагивается.

Обновление установленной станции после изменения исходников: сначала `LOST_BUILD_ARCH=x86_64 ./script/build_and_run.sh --build-only`, затем перенести готовый бандл и ресурсы на mini и выполнить `python3 script/install_native.py` там. Сам установщик не компилирует приложение. Интервалы и этапы описаны в `js/lost-timeline.js`; MP3 проигрываются целиком.
