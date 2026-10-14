'use strict';
'require view';
'require fs';
'require dom';
'require poll';
'require ui';

var script = '/etc/scripts/exit-route.sh';

function run(args) {
    return fs.exec(script, args).then(function(result) {
        if (result.code !== 0)
            throw new Error((result.stderr || result.stdout || _('Command failed')).trim());
        return result.stdout || '';
    });
}

function parseStatus(text) {
    var state = {exits : []};
    text.split(/\r?\n/).forEach(function(line) {
        if (line.indexOf('EXIT\t') === 0) {
            var columns = line.split('\t');
            if (columns.length === 5)
                state.exits.push({
                    name : columns[1],
                    reachable : columns[2] === '1',
                    tunnel : columns[3],
                    via : columns[4]
                });
        } else {
            var pos = line.indexOf('=');
            if (pos >= 0)
                state[line.slice(0, pos)] = line.slice(pos + 1);
        }
    });
    return state;
}

function parseDevices(text) {
    var byIP = {}, leases = {};
    text.split(/\r?\n/).forEach(function(line) {
        var columns = line.split('\t');
        if (columns[0] === 'DEVICE' && columns.length === 5) {
            var ip = columns[1];
            if (!byIP[ip])
                byIP[ip] = {ip : ip, base : null, override : null};
            var value = {mode : columns[2], exit : columns[3]};
            if (columns[4] === 'BASE')
                byIP[ip].base = value;
            else if (columns[4] === 'OVERRIDE')
                byIP[ip].override = value;
        } else if (columns[0] === 'LEASE' && columns.length === 3) {
            leases[columns[1]] = columns[2] === '-' ? '' : columns[2];
        }
    });
    Object.keys(leases).forEach(function(ip) {
        if (!byIP[ip])
            byIP[ip] = {ip : ip, base : null, override : null};
    });
    return Object.keys(byIP)
        .sort(function(a, b) {
            var x = a.split('.').map(Number), y = b.split('.').map(Number);
            for (var i = 0; i < 4; i++) {
                if (x[i] !== y[i])
                    return x[i] - y[i];
            }
            return 0;
        })
        .map(function(ip) {
            byIP[ip].hostname = leases[ip] || '';
            return byIP[ip];
        });
}

function validIPv4(ip) {
    var parts = ip.split('.');
    return parts.length === 4 &&
           parts.every(function(
               part) { return /^(0|[1-9][0-9]{0,2})$/.test(part) && +part <= 255; }) &&
           +parts[0] > 0 && +parts[0] !== 127 && +parts[0] < 224;
}

function policyID(policy) {
    if (!policy || policy.mode === 'default')
        return 'default';
    if (policy.mode === 'wan')
        return 'wan';
    return policy.mode + ':' + policy.exit;
}

function choices(exits) {
    var opts = [ {id : 'default', label : _('Use global route')}, {id : 'wan', label : 'WAN'} ];
    exits.forEach(function(e) { opts.push({id : 'exit:' + e.name, label : e.name}); });
    exits.forEach(function(
        e) { opts.push({id : 'split:' + e.name, label : _('Split via %s').format(e.name)}); });
    return opts;
}

function routeSelect(options, value, handler) {
    var el = E('select', {
        'class' : 'cbi-input-select',
        'style' : 'max-width: 15em; width: 100%;',
        'change' : function(ev) { handler(ev.target.value); }
    },
               options.map(function(
                   option) { return E('option', {'value' : option.id}, [ option.label ]); }));
    el.value = value;
    return el;
}

function field(name, value) {
    return E(
        'div', {'style' : 'display:flex;justify-content:space-between;gap:1em;margin:0.4em 0;'},
        [ E('span', {'style' : 'opacity:.75;'}, [ name ]), E('strong', {}, [ value || '-' ]) ]);
}

function card(title, state, items, selected, tone) {
    var children = [
        E('div', {'style' : 'display:flex;justify-content:space-between;gap:.5em;'},
          [
              E('strong', {}, [ title ]),
              selected ? E('span', {'class' : 'label'}, [ _('Active') ]) : E('span')
          ]),
        E('p', {
            'style' : 'margin:.7em 0;color:' + (tone === 'bad'    ? '#c43636'
                                                : tone === 'good' ? '#18994c'
                                                                  : 'inherit')
        },
          [ state ]),
        E('hr')
    ];
    items.forEach(function(item) { children.push(field(item[0], item[1])); });
    return E('div', {
        'style' : 'flex:1 1 12em;min-width:12em;' +
                      'border:1px solid var(--border-color-medium, #ccc);' +
                      'border-radius:8px;padding:1em;'
    },
             children);
}

