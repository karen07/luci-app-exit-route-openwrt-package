include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-exit-route

PKG_MAINTAINER:=Karen Khachatryan <karen0734@gmail.com>
LUCI_MAINTAINER:=$(PKG_MAINTAINER)
PKG_LICENSE:=AGPL-3.0-or-later

LUCI_TITLE:=LuCI manager for mesh exits, WAN and device routing
LUCI_URL:=https://github.com/karen07/luci-app-exit-route-openwrt-package
LUCI_DESCRIPTION:=Provides Web UI for global and per-device exit routing
LUCI_DEPENDS:=+luci-base

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
