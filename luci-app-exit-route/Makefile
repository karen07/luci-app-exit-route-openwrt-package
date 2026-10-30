include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-exit-route
PKG_VERSION:=0.2.0
PKG_RELEASE:=2
PKG_LICENSE:=AGPL-3.0-or-later
PKG_MAINTAINER:=Karen Khachatryan <karen0734@gmail.com>
LUCI_MAINTAINER:=$(PKG_MAINTAINER)

LUCI_TITLE:=LuCI manager for mesh exits, WAN and device routing
LUCI_DEPENDS:=+luci-base
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
