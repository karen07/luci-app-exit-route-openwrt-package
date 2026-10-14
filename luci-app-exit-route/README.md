# luci-app-exit-route

A standalone LuCI application for an OpenWrt mesh whose existing `exit-route.sh`
is managed by **openwrt-mesh-builder**. The companion **updated mesh-builder**
archive is required; installing this package alone does not install/patch the
service.

## Install

Add the `luci-app-exit-route/` source directory to the OpenWrt build tree under
`package/`, enable `CONFIG_PACKAGE_luci-app-exit-route=y` and the separate
`luci-i18n-exit-route-ru` package if Russian translation is wanted. Deploy
router configs from the **updated mesh-builder** archive to provide the expected
`/etc/scripts/exit-route.sh` and generated exit mark tables.

LuCI menu: **Network -> Exit Route**.

## What it does

- Global route: `Auto`, each configured IPIP exit, `WAN`.
- Exit status: Babel announcement route present / missing, IPIP tunnel name and
  `dev` of the installed Babel route. No synthetic IPIP-up reachability.
- WAN: uses `ubus network.interface.wan status` (`up`, `l3_device`) and confirms
  a default IPv4 route in `main` via that device. This **does not test Internet
  connectivity**.
- Device routing: DHCP leases, mesh-builder static `routing_rules`, and LuCI
  overrides. Add an arbitrary unicast IPv4 address and select `Use global route`,
  `WAN`, an exit, or `Split via exit`.
- Runtime overrides use the **same fw4 MARK rules and generated policy tables**
  as mesh-builder, with no alternate per-device `ip rule` implementation.
- For a device with a deployment rule, **Restore** removes the override and
  reveals the original rule. `Use global route` instead explicitly overrides
  the deployment rule with the global routing policy.

Global mode is saved in `/var/run/exit-route` and resets to AUTO on reboot.
Device overrides are UCI firewall rule sections in `/etc/config/firewall` and
**persist across reboot**. The mesh deployment process may replace firewall
configuration, so do not assume overrides survive a full redeploy.

Source UI strings are English and use LuCI `_()`; `po/ru/exit-route.po` contains
Russian translations compiled by the LuCI build system.

## Commands

```sh
/etc/scripts/exit-route.sh status
/etc/scripts/exit-route.sh set AUTO
/etc/scripts/exit-route.sh set FR2
/etc/scripts/exit-route.sh set WAN
/etc/scripts/exit-route.sh device-list
/etc/scripts/exit-route.sh device-set 10.101.1.77 exit FR2
/etc/scripts/exit-route.sh device-set 10.101.1.77 split FR1
/etc/scripts/exit-route.sh device-set 10.101.1.77 wan -
/etc/scripts/exit-route.sh device-set 10.101.1.77 default -
/etc/scripts/exit-route.sh device-del 10.101.1.77
```

`device-set` commits new UCI firewall rules and reloads the firewall, without
stopping or fighting the running exit-route service. Exit tables `10001+` are
created *by the generator* for all exit targets available on the router.

**Scope:** IPv4 ingress from `lan` only, as in the original mesh-builder's
`routing_rules`. IPv6, DNS policy, and other ingress zones are not covered.

The code is syntax checked and has isolated tests; it still needs integration
validation on a real OpenWrt fw4/netifd setup before production use.
