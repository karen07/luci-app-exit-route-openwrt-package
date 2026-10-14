# Exit Route LuCI OpenWrt Package

A LuCI web interface for configuring IPv4 exit routing on OpenWrt systems managed by
`openwrt-mesh-builder`. It provides global and per-device routing settings, exit status,
and localized interface strings.

Веб-интерфейс LuCI для настройки IPv4-маршрутизации через выходы в OpenWrt,
подготовленной `openwrt-mesh-builder`. Позволяет задавать общие и индивидуальные
правила маршрутизации, просматривать состояние выходов и использовать локализованные
строки интерфейса.

## Описание

Пакет предоставляет веб-интерфейс LuCI для настройки `exit-route`, не заменяя сам
сервис маршрутизации. Страница использует стандартные компоненты LuCI, UCI и права
`rpcd`; локализации находятся в дереве `po/`.

Глобальный маршрут и правила отдельных устройств поддерживают шесть режимов `DIRECT`, `AUTO`, `SPLIT_FAIL_OPEN`, `SPLIT_FAIL_CLOSED`, `EXIT_FAIL_OPEN`,
`EXIT_FAIL_CLOSED`. Для устройства предусмотрен также `DEFAULT` - наследование общей
политики. В режиме `AUTO` можно менять приоритет выходов; редактор устройства
начинает с глобального порядка, но сохраняет индивидуальный `auto_exit`.
Флаг `Disable` временно отключает индивидуальное правило, сохраняя его
настройки. `AUTO` перебирает доступные EXIT по приоритету; режимы `SPLIT_*`
и `EXIT_*` используют один выбранный EXIT и при его отказе переходят на WAN
либо блокируют трафик согласно суффиксу `FAIL_OPEN` / `FAIL_CLOSED`.
Интерфейс показывает состояние выходов, получаемое от службы, но не
проверяет доступность интернета самостоятельно. Для доступных EXIT дополнительно
отображается только интерфейс первого перехода из установленного Babel-маршрута
(например, `Interface: TROut`), а не полный путь через mesh.

Для работы нужна совместимая версия `openwrt-mesh-builder` с
`/etc/scripts/exit-route.sh` и UCI-конфигурацией `/etc/config/exit_route`, включая
поддержку индивидуальных приоритетов `device.auto_exit` и флага `device.disabled`.
Значения UCI вне текущей схемы вызывают ошибку конфигурации.
LuCI не исправляет их автоматически.
Строгие режимы требуют обновлённого firewall и службы из Mesh Builder.
LuCI-пакет не устанавливает эту службу и не создаёт EXIT-туннели. После установки страница доступна
в меню **Services / Exit Route**.

## Разработка и проверка изменений

**Опорные параметры для изменения поведения:**

1. `exit_route.main.mode`, `exit_route.main.exit` - глобальный режим и выбранный
   выход; значения и их смысл должны соответствовать контракту `exit-route.sh`.
1. `exit_route.main.auto_exit` и `device.auto_exit` - обязательный общий и
   необязательные индивидуальные порядки `AUTO`. Исходный порядок не хранится отдельно.

**Основные точки изменения:**

- `luci-app-exit-route/htdocs/luci-static/resources/view/network/exit-route.js` -
  форма LuCI, настройки устройств, порядок `AUTO` и отображение статуса;
- `luci-app-exit-route/htdocs/luci-static/resources/view/network/exit-route.css` -
  локальное оформление страницы;
- `luci-app-exit-route/root/usr/share/rpcd/acl.d/luci-app-exit-route.json` -
  права RPC для интерфейса;
- `luci-app-exit-route/root/usr/share/luci/menu.d/luci-app-exit-route.json` -
  пункт меню LuCI;
- `luci-app-exit-route/po/` - локализации;
- `luci-app-exit-route/Makefile` - метаданные пакета.

**Типовая правка настройки:** поле формы в `exit-route.js` должно использовать
существующий UCI-ключ и значения, поддерживаемые службой в `openwrt-mesh-builder`.
При добавлении режима или параметра проверьте как глобальные настройки, так и
правила устройств. Если меняется чтение статуса или вызываемая RPC-операция,
согласуйте команду службы и разрешения в `rpcd/acl.d`.

