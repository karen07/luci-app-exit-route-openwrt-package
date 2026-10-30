'use strict';
'require view';
'require fs';
'require dom';
'require poll';
'require ui';

var script = '/etc/scripts/exit-route.sh';

function run(args) {
    return fs.exec(script, args).then(function (result) {
        if (result.code !== 0)
            throw new Error((result.stderr || result.stdout || _('Command failed')).trim());
        return result.stdout || '';
    });
}

function parseStatus(text) {
    var state = { exits: [] };
    text.split(/\r?\n/).forEach(function (line) {
        if (line.indexOf('EXIT\t') === 0) {
            var columns = line.split('\t');
            if (columns.length === 5)
                state.exits.push({
                    name: columns[1],
                    reachable: columns[2] === '1',
                    tunnel: columns[3],
                    via: columns[4],
                });
        } else {
            var pos = line.indexOf('=');
            if (pos >= 0) state[line.slice(0, pos)] = line.slice(pos + 1);
        }
    });
    return state;
}

function parseDevices(text) {
    var byIP = {},
        leases = {};
    text.split(/\r?\n/).forEach(function (line) {
        var columns = line.split('\t');
        if (columns[0] === 'DEVICE' && columns.length === 5) {
            var ip = columns[1];
            if (!byIP[ip]) byIP[ip] = { ip: ip, base: null, override: null };
            var value = { mode: columns[2], exit: columns[3] };
            if (columns[4] === 'BASE') byIP[ip].base = value;
            else if (columns[4] === 'OVERRIDE') byIP[ip].override = value;
        } else if (columns[0] === 'LEASE' && columns.length === 3) {
            leases[columns[1]] = columns[2] === '-' ? '' : columns[2];
        }
    });
    Object.keys(leases).forEach(function (ip) {
        if (!byIP[ip]) byIP[ip] = { ip: ip, base: null, override: null };
    });
    return Object.keys(byIP)
        .sort(function (a, b) {
            var x = a.split('.').map(Number),
                y = b.split('.').map(Number);
            for (var i = 0; i < 4; i++) {
                if (x[i] !== y[i]) return x[i] - y[i];
            }
            return 0;
        })
        .map(function (ip) {
            byIP[ip].hostname = leases[ip] || '';
            return byIP[ip];
        });
}