return view.extend({
    load : function() {
        return Promise.all([ run([ 'status' ]), run([ 'device-list' ]) ]).then(function(result) {
            return {state : parseStatus(result[0]), devices : parseDevices(result[1])};
        });
    },

    render : function(data) {
        this.state = data.state;
        this.devices = data.devices;
        this.busy = false;
        this.globalNode = E('div');
        this.statusNode = E('div');
        this.devicesNode = E('div');
        this.serviceNode = E('span');
        this.ipInput = E('input', {
            'class' : 'cbi-input-text',
            'type' : 'text',
            'placeholder' : '10.101.1.77',
            'style' : 'width:100%;max-width:18em;'
        });
        this.newRouteNode = E('div');
        this.updateAll();
        var self = this;
        var body = E('div', {}, [
            E('div', {
                'style': 'display:flex;justify-content:space-between;' +
                    'align-items:center;gap:1em;'
            }, [
                E('h2', {}, [_('Exit Route')]), this.serviceNode
            ]),
            E('div', { 'class': 'cbi-section' }, [
                E('h3', {}, [_('Global route')]),
                E('p', { 'class': 'cbi-section-descr' }, [
                    _('Select the default exit for traffic without device-specific rules.')
                ]),
                this.globalNode
            ]),
            E('div', { 'class': 'cbi-section' }, [
                E('h3', {}, [_('Exit status')]), this.statusNode,
                E('small', {}, [
                    _('Exits use Babel routes; WAN uses the main default route, not a ping.')
                ])
            ]),
            E('div', { 'class': 'cbi-section' }, [
                E('h3', {}, [_('Device routing')]),
                E('p', { 'class': 'cbi-section-descr' }, [
                    _('Override routing for IPv4 devices. Changes apply immediately.')
                ]),
                this.devicesNode,
                E('fieldset', {
                    'class': 'cbi-section', 'style': 'margin-top:1.5em;padding:1em;'
                }, [
                    E('legend', {}, [_('Add device')]),
                    E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:1em;align-items:end;' }, [
                        E('label', {}, [E('div', {}, [_('IPv4 address')]), this.ipInput]),
                        E('label', {}, [E('div', {}, [_('Route')]), this.newRouteNode]),
                        E('button', { 'type': 'button', 'class': 'btn btn-primary',
                            'click': function() { return self.addDevice(); }
                        }, [_('Add device')])
                    ])
                ])
            ])
        ]);
        poll.add(this.refresh.bind(this), 5);
        return body;
    },

    updateAll : function() {
        var self = this;
        var state = this.state;
        var mode = state.MODE || 'AUTO';
        var active = state.ACTIVE === 'DISABLED' ? 'WAN' : state.ACTIVE || 'ABSENT';
        dom.content(this.serviceNode,
                    [ state.SERVICE === 'RUNNING' ? _('Service running') : _('Service stopped') ]);
        var globalButtons =
            [ 'AUTO' ].concat(state.exits.map(function(e) { return e.name; }), [ 'WAN' ]);
        var globalParts = [ E('div', {'style' : 'display:flex;flex-wrap:wrap;gap:.5em;'},
                              globalButtons.map(function(value) {
                                  return E('button', {
                                      'type' : 'button',
                                      'class' : 'btn' + (value === mode ? ' btn-primary' : ''),
                                      'disabled' : self.busy,
                                      'click' : function() { return self.setGlobal(value); }
                                  },
                                           [ value === 'AUTO' ? _('Auto') : value ]);
                              })) ];
        globalParts.push(E(
            'div', {
                'style' : 'margin-top:1em;padding:1em;' +
                              'background:var(--background-color-high, #f3f3f3);border-radius:6px;'
            },
            [
                field(_('Selected mode'), mode === 'AUTO' ? _('Auto') : mode),
                field(_('Active route'), active),
                E('small', {},
                  [ mode === 'AUTO'  ? _('Automatically selected according to exit priority.')
                    : mode === 'WAN' ? _('Direct routing through the main routing table.')
                    : active !== mode
                        ? _('The selected exit is unreachable; the global exit route is disabled.')
                        : _('Manual override enabled.') ])
            ]));
        dom.content(this.globalNode, globalParts);
        var exitCards = state.exits.map(function(e) {
            return card(
                e.name, e.reachable ? _('Reachable') : _('Unreachable'),
                [ [ _('Tunnel'), e.tunnel ], [ _('Via interface'), e.via === '-' ? '-' : e.via ] ],
                active === e.name, e.reachable ? 'good' : 'bad');
        });
        var wanLabel = state.WAN_STATUS === 'ROUTE_AVAILABLE' ? _('Route available')
                       : state.WAN_STATUS === 'NO_ROUTE'      ? _('No route')
                                                              : _('Unknown');
        exitCards.push(
            card('WAN', wanLabel,
                 [
                     [
                         _('Interface'),
                         state.WAN_IFACE && state.WAN_IFACE !== '-' ? state.WAN_IFACE : '-'
                     ],
                     [ _('Routing table'), 'main' ]
                 ],
                 active === 'WAN',
                 state.WAN_STATUS === 'ROUTE_AVAILABLE' ? 'good'
                 : state.WAN_STATUS === 'NO_ROUTE'      ? 'bad'
                                                        : 'neutral'));
        dom.content(
            this.statusNode,
            E('div', {'style' : 'display:flex;flex-wrap:wrap;gap:.8em;margin:1em 0;'}, exitCards));
        this.renderDevices();
    },

    renderDevices : function() {
        var self = this;
        var opts = choices(this.state.exits);
        var table = E('table', {'class' : 'table', 'style' : 'width:100%;'}, [ E('tr', {}, [
                          E('th', {}, [ _('Device / IP') ]), E('th', {}, [ _('Route') ]),
                          E('th', {}, [ _('Action') ])
                      ]) ]);
        this.devices.forEach(function(device) {
            var effective = device.override || device.base;
            var selected = policyID(effective);
            var select = routeSelect(opts, selected,
                                     function(value) { return self.setDevice(device, value); });
            select.disabled = self.busy;
            var action = device.override ? E('button', {
                'type' : 'button',
                'class' : 'btn',
                'disabled' : self.busy,
                'title' : _('Restore deployment rule'),
                'click' : function() { return self.removeOverride(device); }
            },
                                             [ _('Restore') ])
                                         : E('small', {}, [ device.base ? _('Deployment') : '-' ]);
            table.appendChild(E('tr', {}, [
                E('td', {},
                  [
                      E('strong', {}, [ device.hostname || _('Device') ]),
                      E('div', {}, [ device.ip ])
                  ]),
                E('td', {}, [ select ]), E('td', {}, [ action ])
            ]));
        });
        if (!this.devices.length)
            table.appendChild(
                E('tr', {}, [ E('td', {'colspan' : 3},
                                [ _('No devices found. Add an IPv4 address below.') ]) ]));
        dom.content(this.devicesNode, table);
        var addOptions = opts.filter(function(option) { return option.id !== 'default'; });
        var previous = this.newRouteValue || 'exit:' + (this.state.exits[0] || {}).name;
        var select =
            routeSelect(addOptions, previous, function(value) { self.newRouteValue = value; });
        if (!addOptions.some(function(option) { return option.id === previous; }))
            previous = addOptions[0] ? addOptions[0].id : 'wan';
        select.value = previous;
        this.newRouteValue = previous;
        dom.content(this.newRouteNode, select);
    },

    refresh : function() {
        var self = this;
        if (this.busy)
            return Promise.resolve();
        return Promise.all([ run([ 'status' ]), run([ 'device-list' ]) ])
            .then(function(result) {
                self.state = parseStatus(result[0]);
                self.devices = parseDevices(result[1]);
                self.updateAll();
            })
            .catch(function(
                err) { ui.addNotification(null, E('p', {}, [ err.message ]), 'danger'); });
    },

    change : function(args) {
        var self = this;
        if (this.busy)
            return Promise.resolve();
        this.busy = true;
        return run(args)
            .then(function() {
                self.busy = false;
                return self.refresh();
            })
            .catch(function(err) {
                self.busy = false;
                ui.addNotification(null, E('p', {}, [ err.message ]), 'danger');
                return self.refresh();
            });
    },

    setGlobal : function(mode) { return this.change([ 'set', mode ]); },

    setDevice : function(device, value) {
        if (!value)
            return Promise.resolve();
        if (value === policyID(device.override || device.base))
            return Promise.resolve();
        var pieces = value.split(':');
        if (value === 'default' && !device.base)
            return this.change([ 'device-del', device.ip ]);
        return this.change([ 'device-set', device.ip, pieces[0], pieces[1] || '-' ]);
    },

    removeOverride : function(device) { return this.change([ 'device-del', device.ip ]); },

    addDevice : function() {
        var ip = this.ipInput.value.trim();
        if (!validIPv4(ip)) {
            ui.addNotification(null, E('p', {}, [ _('Enter a valid unicast IPv4 address.') ]),
                               'warning');
            return Promise.resolve();
        }
        var parts = (this.newRouteValue || 'wan').split(':');
        var self = this;
        return this.change([ 'device-set', ip, parts[0], parts[1] || '-' ])
            .then(function() { self.ipInput.value = ''; });
    },

    handleSave : null,
    handleSaveApply : null,
    handleReset : null
});