**Границы интерфейса:** применение маршрутов, создание правил firewall и выбор
доступного выхода выполняет `exit-route.sh`, а не LuCI. Страница редактирует UCI
`exit_route` и показывает результат `/etc/scripts/exit-route.sh status`, включая
`MODE`, `SELECTED`, `ACTIVE`, `APPLY`, `ERROR` и сведения о выходах. Доступность
выходов определяется на стороне службы по маршрутам Babel; её не следует
интерпретировать как независимую проверку прохождения трафика. Служба передаёт строку `HOP\t<exit>\t<gateway>\t<interface>`
для каждого доступного EXIT. LuCI отображает только поле `interface`.
Если интерфейс первого перехода неизвестен, плитка показывает только доступность.

Изменения формы сохраняются через стандартный механизм LuCI: сначала попадают
в ожидающие UCI-изменения, затем применяются через **Save & Apply**. Обработчик
перезагрузки `exit_route` в `openwrt-mesh-builder` обновляет правила. При изменении
формы нельзя незаметно подменять этот механизм прямым применением маршрутов из UI.

LuCI меняет только UCI на работающем роутере, но не исходный `config.json`.
Перед повторной генерацией прошивки перенесите нужные изменения в
`routers[].exit_route` и `routers[].routing_rules`: Mesh Builder полностью
пересоздаёт `exit_route`, а обновление через `sysupgrade -n` не сохраняет
локальные настройки UCI.

**Проверка изменений:** для нового поля сверьте UCI-ключ с обработкой в службе;
для новой команды - её вызов и ACL; для изменений страницы - доступность пункта
меню, отображение режимов и сохранение параметров. При изменении текстов
проверьте `po/`. Синтаксис JavaScript можно проверить командой
`node --check luci-app-exit-route/htdocs/luci-static/resources/view/network/exit-route.js`.
После изменений нужно проверить сборку пакета и страницу LuCI; сохранение
настроек и применение маршрутов следует проверять на целевом OpenWrt.

## Сборка

Сборка выполняется через GitHub Actions. Workflow этого репозитория вызывает
общий reusable workflow из
[openwrt-package-ci](https://github.com/karen07/openwrt-package-ci).

CI можно запустить:

- push тега вида `vX.Y.Z` - значение тега используется как версия OpenWrt;
- вручную через `workflow_dispatch`, указав версию OpenWrt и при необходимости
  фильтры target/subtarget.

Параметры этого пакета хранятся в `openwrt-build.env`. Общие `openwrt-build.sh`,
`openwrt-matrix.py` и логика сборки через OpenWrt SDK находятся в
`openwrt-package-ci`.

Для ручной сборки каталог `luci-app-exit-route/` можно использовать как обычный
package directory внутри OpenWrt buildroot/SDK. Общий `openwrt-build.sh` также
поддерживает локальные режимы `install`, `build-router` и `build-target`.

`openwrt-mesh-builder` может автоматически загружать пакет из GitHub Releases
этого репозитория вместе с другими обязательными APK. Для этого должен быть
опубликован релиз `v<версия OpenWrt>` с файлом
`luci-app-exit-route_v<версия OpenWrt>_<arch>_<target>_<subtarget>.apk`.
Обычный запуск `workflow_dispatch` собирает и публикует APK через общий CI.
До публикации релиза автоматическая загрузка из Mesh Builder завершится ошибкой.

## Структура проекта

- `luci-app-exit-route/Makefile` - описание LuCI package;
- `luci-app-exit-route/htdocs/` - JavaScript и CSS веб-интерфейса;
- `luci-app-exit-route/root/` - интеграция меню LuCI и ACL rpcd;
- `luci-app-exit-route/po/` - переводы интерфейса;
- `openwrt-build.env` - параметры пакета для общего CI;
- `.github/workflows/openwrt-build.yml` - вызов общего reusable workflow.

## Связанные проекты

- `openwrt-mesh-builder` - конфигурация сети, служба `exit-route.sh` и UCI
  `exit_route`;
- [openwrt-package-ci](https://github.com/karen07/openwrt-package-ci) -
  общие сценарии и workflow сборки OpenWrt-пакетов.

## Лицензия

Проект распространяется под лицензией GNU Affero General Public License v3.0
или более поздней версии (`AGPL-3.0-or-later`). Подробности см. в файле
[LICENSE](LICENSE).
