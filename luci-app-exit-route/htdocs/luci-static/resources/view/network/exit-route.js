'use strict';
'require view';
'require form';
'require uci';
'require fs';
'require dom';
'require poll';
'require network';
'require ui';

var script = '/etc/scripts/exit-route.sh';
var initScript = '/etc/init.d/exit-route';

function parseStatus(text) {
    var state = { exits: [] };
    var hops = {};
    text.split(/\r?\n/).forEach(function (line) {
        if (line.indexOf('EXIT\t') === 0) {
            var fields = line.split('\t');
            if (fields.length === 4)
                state.exits.push({ name: fields[1], reachable: fields[2] === '1' });
        } else if (line.indexOf('HOP\t') === 0) {
            var hopFields = line.split('\t');
            if (hopFields.length === 4)
                hops[hopFields[1]] = {
                    device: hopFields[3] === '-' ? null : hopFields[3],
                };
        } else {
            var pos = line.indexOf('=');
            if (pos >= 0) state[line.slice(0, pos)] = line.slice(pos + 1);
        }
    });
    state.exits.forEach(function (e) {
        e.hop = hops[e.name] || null;
    });
    return state;
}

function status() {
    return fs.exec(script, ['status']).then(function (result) {
        if (result.code !== 0)
            throw new Error((result.stderr || result.stdout || _('Command failed')).trim());
        var parsed = parseStatus(result.stdout || '');
        // The page only supports the current service status contract.
        ['MODE', 'SELECTED', 'ACTIVE', 'AUTO_EFFECTIVE', 'APPLY', 'ERROR'].forEach(function (key) {
            if (!Object.prototype.hasOwnProperty.call(parsed, key))
                throw new Error('Missing exit-route status field: ' + key);
        });
        if (!parsed.exits.length) throw new Error('Missing EXIT records in exit-route status');
        return parsed;
    });
}

function serviceState() {
    return Promise.all(
        ['status', 'enabled'].map(function (action) {
            return fs
                .exec(initScript, [action])
                .then(function (result) {
                    return typeof result.code === 'number' && result.code >= 0
                        ? result.code === 0
                        : null;
                })
                .catch(function () {
                    return null;
                });
        }),
    ).then(function (results) {
        return { running: results[0], enabled: results[1] };
    });
}

function validIPv4(ip) {
    if (typeof ip !== 'string') return false;
    var parts = ip.split('.');
    return (
        parts.length === 4 &&
        parts.every(function (part) {
            return /^(0|[1-9][0-9]{0,2})$/.test(part) && +part <= 255;
        }) &&
        +parts[0] > 0 &&
        +parts[0] !== 127 &&
        +parts[0] < 224
    );
}

function hostAddresses(hosts) {
    var byIP = {};
    if (!hosts) return [];
    hosts.getMACHints().forEach(function (hint) {
        var ip = hosts.getIPAddrByMACAddr(hint[0]);
        if (validIPv4(ip)) {
            var hostname = hosts.getHostnameByIPAddr(ip);
            byIP[ip] = hostname ? hostname + ' (' + ip + ')' : ip;
        }
    });
    return Object.keys(byIP)
        .sort(function (a, b) {
            return byIP[a].localeCompare(byIP[b]);
        })
        .map(function (ip) {
            return [ip, byIP[ip]];
        });
}

function asList(value) {
    if (Array.isArray(value)) return value.slice();
    return typeof value === 'string' && value !== '' ? value.split(/\s+/) : [];
}

function describePolicy(mode, exit) {
    if (mode === 'DEFAULT') return _('Use global route');
    if (mode === 'AUTO' || mode === 'DIRECT') return mode;
    if (
        ['SPLIT_FAIL_OPEN', 'SPLIT_FAIL_CLOSED', 'EXIT_FAIL_OPEN', 'EXIT_FAIL_CLOSED'].indexOf(
            mode,
        ) >= 0
    )
        return mode + ' ' + (exit || '-');
    return '-';
}

function activeRoute(state) {
    var active = state.ACTIVE || 'DISABLED';
    if (state.MODE === 'DIRECT') return 'WAN';
    if (active !== 'DISABLED') return active;
    if (state.MODE === 'SPLIT_FAIL_CLOSED') return _('Direct: WAN; other: BLOCKED');
    if (state.MODE === 'EXIT_FAIL_CLOSED') return _('BLOCKED');
    if (state.MODE === 'EXIT_FAIL_OPEN') return _('WAN (direct BLOCKED)');
    return 'WAN';
}