function validIPv4(ip) {
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

function policyID(policy) {
    if (!policy || policy.mode === 'default') return 'default';
    if (policy.mode === 'wan') return 'wan';
    return policy.mode + ':' + policy.exit;
}

function choices(exits) {
    var opts = [
        { id: 'default', label: _('Use global route') },
        { id: 'wan', label: 'WAN' },
    ];
    exits.forEach(function (e) {
        opts.push({ id: 'exit:' + e.name, label: e.name });
    });
    exits.forEach(function (e) {
        opts.push({ id: 'split:' + e.name, label: _('Split via %s').format(e.name) });
    });
    return opts;
}

function routeSelect(options, value, handler) {
    var el = E(
        'select',
        {
            class: 'cbi-input-select',
            style: 'max-width: 15em; width: 100%;',
            change: function (ev) {
                handler(ev.target.value);
            },
        },
        options.map(function (option) {
            return E('option', { value: option.id }, [option.label]);
        }),
    );
    el.value = value;
    return el;
}

function field(name, value) {
    return E(
        'div',
        { style: 'display:flex;justify-content:space-between;gap:1em;margin:0.4em 0;' },
        [E('span', { style: 'opacity:.75;' }, [name]), E('strong', {}, [value || '-'])],
    );
}

function card(title, state, items, selected, tone) {
    var children = [
        E('div', { style: 'display:flex;justify-content:space-between;gap:.5em;' }, [
            E('strong', {}, [title]),
            selected ? E('span', { class: 'label' }, [_('Active')]) : E('span'),
        ]),
        E(
            'p',
            {
                style:
                    'margin:.7em 0;color:' +
                    (tone === 'bad' ? '#c43636' : tone === 'good' ? '#18994c' : 'inherit'),
            },
            [state],
        ),
        E('hr'),
    ];
    items.forEach(function (item) {
        children.push(field(item[0], item[1]));
    });
    return E(
        'div',
        {
            style:
                'flex:1 1 12em;min-width:12em;' +
                'border:1px solid var(--border-color-medium, #ccc);' +
                'border-radius:8px;padding:1em;',
        },
        children,
    );
}

return view.extend({
    load: function () {
        return Promise.all([run(['status']), run(['device-list'])]).then(function (result) {
            return { state: parseStatus(result[0]), devices: parseDevices(result[1]) };
        });
    },

    render: function (data) {
        this.state = data.state;
        this.devices = data.devices;
        this.busy = false;
        this.refreshError = false;
        this.globalNode = E('div');
        this.statusNode = E('div');
        this.autoNode = E('div');
        this.autoDraft = null;
        this.autoEditing = false;
        this.autoDrag = null;
        this.devicesNode = E('div');
        this.serviceNode = E('span');
        this.ipInput = E('input', {
            class: 'cbi-input-text',
            type: 'text',
            placeholder: '10.101.1.77',
            style: 'width:100%;max-width:18em;',
        });
        this.newRouteNode = E('div');
        this.updateAll();
        var self = this;
        var body = E('div', {}, [
            E(
                'div',
                {
                    style:
                        'display:flex;justify-content:space-between;' +
                        'align-items:center;gap:1em;',
                },
                [E('h2', {}, [_('Exit Route')]), this.serviceNode],
            ),
            E('div', { class: 'cbi-section' }, [
                E('h3', {}, [_('Global route')]),
                E('p', { class: 'cbi-section-descr' }, [
                    _('Select the default exit for traffic without device-specific rules.'),
                ]),
                this.globalNode,
            ]),
            E('div', { class: 'cbi-section' }, [
                E('h3', {}, [_('AUTO priorities')]),
                E('p', { class: 'cbi-section-descr' }, [
                    _('Drag exits within or between lists to set AUTO priorities.'),
                ]),
                this.autoNode,
            ]),
            E('div', { class: 'cbi-section' }, [
                E('h3', {}, [_('Exit status')]),
                this.statusNode,
                E('small', {}, [
                    _('Exits use Babel routes; WAN uses the main default route, not a ping.'),
                ]),
            ]),
            E('div', { class: 'cbi-section' }, [
                E('h3', {}, [_('Device routing')]),
                E('p', { class: 'cbi-section-descr' }, [
                    _('Override routing for IPv4 devices. Changes apply immediately.'),
                ]),
                this.devicesNode,
                E(
                    'fieldset',
                    {
                        class: 'cbi-section',
                        style: 'margin-top:1.5em;padding:1em;',
                    },
                    [
                        E('legend', {}, [_('Add device')]),
                        E(
                            'div',
                            { style: 'display:flex;flex-wrap:wrap;gap:1em;align-items:end;' },
                            [
                                E('label', {}, [E('div', {}, [_('IPv4 address')]), this.ipInput]),
                                E('label', {}, [E('div', {}, [_('Route')]), this.newRouteNode]),
                                E(
                                    'button',
                                    {
                                        type: 'button',
                                        class: 'btn btn-primary',
                                        click: function () {
                                            return self.addDevice();
                                        },
                                    },
                                    [_('Add device')],
                                ),
                            ],
                        ),
                    ],
                ),
            ]),
        ]);
        poll.add(this.refresh.bind(this), 5);
        return body;
    },

    updateAll: function () {
        var self = this;
        var state = this.state;
        var mode = state.MODE || 'AUTO';
        var active = state.ACTIVE === 'DISABLED' ? 'WAN' : state.ACTIVE || 'ABSENT';
        dom.content(this.serviceNode, [
            state.SERVICE === 'RUNNING' ? _('Service running') : _('Service stopped'),
        ]);
        var manualOptions = [E('option', { value: '' }, [_('Select exit...')])];
        state.exits.forEach(function (exit) {
            manualOptions.push(E('option', { value: exit.name }, [exit.name]));
        });
        var manualSelect = E(
            'select',
            {
                class: 'cbi-input-select',
                style: 'max-width: 16em;',
                disabled: self.busy,
                change: function (ev) {
                    if (ev.target.value) return self.setGlobal(ev.target.value);
                },
            },
            manualOptions,
        );
        manualSelect.value = state.exits.some(function (exit) {
            return exit.name === mode;
        })
            ? mode
            : '';
        var globalParts = [
            E('div', { style: 'display:flex;flex-wrap:wrap;gap:.5em;align-items:center;' }, [
                E(
                    'button',
                    {
                        type: 'button',
                        class: 'btn' + (mode === 'AUTO' ? ' btn-primary' : ''),
                        disabled: self.busy,
                        click: function () {
                            return self.setGlobal('AUTO');
                        },
                    },
                    [_('Auto')],
                ),
                E(
                    'button',
                    {
                        type: 'button',
                        class: 'btn' + (mode === 'WAN' ? ' btn-primary' : ''),
                        disabled: self.busy,
                        click: function () {
                            return self.setGlobal('WAN');
                        },
                    },
                    ['WAN'],
                ),
                manualSelect,
            ]),
        ];
        globalParts.push(
            E(
                'div',
                {
                    style:
                        'margin-top:1em;padding:1em;' +
                        'background:var(--background-color-high, #f3f3f3);border-radius:6px;',
                },
                [
                    field(_('Selected mode'), mode === 'AUTO' ? _('Auto') : mode),
                    field(_('Active route'), active),
                    E('small', {}, [
                        mode === 'AUTO'
                            ? _('Automatically selected according to exit priority.')
                            : mode === 'WAN'
                              ? _('Direct routing through the main routing table.')
                              : active !== mode
                                ? _(
                                      'The selected exit is unreachable; the global exit route is disabled.',
                                  )
                                : _('Manual override enabled.'),
                    ]),
                ],
            ),
        );
        dom.content(this.globalNode, globalParts);
        var exitCards = state.exits.map(function (e) {
            return card(
                e.name,
                e.reachable ? _('Reachable') : _('Unreachable'),
                [
                    [_('Tunnel'), e.tunnel],
                    [_('Via interface'), e.via === '-' ? '-' : e.via],
                ],
                active === e.name,
                e.reachable ? 'good' : 'bad',
            );
        });
        var wanLabel =
            state.WAN_STATUS === 'ROUTE_AVAILABLE'
                ? _('Route available')
                : state.WAN_STATUS === 'NO_ROUTE'
                  ? _('No route')
                  : _('Unknown');
        exitCards.push(
            card(
                'WAN',
                wanLabel,
                [
                    [
                        _('Interface'),
                        state.WAN_IFACE && state.WAN_IFACE !== '-' ? state.WAN_IFACE : '-',
                    ],
                    [_('Routing table'), 'main'],
                ],
                active === 'WAN',
                state.WAN_STATUS === 'ROUTE_AVAILABLE'
                    ? 'good'
                    : state.WAN_STATUS === 'NO_ROUTE'
                      ? 'bad'
                      : 'neutral',
            ),
        );
        dom.content(
            this.statusNode,
            E('div', { style: 'display:flex;flex-wrap:wrap;gap:.8em;margin:1em 0;' }, exitCards),
        );
        this.renderDevices();
        if (!this.autoDrag) this.renderAuto();
    },

    autoOrders: function () {
        var names = this.state.exits.map(function (e) {
            return e.name;
        });
        var defaultOrder = (this.state.AUTO_DEFAULT || '').split(/\s+/).filter(Boolean);
        var saved = (this.state.AUTO_EFFECTIVE || '').split(/\s+/).filter(Boolean);
        var valid = function (list) {
            return list.filter(function (name, i) {
                return names.indexOf(name) !== -1 && list.indexOf(name) === i;
            });
        };
        defaultOrder = valid(defaultOrder);
        saved = valid(saved);
        if (!saved.length) saved = defaultOrder.slice();
        if (!this.autoEditing || !this.autoDraft) this.autoDraft = saved.slice();
        return { names: names, defaults: defaultOrder, saved: saved };
    },

    moveAuto: function (name, zone, target, after) {
        var data = this.autoOrders();
        if (data.names.indexOf(name) < 0) return;
        var next = this.autoDraft.filter(function (n) {
            return n !== name;
        });
        if (zone === 'enabled') {
            var index = target ? next.indexOf(target) : -1;
            if (index < 0) index = next.length;
            else if (after) index++;
            next.splice(index, 0, name);
        } else if (!next.length) {
            ui.addNotification(null, E('p', {}, [_('Keep at least one exit in AUTO.')]), 'warning');
            return;
        }
        this.autoDraft = next;
        this.autoEditing = true;
        this.renderAuto();
    },

    renderAuto: function () {
        var self = this;
        var data = this.autoOrders();
        var equal = JSON.stringify(this.autoDraft) === JSON.stringify(data.saved);
        var reachable = {};
        this.state.exits.forEach(function (e) {
            reachable[e.name] = e.reachable;
        });

        function row(name, index, enabled) {
            var handle = E(
                'button',
                {
                    type: 'button',
                    class: 'btn',
                    style: 'cursor:grab;touch-action:none;padding:.3em .6em;',
                    title: _('Drag to reorder. Use arrow keys or Enter as an alternative.'),
                    'aria-label': _('Move exit %s').format(name),
                    keydown: function (event) {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            self.moveAuto(name, enabled ? 'disabled' : 'enabled');
                        } else if (
                            enabled &&
                            (event.key === 'ArrowUp' || event.key === 'ArrowDown')
                        ) {
                            event.preventDefault();
                            var idx = self.autoDraft.indexOf(name);
                            var delta = event.key === 'ArrowUp' ? -1 : 1;
                            var other = self.autoDraft[idx + delta];
                            if (!other) return;
                            self.moveAuto(name, 'enabled', other, delta > 0);
                        }
                    },
                    pointerdown: function (event) {
                        if (event.button !== 0 && event.pointerType === 'mouse') return;
                        self.autoDrag = {
                            name: name,
                            id: event.pointerId,
                            x: event.clientX,
                            y: event.clientY,
                            started: false,
                            row: event.currentTarget.parentNode,
                        };
                        event.currentTarget.setPointerCapture(event.pointerId);
                        event.preventDefault();
                    },
                    pointermove: function (event) {
                        var drag = self.autoDrag;
                        if (!drag || event.pointerId !== drag.id) return;
                        if (
                            !drag.started &&
                            Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5
                        )
                            return;
                        drag.started = true;
                        drag.row.style.opacity = '.55';
                        var element = document.elementFromPoint(event.clientX, event.clientY);
                        var hit = element && element.closest('[data-auto-zone]');
                        self.autoNode.querySelectorAll('[data-auto-zone]').forEach(function (zone) {
                            zone.style.outline = '';
                        });
                        if (hit && self.autoNode.contains(hit)) {
                            drag.hit = hit;
                            hit.style.outline = '2px dashed var(--primary-color-medium, #287cbb)';
                        } else {
                            drag.hit = null;
                        }
                    },
                    pointerup: function (event) {
                        var drag = self.autoDrag;
                        if (!drag || drag.id !== event.pointerId) return;
                        self.autoDrag = null;
                        if (drag.row) drag.row.style.opacity = '';
                        var element = document.elementFromPoint(event.clientX, event.clientY);
                        var list = element && element.closest('[data-auto-zone]');
                        if (list && self.autoNode.contains(list) && drag.started) {
                            var targetRow = element.closest('[data-auto-name]');
                            var target = targetRow && targetRow.getAttribute('data-auto-name');
                            var after = false;
                            if (targetRow) {
                                var rect = targetRow.getBoundingClientRect();
                                after = event.clientY >= rect.top + rect.height / 2;
                            }
                            self.moveAuto(name, list.getAttribute('data-auto-zone'), target, after);
                        } else self.renderAuto();
                    },
                    pointercancel: function () {
                        self.autoDrag = null;
                        self.renderAuto();
                    },
                },
                ['\u283f'],
            );
            return E(
                'div',
                {
                    'data-auto-name': name,
                    style:
                        'display:flex;align-items:center;gap:.7em;margin:.4em 0;' +
                        'padding:.6em;border:1px solid var(--border-color-medium, #ccc);' +
                        'border-radius:6px;',
                },
                [
                    handle,
                    E('span', { style: 'min-width:1.7em;' }, [enabled ? String(index + 1) : '-']),
                    E('strong', { style: 'flex:1;' }, [name]),
                    E('small', {}, [reachable[name] ? _('Reachable') : _('Unreachable')]),
                ],
            );
        }
        function zone(title, list, enabled) {
            return E('div', { style: 'margin-top:1em;' }, [
                E('strong', {}, [title]),
                E(
                    'div',
                    {
                        'data-auto-zone': enabled ? 'enabled' : 'disabled',
                        style:
                            'min-height:3em;border:1px dashed var(--border-color-medium, #ccc);' +
                            'padding:.4em;border-radius:6px;margin-top:.5em;',
                    },
                    list.map(function (name, index) {
                        return row(name, index, enabled);
                    }),
                ),
            ]);
        }
        var unused = data.names.filter(function (name) {
            return self.autoDraft.indexOf(name) < 0;
        });
        var controls = E(
            'div',
            {
                style:
                    'display:flex;flex-wrap:wrap;justify-content:space-between;' +
                    'gap:.5em;margin-top:1em;',
            },
            [
                E(
                    'button',
                    {
                        type: 'button',
                        class: 'btn',
                        disabled: this.busy,
                        click: function () {
                            return self.resetAuto();
                        },
                    },
                    [_('Restore deployment priorities')],
                ),
                E('span', { style: 'display:flex;gap:.5em;flex-wrap:wrap;' }, [
                    E(
                        'button',
                        {
                            type: 'button',
                            class: 'btn',
                            disabled: equal || this.busy,
                            click: function () {
                                self.autoDraft = data.saved.slice();
                                self.autoEditing = false;
                                self.renderAuto();
                            },
                        },
                        [_('Cancel')],
                    ),
                    E(
                        'button',
                        {
                            type: 'button',
                            class: 'btn btn-primary',
                            disabled: equal || this.busy,
                            click: function () {
                                return self.saveAuto();
                            },
                        },
                        [_('Save and apply')],
                    ),
                ]),
            ],
        );
        dom.content(this.autoNode, [
            zone(_('In AUTO (top priority first)'), this.autoDraft, true),
            zone(_('Not in AUTO (manual selection remains available)'), unused, false),
            controls,
            E('small', {}, [equal ? _('Priorities are saved.') : _('Unsaved AUTO changes.')]),
        ]);
    },

    saveAuto: function () {
        var self = this;
        var order = this.autoDraft.slice();
        if (!order.length) return Promise.resolve();
        return this.change(['auto-set'].concat(order)).then(function (ok) {
            if (ok) self.autoEditing = false;
            self.renderAuto();
        });
    },

    resetAuto: function () {
        var self = this;
        return this.change(['auto-reset']).then(function (ok) {
            if (ok) self.autoEditing = false;
            self.renderAuto();
        });
    },

    renderDevices: function () {
        var self = this;
        var opts = choices(this.state.exits);
        var table = E('table', { class: 'table', style: 'width:100%;' }, [
            E('tr', {}, [
                E('th', {}, [_('Device / IP')]),
                E('th', {}, [_('Route')]),
                E('th', {}, [_('Action')]),
            ]),
        ]);
        this.devices.forEach(function (device) {
            var effective = device.override || device.base;
            var selected = policyID(effective);
            var select = routeSelect(opts, selected, function (value) {
                return self.setDevice(device, value);
            });
            select.disabled = self.busy;
            var action = device.override
                ? E(
                      'button',
                      {
                          type: 'button',
                          class: 'btn',
                          disabled: self.busy,
                          title: _('Restore deployment rule'),
                          click: function () {
                              return self.removeOverride(device);
                          },
                      },
                      [_('Restore')],
                  )
                : E('small', {}, [device.base ? _('Deployment') : '-']);
            table.appendChild(
                E('tr', {}, [
                    E('td', {}, [
                        E('strong', {}, [device.hostname || _('Device')]),
                        E('div', {}, [device.ip]),
                    ]),
                    E('td', {}, [select]),
                    E('td', {}, [action]),
                ]),
            );
        });
        if (!this.devices.length)
            table.appendChild(
                E('tr', {}, [
                    E('td', { colspan: 3 }, [_('No devices found. Add an IPv4 address below.')]),
                ]),
            );
        dom.content(this.devicesNode, table);
        var addOptions = opts.filter(function (option) {
            return option.id !== 'default';
        });
        var previous = this.newRouteValue || 'exit:' + (this.state.exits[0] || {}).name;
        var select = routeSelect(addOptions, previous, function (value) {
            self.newRouteValue = value;
        });
        if (
            !addOptions.some(function (option) {
                return option.id === previous;
            })
        )
            previous = addOptions[0] ? addOptions[0].id : 'wan';
        select.value = previous;
        this.newRouteValue = previous;
        dom.content(this.newRouteNode, select);
    },

    refresh: function () {
        var self = this;
        if (this.busy) return Promise.resolve();
        return Promise.all([run(['status']), run(['device-list'])])
            .then(function (result) {
                self.state = parseStatus(result[0]);
                self.devices = parseDevices(result[1]);
                self.refreshError = false;
                self.updateAll();
            })
            .catch(function (err) {
                // Polling happens every five seconds; avoid unbounded notifications.
                if (!self.refreshError)
                    ui.addNotification(null, E('p', {}, [err.message]), 'danger');
                self.refreshError = true;
            });
    },

    change: function (args) {
        var self = this;
        if (this.busy) return Promise.resolve(false);
        this.busy = true;
        return run(args)
            .then(function () {
                self.busy = false;
                return self.refresh().then(function () {
                    return true;
                });
            })
            .catch(function (err) {
                self.busy = false;
                ui.addNotification(null, E('p', {}, [err.message]), 'danger');
                return self.refresh().then(function () {
                    return false;
                });
            });
    },

    setGlobal: function (mode) {
        return this.change(['set', mode]);
    },

    setDevice: function (device, value) {
        if (!value) return Promise.resolve();
        if (value === policyID(device.override || device.base)) return Promise.resolve();
        var pieces = value.split(':');
        if (value === 'default' && !device.base) return this.change(['device-del', device.ip]);
        return this.change(['device-set', device.ip, pieces[0], pieces[1] || '-']);
    },

    removeOverride: function (device) {
        return this.change(['device-del', device.ip]);
    },

    addDevice: function () {
        var ip = this.ipInput.value.trim();
        if (!validIPv4(ip)) {
            ui.addNotification(
                null,
                E('p', {}, [_('Enter a valid unicast IPv4 address.')]),
                'warning',
            );
            return Promise.resolve();
        }
        var parts = (this.newRouteValue || 'wan').split(':');
        var self = this;
        return this.change(['device-set', ip, parts[0], parts[1] || '-']).then(function (ok) {
            if (ok) self.ipInput.value = '';
        });
    },

    handleSave: null,
    handleSaveApply: null,
    handleReset: null,
});