// Validate the complete current UCI contract before rendering the editor.
function validateExitRouteConfig() {
    var allowed = {
        state: ['table', 'interval', 'mode', 'exit', 'auto_exit'],
        exit: ['prefix', 'policy', 'interface'],
        device: ['ip', 'mode', 'exit', 'auto_exit', 'disabled'],
    };
    var validModes = [
        'DIRECT',
        'AUTO',
        'SPLIT_FAIL_OPEN',
        'SPLIT_FAIL_CLOSED',
        'EXIT_FAIL_OPEN',
        'EXIT_FAIL_CLOSED',
    ];
    var fixed = ['SPLIT_FAIL_OPEN', 'SPLIT_FAIL_CLOSED', 'EXIT_FAIL_OPEN', 'EXIT_FAIL_CLOSED'];
    var sections = uci.sections('exit_route');
    var exits = uci.sections('exit_route', 'exit').map(function (s) {
        return s['.name'];
    });
    var stateCount = 0;
    var deviceIPs = {};
    sections.forEach(function (section) {
        var kind = section['.type'];
        var name = section['.name'];
        if (!Object.prototype.hasOwnProperty.call(allowed, kind))
            throw new Error('Unsupported exit_route section: ' + kind);
        if (kind === 'state') {
            stateCount++;
            if (name !== 'main') throw new Error('Unsupported exit_route state: ' + name);
        }
        if (kind === 'device' && section['.anonymous'] === false)
            throw new Error('exit_route device sections must be anonymous: ' + name);
        Object.keys(section).forEach(function (key) {
            if (key.charAt(0) === '.') return;
            if (allowed[kind].indexOf(key) < 0)
                throw new Error('Unsupported exit_route option: ' + name + '.' + key);
        });
        if (kind !== 'state' && kind !== 'device') return;
        var mode = section.mode;
        if (validModes.indexOf(mode) < 0 && !(kind === 'device' && mode === 'DEFAULT'))
            throw new Error('Invalid exit_route mode: ' + (mode || '(missing)'));
        if (fixed.indexOf(mode) >= 0 && exits.indexOf(section.exit) < 0)
            throw new Error('Invalid EXIT selection for ' + name);
        if (section.exit != null && exits.indexOf(section.exit) < 0)
            throw new Error('Unknown EXIT selection for ' + name);
        var list = asList(section.auto_exit);
        if (
            list.some(function (item, i) {
                return exits.indexOf(item) < 0 || list.indexOf(item) !== i;
            })
        )
            throw new Error('Invalid auto_exit for ' + name);
        if (kind === 'state' && !list.length) throw new Error('Missing exit_route.main.auto_exit');
        if (kind === 'device') {
            if (!validIPv4(section.ip) || deviceIPs[section.ip])
                throw new Error('Invalid or duplicate device IPv4: ' + section.ip);
            deviceIPs[section.ip] = true;
            if (section.disabled != null && section.disabled !== '0' && section.disabled !== '1')
                throw new Error('Invalid disabled flag for ' + name);
        }
    });
    if (stateCount !== 1) throw new Error('exit_route requires one state main section');
}

function stateLabel(value, yes, no) {
    return value === true ? yes : value === false ? no : _('Unknown');
}

// Small circular status mark; use the same icon in AUTO and Exit status.
// LuCI owns the surrounding form widgets; no external CSS or icon library.
function healthIcon(reachable) {
    var variant =
        reachable === true ? 'available' : reachable === false ? 'unavailable' : 'unknown';
    return E('span', {
        class: 'exit-route-health-icon exit-route-health-icon--' + variant,
        role: 'img',
        'aria-label':
            reachable === true
                ? _('Available')
                : reachable === false
                  ? _('Unavailable')
                  : _('Unknown'),
    });
}

function cbiRow(label, content) {
    return E('div', { class: 'cbi-value' }, [
        E('label', { class: 'cbi-value-title' }, [label]),
        E('div', { class: 'cbi-value-field' }, content),
    ]);
}

// Keep LuCI's native radio widget (UCI binding, dependencies and validation),
// while presenting the choices as a single compact segmented control.
function styleRoutingMode(option) {
    option.widget = 'radio';
    option.orientation = 'horizontal';
    var nativeRenderWidget = option.renderWidget;
    option.renderWidget = function (sectionId, optionIndex, cfgvalue) {
        var widget = nativeRenderWidget.call(this, sectionId, optionIndex, cfgvalue);
        widget.classList.add('exit-route-segmented');
        widget.querySelectorAll('.cbi-radio').forEach(function (item) {
            var input = item.querySelector('input');
            var caption = item.lastElementChild;
            if (input && caption) input.setAttribute('aria-label', caption.textContent);
        });
        return widget;
    };
}

return view.extend({
    load: function () {
        return Promise.all([
            uci.load('exit_route').then(validateExitRouteConfig),
            status().catch(function (err) {
                return { exits: [], error: err.message };
            }),
            network.getHostHints().catch(function () {
                return null;
            }),
            serviceState(),
        ]);
    },

    effectiveAutoOrder: function () {
        return asList(uci.get('exit_route', 'main', 'auto_exit'));
    },

    markDirty: function () {
        this.dirty = true;
        if (this.dirtyNode) this.dirtyNode.style.display = '';
    },

    clearDirty: function () {
        this.dirty = false;
        if (this.dirtyNode) this.dirtyNode.style.display = 'none';
    },

    // Stage changes in pending UCI, but never apply routes from a field event.
    // The top LuCI "Unsaved Changes" counter only tracks staged UCI changes.
    scheduleStage: function () {
        var self = this;
        this.markDirty();
        if (this.stageTimer != null) window.clearTimeout(this.stageTimer);
        this.stageTimer = window.setTimeout(function () {
            self.stageTimer = null;
            self.stageNow().catch(function () {});
        }, 250);
    },

    stageNow: function () {
        var self = this;
        if (this.stageTimer != null) {
            window.clearTimeout(this.stageTimer);
            this.stageTimer = null;
        }
        if (this.stageRunning) {
            this.stageAgain = true;
            return this.stagePromise;
        }
        this.stageRunning = true;
        // UCI Save stages the change without rerendering the LuCI form.
        // This avoids losing the currently selected radio/select state.
        this.stagePromise = uci
            .save()
            .then(function () {
                self.autoOrder = self.effectiveAutoOrder();
                return ui.changes.init();
            })
            .then(function () {
                self.clearDirty();
            })
            .catch(function (err) {
                self.markDirty();
                ui.addNotification(null, E('p', {}, [err.message || String(err)]), 'danger');
                throw err;
            })
            .finally(function () {
                self.stageRunning = false;
                if (self.stageAgain) {
                    self.stageAgain = false;
                    self.scheduleStage();
                }
            });
        return this.stagePromise;
    },

    commitAutoOrderDraft: function (order) {
        this.autoOrder = order.slice();
        uci.set('exit_route', 'main', 'auto_exit', order.slice());
        this.orderViews.forEach(function (refresh) {
            refresh();
        });
        this.updateExitStatus(this.exitState);
        this.scheduleStage();
    },

    // Inline AUTO editor. Global order is staged immediately. Device order
    // is initialized from global AUTO and saved only by the native modal Save.
    renderAutoOrderWidget: function (sectionId, field) {
        var self = this;
        var isDevice = sectionId != null;
        var stored = isDevice ? asList(uci.get('exit_route', sectionId, 'auto_exit')) : [];
        var order = (stored.length ? stored : this.autoOrder).slice();
        var summary = E('div', { class: 'exit-route-auto-summary' });
        var rows = E('div', { class: 'exit-route-auto-list' });
        var dragged = null;
        var hoverRow = null;

        function clearDropHighlight() {
            if (hoverRow) hoverRow.style.boxShadow = '';
            hoverRow = null;
        }

        function indicateDrop(row, below) {
            if (hoverRow !== row) clearDropHighlight();
            hoverRow = row;
            row.style.boxShadow = below ? 'inset 0 -2px #00a8d6' : 'inset 0 2px #00a8d6';
        }

        function touchTarget(y) {
            var elements = rows.querySelectorAll('[data-auto-exit]');
            for (var i = 0; i < elements.length; i++) {
                var rect = elements[i].getBoundingClientRect();
                if (y >= rect.top && y <= rect.bottom)
                    return {
                        row: elements[i],
                        name: elements[i].getAttribute('data-auto-exit'),
                        below: y >= rect.top + rect.height / 2,
                    };
            }
            return null;
        }

        function changeOrder(next) {
            if (!next.length || JSON.stringify(order) === JSON.stringify(next)) return;
            order = next;
            if (isDevice) {
                field._autoState.order = order.slice();
                refresh();
            } else {
                self.commitAutoOrderDraft(order);
            }
        }

        function reorder(from, to, below) {
            if (from === to) return;
            var updated = order.slice();
            var idx = updated.indexOf(from);
            if (idx < 0 || updated.indexOf(to) < 0) return;
            updated.splice(idx, 1);
            updated.splice(updated.indexOf(to) + (below ? 1 : 0), 0, from);
            changeOrder(updated);
        }

        function renderRows() {
            var items = order.map(function (name, i) {
                var state = self.exitState.exits.filter(function (e) {
                    return e.name === name;
                })[0];
                var controls = [
                    E(
                        'button',
                        {
                            type: 'button',
                            class: 'cbi-button drag-handle exit-route-auto-action exit-route-drag-handle',
                            title: _('Drag to reorder'),
                            'aria-label': _('Drag to reorder') + ': ' + name,
                            draggable: true,
                            style:
                                'cursor:grab;user-select:none;-webkit-user-select:none;' +
                                'touch-action:none',
                            dragstart: function (ev) {
                                dragged = name;
                                ev.dataTransfer.effectAllowed = 'move';
                                ev.dataTransfer.setData('text/plain', name);
                            },
                            dragend: function () {
                                dragged = null;
                                clearDropHighlight();
                            },
                            touchstart: function () {
                                dragged = name;
                            },
                            touchmove: function (ev) {
                                if (dragged !== name || !ev.touches.length) return;
                                ev.preventDefault();
                                var target = touchTarget(ev.touches[0].clientY);
                                if (target && target.name !== name)
                                    indicateDrop(target.row, target.below);
                                else clearDropHighlight();
                            },
                            touchend: function (ev) {
                                if (dragged !== name) return;
                                var touch = ev.changedTouches[0];
                                var target = touch && touchTarget(touch.clientY);
                                dragged = null;
                                clearDropHighlight();
                                if (target) reorder(name, target.name, target.below);
                            },
                            touchcancel: function () {
                                dragged = null;
                                clearDropHighlight();
                            },
                        },
                        ['\u2630'],
                    ),
                    E(
                        'button',
                        {
                            type: 'button',
                            class: 'btn cbi-button exit-route-auto-action',
                            disabled: i === 0 ? '' : null,
                            title: _('Move up'),
                            click: function (ev) {
                                ev.preventDefault();
                                var next = order.slice();
                                var tmp = next[i - 1];
                                next[i - 1] = next[i];
                                next[i] = tmp;
                                changeOrder(next);
                            },
                        },
                        ['\u2191'],
                    ),
                    E(
                        'button',
                        {
                            type: 'button',
                            class: 'btn cbi-button exit-route-auto-action',
                            disabled: i === order.length - 1 ? '' : null,
                            title: _('Move down'),
                            click: function (ev) {
                                ev.preventDefault();
                                var next = order.slice();
                                var tmp = next[i + 1];
                                next[i + 1] = next[i];
                                next[i] = tmp;
                                changeOrder(next);
                            },
                        },
                        ['\u2193'],
                    ),
                    E(
                        'button',
                        {
                            type: 'button',
                            class: 'btn cbi-button exit-route-auto-action',
                            disabled: order.length <= 1 ? '' : null,
                            title: _('Exclude from AUTO'),
                            'aria-label': _('Exclude from AUTO'),
                            click: function (ev) {
                                ev.preventDefault();
                                changeOrder(
                                    order.filter(function (s) {
                                        return s !== name;
                                    }),
                                );
                            },
                        },
                        ['\u00d7'],
                    ),
                ];
                return E(
                    'div',
                    {
                        'data-auto-exit': name,
                        dragover: function (ev) {
                            if (!dragged || dragged === name) return;
                            ev.preventDefault();
                            ev.dataTransfer.dropEffect = 'move';
                            var rect = ev.currentTarget.getBoundingClientRect();
                            indicateDrop(
                                ev.currentTarget,
                                ev.clientY >= rect.top + rect.height / 2,
                            );
                        },
                        dragleave: function (ev) {
                            if (!ev.currentTarget.contains(ev.relatedTarget)) clearDropHighlight();
                        },
                        drop: function (ev) {
                            if (!dragged) return;
                            ev.preventDefault();
                            var rect = ev.currentTarget.getBoundingClientRect();
                            var from = dragged;
                            dragged = null;
                            clearDropHighlight();
                            reorder(from, name, ev.clientY >= rect.top + rect.height / 2);
                        },
                        class: 'exit-route-auto-row',
                    },
                    [
                        E('div', { class: 'exit-route-auto-identity' }, [
                            healthIcon(state ? state.reachable : null),
                            E('strong', {}, [name]),
                        ]),
                        E('div', { class: 'exit-route-auto-actions' }, controls),
                    ],
                );
            });
            self.exitNames
                .filter(function (name) {
                    return order.indexOf(name) < 0;
                })
                .forEach(function (name) {
                    items.push(
                        E(
                            'div',
                            {
                                class: 'exit-route-auto-row exit-route-auto-row--excluded',
                            },
                            [
                                E('strong', {}, [name]),
                                E(
                                    'button',
                                    {
                                        type: 'button',
                                        class: 'btn cbi-button cbi-button-add',
                                        click: function (ev) {
                                            ev.preventDefault();
                                            changeOrder(order.concat([name]));
                                        },
                                    },
                                    [_('Add to AUTO')],
                                ),
                            ],
                        ),
                    );
                });
            dom.content(rows, items);
        }

        function refresh() {
            if (!isDevice) order = self.autoOrder.slice();
            dom.content(
                summary,
                order.map(function (name, i) {
                    var parts = [E('strong', {}, [name])];
                    if (i)
                        parts.unshift(
                            E('span', { class: 'exit-route-auto-summary-arrow' }, ['\u2192']),
                        );
                    return E('span', { class: 'exit-route-auto-summary-item' }, parts);
                }),
            );
            renderRows();
        }

        var content = [];
        if (isDevice) field._autoState = { order: order.slice() };
        content.push(summary);
        content.push(rows);
        content.push(
            E('p', { class: 'cbi-section-descr' }, [
                isDevice
                    ? _('Initially copied from global AUTO. This order belongs to this device.')
                    : _('The first reachable exit is chosen automatically.'),
            ]),
        );
        if (!isDevice) this.orderViews.push(refresh);
        refresh();
        return E('div', { class: 'exit-route-auto-editor' }, content);
    },

    render: function (data) {
        var self = this;
        this.exitNames = uci.sections('exit_route', 'exit').map(function (s) {
            return s['.name'];
        });
        this.autoOrder = this.effectiveAutoOrder();
        this.orderViews = [];
        this.exitState = data[1];
        this.serviceInfo = data[3];
        this.serviceBusy = false;
        this.stageTimer = null;
        this.stageRunning = false;
        this.stageAgain = false;
        this.stagePromise = Promise.resolve();
        this.serviceNode = E('div', { class: 'cbi-section' });
        this.exitStatusNode = E('div');
        this.dirty = false;
        this.dirtyNode = E(
            'p',
            {
                class: 'cbi-section-descr',
                style: 'display:none',
            },
            [_('Saving changes to pending UCI...')],
        );

        var hosts = hostAddresses(data[2]);
        var hostLabels = {};
        hosts.forEach(function (host) {
            hostLabels[host[0]] = host[1];
        });
        var m = new form.Map(
            'exit_route',
            _('Exit Route - Configuration'),
            _(
                'Configure IPv4 exit policies. Changes are staged automatically; routes change only after Save & Apply.',
            ),
        );
        this.formMap = m;
        var s, o;

        s = m.section(
            form.NamedSection,
            'main',
            'state',
            _('Global route'),
            _('Select a policy for clients without a device override.'),
        );
        s.anonymous = true;
        o = s.option(form.ListValue, 'mode', null);
        styleRoutingMode(o);
        o.rmempty = false;
        o.value('DIRECT', 'DIRECT');
        o.value('AUTO', 'AUTO');
        o.value('SPLIT_FAIL_OPEN', 'SPLIT_FAIL_OPEN');
        o.value('SPLIT_FAIL_CLOSED', 'SPLIT_FAIL_CLOSED');
        o.value('EXIT_FAIL_OPEN', 'EXIT_FAIL_OPEN');
        o.value('EXIT_FAIL_CLOSED', 'EXIT_FAIL_CLOSED');
        o.default = 'AUTO';
        o.onchange = function (ev, sectionId, value) {
            uci.set('exit_route', sectionId, 'mode', value);
            self.scheduleStage();
        };

        o = s.option(form.ListValue, 'exit', _('Exit server'));
        o.rmempty = false;
        o.depends('mode', 'SPLIT_FAIL_OPEN');
        o.depends('mode', 'SPLIT_FAIL_CLOSED');
        o.depends('mode', 'EXIT_FAIL_OPEN');
        o.depends('mode', 'EXIT_FAIL_CLOSED');
        this.exitNames.forEach(function (name) {
            o.value(name, name);
        });
        o.onchange = function (ev, sectionId, value) {
            uci.set('exit_route', sectionId, 'exit', value);
            self.scheduleStage();
        };

        o = s.option(form.DummyValue, '_auto_order', _('AUTO order'));
        o.depends('mode', 'AUTO');
        o.renderWidget = function () {
            return self.renderAutoOrderWidget();
        };

        s = m.section(
            form.NamedSection,
            'main',
            'state',
            _('Exit status'),
            _('Reachability is determined by Babel routes, not by an internet probe.'),
        );
        s.anonymous = true;
        o = s.option(form.DummyValue, '_exit_health', null);
        o.renderWidget = function () {
            return self.exitStatusNode;
        };

        s = m.section(
            form.GridSection,
            'device',
            _('Device routing'),
            _(
                'Per-device policies override the global policy. Add an IPv4 address to create an override.',
            ),
        );
        s.anonymous = true;
        s.addremove = true;
        s.nodescriptions = true;
        // GridSection uses an internal modal Map, not the page Save handler.
        // Refresh LuCI's native pending-change counter after modal actions.
        var nativeModalSave = s.handleModalSave;
        s.handleModalSave = function (modalMap, ev) {
            return Promise.resolve(nativeModalSave.call(this, modalMap, ev)).then(function () {
                return ui.changes.init();
            });
        };
        var nativeRemove = s.handleRemove;
        s.handleRemove = function (sectionId, ev) {
            return Promise.resolve(nativeRemove.call(this, sectionId, ev)).then(function () {
                return ui.changes.init();
            });
        };

        o = s.option(form.Value, 'ip', _('IPv4 address'));
        o.modalonly = true;
        o.rmempty = false;
        o.datatype = 'ip4addr';
        o.description = _('Choose a known device or enter an IPv4 address manually.');
        hosts.forEach(function (host) {
            o.value(host[0], host[1]);
        });
        o.validate = function (section_id, value) {
            if (!validIPv4(value)) return _('Enter a valid unicast IPv4 address.');
            var duplicates = this.map.data.sections('exit_route', 'device').some(function (d) {
                return d['.name'] !== section_id && d.ip === value;
            });
            return duplicates ? _('This IPv4 address already has a policy.') : true;
        };

        o = s.option(form.DummyValue, '_device', _('Device'));
        o.modalonly = false;
        o.cfgvalue = function (section_id) {
            var ip = this.map.data.get('exit_route', section_id, 'ip');
            return hostLabels[ip] || ip || '-';
        };

        o = s.option(form.DummyValue, '_policy', _('Routing policy'));
        o.modalonly = false;
        o.cfgvalue = function (section_id) {
            var mode = this.map.data.get('exit_route', section_id, 'mode');
            if (mode === 'AUTO') {
                var custom = asList(this.map.data.get('exit_route', section_id, 'auto_exit'));
                return 'AUTO';
            }
            return describePolicy(mode, this.map.data.get('exit_route', section_id, 'exit'));
        };

        // Disable only this device override; unchecked devices keep their policy.
        // The reconciler removes managed per-device firewall rules for disabled entries.
        o = s.option(form.Flag, 'disabled', _('Disable'));
        o.modalonly = false;
        o.editable = true;
        o.default = '0';
        o.enabled = '1';
        o.disabled = '0';
        o.rmempty = true;
        o.onchange = function (ev, sectionId, value) {
            uci.set('exit_route', sectionId, 'disabled', value === '1' ? '1' : null);
            self.scheduleStage();
        };

        o = s.option(form.ListValue, 'mode', null);
        o.modalonly = true;
        o.rmempty = false;
        styleRoutingMode(o);
        o.value('DEFAULT', _('Global'));
        o.value('DIRECT', 'DIRECT');
        o.value('AUTO', 'AUTO');
        o.value('SPLIT_FAIL_OPEN', 'SPLIT_FAIL_OPEN');
        o.value('SPLIT_FAIL_CLOSED', 'SPLIT_FAIL_CLOSED');
        o.value('EXIT_FAIL_OPEN', 'EXIT_FAIL_OPEN');
        o.value('EXIT_FAIL_CLOSED', 'EXIT_FAIL_CLOSED');
        o.default = 'DEFAULT';

        o = s.option(form.ListValue, 'exit', _('Exit server'));
        o.modalonly = true;
        o.rmempty = false;
        o.depends('mode', 'SPLIT_FAIL_OPEN');
        o.depends('mode', 'SPLIT_FAIL_CLOSED');
        o.depends('mode', 'EXIT_FAIL_OPEN');
        o.depends('mode', 'EXIT_FAIL_CLOSED');
        this.exitNames.forEach(function (name) {
            o.value(name, name);
        });

        o = s.option(form.Value, '_device_auto_order', _('AUTO order'));
        o.ucioption = 'auto_exit';
        o.modalonly = true;
        o.rmempty = false;
        o.retain = true;
        o.depends('mode', 'AUTO');
        o.renderWidget = function (section_id) {
            return self.renderAutoOrderWidget(section_id, this);
        };
        o.formvalue = function (section_id) {
            var state = this._autoState;
            if (!state) return asList(this.cfgvalue(section_id));
            return state.order.slice();
        };

        this.updateService(data[3]);
        this.updateExitStatus(data[1]);
        poll.add(this.refreshStatus.bind(this), 5);

        return m.render().then(function (node) {
            return E('div', {}, [
                E('link', { rel: 'stylesheet', href: L.resource('view/network/exit-route.css') }),
                E('h2', {}, [_('Exit Route - Status')]),
                self.serviceNode,
                node,
                self.dirtyNode,
            ]);
        });
    },

    // The native footer remains available for explicit Save & Apply.
    handleSave: function () {
        var self = this;
        return (this.stageRunning ? this.stagePromise : Promise.resolve())
            .then(function () {
                if (self.stageTimer != null) return self.stageNow();
                return null;
            })
            .then(function () {
                self.orderViews = [];
                return self.formMap.save();
            })
            .then(function () {
                self.autoOrder = self.effectiveAutoOrder();
                self.clearDirty();
                return ui.changes.init();
            });
    },

    handleReset: function () {
        var self = this;
        this.stageAgain = false;
        if (this.stageTimer != null) {
            window.clearTimeout(this.stageTimer);
            this.stageTimer = null;
        }
        // Reset restores the last staged UCI values, not committed config.
        // To discard already staged changes use LuCI's "Unsaved Changes" menu.
        return this.stagePromise
            .catch(function () {})
            .then(function () {
                // A running stage may have queued a newer debounce.
                if (self.stageTimer != null) {
                    window.clearTimeout(self.stageTimer);
                    self.stageTimer = null;
                }
                uci.unload('exit_route');
                return uci.load('exit_route');
            })
            .then(function () {
                self.autoOrder = self.effectiveAutoOrder();
                self.orderViews = [];
                self.updateExitStatus(self.exitState);
                return self.formMap.load();
            })
            .then(function () {
                return self.formMap.reset();
            })
            .then(function () {
                self.clearDirty();
            });
    },

    handleServiceAction: function (action) {
        var self = this;
        this.serviceBusy = true;
        this.updateService(this.serviceInfo);
        return fs
            .exec(initScript, [action])
            .then(function (result) {
                if (result.code !== 0)
                    throw new Error((result.stderr || result.stdout || _('Command failed')).trim());
            })
            .catch(function (err) {
                ui.addNotification(null, E('p', {}, [err.message]), 'danger');
            })
            .then(function () {
                return self.refreshStatus();
            })
            .finally(function () {
                self.serviceBusy = false;
                self.updateService(self.serviceInfo);
            });
    },

    updateService: function (state) {
        this.serviceInfo = state;
        var self = this;
        var control = [
            {
                action: 'start',
                caption: _('Start'),
                cls: 'positive',
                disabled: state.running !== false,
            },
            {
                action: 'restart',
                caption: _('Restart'),
                cls: 'action',
                disabled: state.running !== true,
            },
            {
                action: 'stop',
                caption: _('Stop'),
                cls: 'negative',
                disabled: state.running !== true,
            },
            {
                action: 'enable',
                caption: _('Enable'),
                cls: 'positive',
                disabled: state.enabled !== false,
            },
            {
                action: 'disable',
                caption: _('Disable'),
                cls: 'negative',
                disabled: state.enabled !== true,
            },
        ];
        var apply = this.exitState || {};
        var mode = apply.error ? _('Unknown') : describePolicy(apply.MODE, apply.SELECTED);
        var route = apply.error ? _('Unknown') : activeRoute(apply);
        var summary = [
            E('div', {}, [
                E('strong', {}, [stateLabel(state.running, _('Running.'), _('Stopped.'))]),
                ' ',
                stateLabel(state.enabled, _('Autostart is enabled.'), _('Autostart is disabled.')),
            ]),
            E('div', {}, [
                _('Configured mode') + ': ',
                E('strong', {}, [mode]),
                ' \u00b7 ',
                _('Last known route') + ': ',
                E('strong', {}, [route]),
            ]),
        ];
        if (apply.APPLY === 'ERROR' && apply.ERROR && apply.ERROR !== 'none')
            summary.push(E('div', { class: 'alert-message warning' }, [apply.ERROR]));
        var content = [
            cbiRow(_('Exit Route'), summary),
            cbiRow(_('Service control'), [
                E('div', { class: 'exit-route-service-controls' }, [
                    E(
                        'div',
                        { class: 'exit-route-service-group' },
                        control.slice(0, 3).map(function (c) {
                            return E(
                                'button',
                                {
                                    type: 'button',
                                    class: 'btn cbi-button cbi-button-' + c.cls,
                                    disabled: self.serviceBusy || c.disabled ? '' : null,
                                    click: ui.createHandlerFn(
                                        self,
                                        'handleServiceAction',
                                        c.action,
                                    ),
                                },
                                [c.caption],
                            );
                        }),
                    ),
                    E(
                        'div',
                        { class: 'exit-route-service-group exit-route-service-group--boot' },
                        control.slice(3).map(function (c) {
                            return E(
                                'button',
                                {
                                    type: 'button',
                                    class: 'btn cbi-button cbi-button-' + c.cls,
                                    disabled: self.serviceBusy || c.disabled ? '' : null,
                                    click: ui.createHandlerFn(
                                        self,
                                        'handleServiceAction',
                                        c.action,
                                    ),
                                },
                                [c.caption],
                            );
                        }),
                    ),
                ]),
            ]),
        ];
        dom.content(this.serviceNode, content);
    },

    updateExitStatus: function (state) {
        this.exitState = state;
        if (state.error) {
            dom.content(this.exitStatusNode, [
                E('p', { class: 'cbi-section-descr' }, [state.error]),
            ]);
            return;
        }
        var byName = {};
        state.exits.forEach(function (e) {
            byName[e.name] = e;
        });
        var order = this.autoOrder.concat(
            this.exitNames.filter(function (name) {
                return this.autoOrder.indexOf(name) < 0;
            }, this),
        );
        var tiles = order.map(function (name) {
            var entry = byName[name];
            var reachable = entry ? entry.reachable : null;
            var caption = !entry ? _('Unknown') : reachable ? _('Available') : _('Unavailable');
            var color = !entry ? '#777' : reachable ? '#2e9d51' : '#dc3545';
            var details = [];
            if (reachable && entry.hop && entry.hop.device) {
                details.push(
                    E('div', { class: 'exit-route-status-interface' }, [
                        _('Interface') + ': ' + entry.hop.device,
                    ]),
                );
            }
            return E('div', { class: 'exit-route-status-tile' }, [
                healthIcon(reachable),
                E(
                    'div',
                    { class: 'exit-route-status-detail' },
                    [
                        E('strong', {}, [name]),
                        E('div', { class: 'exit-route-status-text', style: 'color:' + color }, [
                            caption,
                        ]),
                    ].concat(details),
                ),
            ]);
        });
        dom.content(this.exitStatusNode, [E('div', { class: 'exit-route-status-grid' }, tiles)]);
    },

    refreshStatus: function () {
        var self = this;
        return Promise.all([
            status().catch(function (err) {
                return { exits: [], error: err.message };
            }),
            serviceState(),
        ]).then(function (result) {
            self.updateExitStatus(result[0]);
            self.updateService(result[1]);
        });
    },
});
