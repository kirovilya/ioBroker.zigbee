/**
 *
 * Zigbee devices adapter
 *
 */

/* jshint -W097 */// jshint strict:false
/*jslint node: true */
"use strict";

const safeJsonStringify = require(__dirname + '/lib/json');

// you have to require the utils module and call adapter function
const fs = require("fs");
const utils = require(__dirname + '/lib/utils'); // Get common adapter utils
const util = require("util");
const ZShepherd = require('zigbee-shepherd');
const ZigbeeController = require(__dirname + '/lib/zigbeecontroller');
const adapter = utils.Adapter({name: 'zigbee', systemConfig: true});
const deviceMapping = require('zigbee-shepherd-converters');
const statesMapping = require(__dirname + '/lib/devstates');;

let zbControl;


function processMessages(ignore) {
    adapter.getMessage(function (err, obj) {
        if (obj) {
            if (!ignore && obj && obj.command == 'send') processMessage(obj.message);
            processMessages();
        }
    });
}


// Because the only one port is occupied by first instance, the changes to other devices will be send with messages
function processMessage(message) {
    if (typeof message === 'string') {
        try {
            message = JSON.parse(message);
        } catch (err) {
            adapter.log.error('Cannot parse: ' + message);
            return;
        }
    }
}


// is called when adapter shuts down - callback has to be called under any circumstances!
adapter.on('unload', function (callback) {
    try {
        adapter.log.debug('cleaned everything up...');
        if (zbControl) {
            zbControl.stop();
            zbControl = undefined;
        }
        callback();
    } catch (e) {
        callback();
    }
});


// is called if a subscribed object changes
adapter.on('objectChange', function (id, obj) {
    // Warning, obj can be null if it was deleted
    // adapter.log.info('objectChange ' + id + ' ' + JSON.stringify(obj));
});


// is called if a subscribed state changes
adapter.on('stateChange', function (id, state) {
    // you can use the ack flag to detect if it is status (true) or command (false)
    if (state && !state.ack) {
        adapter.log.debug('User stateChange ' + id + ' ' + JSON.stringify(state));
        const devId = adapter.namespace + '.' + id.split('.')[2]; // iobroker device id
        const deviceId = '0x'+id.split('.')[2]; // zigbee device id
        const stateKey = id.split('.')[3];
        adapter.getObject(devId, function(err, obj) {
            if (obj) {
                const modelId = obj.common.type;
                if (!modelId) return;
                publishFromState(deviceId, modelId, stateKey, state.val);
            }
        });
    }
});


// Some message was sent to adapter instance over message box. Used by email, pushover, text2speech, ...
adapter.on('message', function (obj) {
    if (typeof obj == 'object' && obj.message) {
        switch (obj.command) {
            case 'send':
                // e.g. send email or pushover or whatever
                adapter.log.debug('send command');
                // Send response in callback if required
                if (obj.callback) adapter.sendTo(obj.from, obj.command, 'Message received', obj.callback);
                break;
            case 'letsPairing':
                if (obj && obj.message && typeof obj.message == 'object') {
                    letsPairing(obj.from, obj.command, obj.callback);
                }
                break;
            case 'getDevices':
                if (obj && obj.message && typeof obj.message == 'object') {
                    getDevices(obj.from, obj.command, obj.callback);
                }
                break;
            case 'renameDevice':
                if (obj && obj.message && typeof obj.message == 'object') {
                    renameDevice(obj.from, obj.command, obj.message, obj.callback);
                }
                break;
            case 'deleteDevice':
                if (obj && obj.message && typeof obj.message == 'object') {
                    deleteDevice(obj.from, obj.command, obj.message, obj.callback);
                }
                break;
            default:
                adapter.log.warn('Unknown message: ' + JSON.stringify(obj));
                break;
        }
    }
    processMessages();
});


function updateStateWithTimeout(dev_id, name, value, common, timeout, outValue) {
    updateState(dev_id, name, value, common);
    setTimeout(function () {
        updateState(dev_id, name, outValue, common);
    }, timeout);
}


function updateState(devId, name, value, common) {
    adapter.getObject(devId, function(err, obj) {
        if (obj) {
            let new_common = {name: name};
            let id = devId + '.' + name;
            if (common != undefined) {
                if (common.name != undefined) {
                    new_common.name = common.name;
                }
                if (common.type != undefined) {
                    new_common.type = common.type;
                }
                if (common.unit != undefined) {
                    new_common.unit = common.unit;
                }
                if (common.states != undefined) {
                    new_common.states = common.states;
                }
                if (common.read != undefined) {
                    new_common.read = common.read;
                }
                if (common.write != undefined) {
                    new_common.write = common.write;
                }
                if (common.role != undefined) {
                    new_common.role = common.role;
                }
                if (common.min != undefined) {
                    new_common.min = common.min;
                }
                if (common.max != undefined) {
                    new_common.max = common.max;
                }
                if (common.icon != undefined) {
                    new_common.icon = common.icon;
                }
            }
            adapter.extendObject(id, {type: 'state', common: new_common});
            adapter.setState(id, value, true);
        } else {
            adapter.log.debug('Wrong device '+devId);
        }
    });
}


function renameDevice(from, command, msg, callback) {
    var id = msg.id, newName = msg.name;
    adapter.extendObject(id, {common: {name: newName}});
    adapter.sendTo(from, command, {}, callback);
}


function deleteDevice(from, command, msg, callback) {
    if (zbControl) {
        adapter.log.debug('deleteDevice message: ' + JSON.stringify(msg));
        var id = msg.id, sysid = id.replace(adapter.namespace+'.', '0x'), 
            devId = id.replace(adapter.namespace+'.', '');
        adapter.log.debug('deleteDevice sysid: ' + sysid);
        //adapter.extendObject(id, {common: {name: newName}});
        var dev = zbControl.getDevice(sysid);
        if (!dev) {
            adapter.log.debug('Not found on shepherd!');
            adapter.log.debug('Try delete dev '+devId+'from iobroker.');
            adapter.deleteDevice(devId, function(){
                adapter.sendTo(from, command, {}, callback);
            });
            return;
        } 
        zbControl.remove(sysid, (err) => {
            if (!err) {
                adapter.log.debug('Successfully removed from shepherd!');
                adapter.deleteDevice(devId, function(){
                    adapter.sendTo(from, command, {}, callback);
                });
            } else {
                adapter.log.debug('Error on remove! ' + err);
                adapter.log.debug('Try force remove!');
                zbControl.forceRemove(sysid, function (err) {
                    if (!err) {
                        adapter.log.debug('Force removed from shepherd!');
                        adapter.log.debug('Try delete dev '+devId+'from iobroker.');
                        adapter.deleteDevice(devId, function(){
                            adapter.sendTo(from, command, {}, callback);
                        });
                    } else {
                        adapter.sendTo(from, command, {error: err}, callback);
                    }
                });
            }
        });
    } else {
        adapter.sendTo(from, command, {error: 'You need save and run adapter!'}, callback);
    }
}

function updateDev(dev_id, dev_name, model, callback) {
    const id = '' + dev_id;
    const modelDesc = statesMapping[model];
    const icon = (modelDesc && modelDesc.icon) ? modelDesc.icon : 'img/unknown.png';
    adapter.setObjectNotExists(id, {
        type: 'device',
        common: {name: dev_name, type: model, icon: icon}
    }, {}, callback);
}

// is called when databases are connected and adapter received configuration.
// start here!
adapter.on('ready', function () {
    main();
});


function onPermitJoining(joinTimeLeft){
    adapter.setObjectNotExists('info.pairingCountdown', {
        type: 'state',
        common: {name: 'Pairing countdown'}
    }, {});
    adapter.setState('info.pairingCountdown', joinTimeLeft);
    // repeat until 0
    if (joinTimeLeft == 0) {
        // set pairing mode off
        adapter.setObjectNotExists('info.pairingMode', {
            type: 'state',
            common: {name: 'Pairing mode'}
        }, {});
        adapter.setState('info.pairingMode', false);
    }
    logToPairing('Time left: '+joinTimeLeft, true);
}

function letsPairing(from, command, callback){
    if (zbControl) {
        // allow devices to join the network within 60 secs
        adapter.setObjectNotExists('info.pairingMessage', {
            type: 'state',
            common: {name: 'Pairing message'}
        }, {});
        logToPairing('Pairing started');
        zbControl.permitJoin(60, function(err) {
            if (!err) {
                // set pairing mode on
                adapter.setObjectNotExists('info.pairingMode', {
                    type: 'state',
                    common: {name: 'Pairing mode'}
                }, {});
                adapter.setState('info.pairingMode', true);
            }
        });
        adapter.sendTo(from, command, 'Start pairing!', callback);
    } else {
        adapter.sendTo(from, command, {error: 'You need save and run adapter before pairing!'}, callback);
    }
}

function getDevices(from, command, callback){
    if (zbControl) {
        const pairedDevices = zbControl.getAllClients();
        var rooms;
        adapter.getEnums('enum.rooms', function (err, list) {
            if (!err){
                rooms = list['enum.rooms'];
            }
            adapter.getDevices((err, result) => {
                if (result) {
                    var devices = [], cnt = 0, len = result.length;
                    for (var item in result) {
                        if (result[item]._id) {
                            const id = result[item]._id.split('.')[2];
                            let devInfo = result[item];
                            const modelDesc = statesMapping[devInfo.common.type];
                            devInfo.icon = (modelDesc && modelDesc.icon) ? modelDesc.icon : 'img/unknown.png';
                            devInfo.rooms = [];
                            for (var room in rooms) {
                                if (!rooms[room] || !rooms[room].common || !rooms[room].common.members)
                                    continue;
                                if (rooms[room].common.members.indexOf(devInfo._id) !== -1) {
                                    devInfo.rooms.push(rooms[room].common.name);
                                }
                            }
                            devInfo.paired = zbControl.getDevice('0x' + id) != undefined;
                            devices.push(devInfo);
                            cnt++;
                            if (cnt==len) {
                                // append devices that paired but not created
                                pairedDevices.forEach((device) => {
                                    const exists = devices.find((dev) => device.ieeeAddr == '0x' + dev._id.split('.')[2]);
                                    if (!exists) {
                                        devices.push({
                                            _id: device.ieeeAddr,
                                            icon: 'img/unknown.png',
                                            paired: true,
                                            common: {
                                                name: undefined,
                                                type: undefined,
                                            },
                                        });
                                    }
                                });
                                adapter.log.debug('getDevices result: ' + JSON.stringify(devices));
                                adapter.sendTo(from, command, devices, callback);
                            }
                        }
                    }
                    if (len == 0) {
                        // append devices that paired but not created
                        pairedDevices.forEach((device) => {
                            const exists = devices.find((dev) => device.ieeeAddr == '0x' + dev._id.split('.')[2]);
                            if (!exists) {
                                devices.push({
                                    _id: device.ieeeAddr,
                                    icon: 'img/unknown.png',
                                    paired: true,
                                    common: {
                                        name: undefined,
                                        type: undefined,
                                    },
                                });
                            }
                        });
                        adapter.log.debug('getDevices result: ' + JSON.stringify(devices));
                        adapter.sendTo(from, command, devices, callback);
                    }
                }
            });
        });
    } else {
        adapter.sendTo(from, command, {error: 'You need save and run adapter before pairing!'}, callback);
    }
}

function newDevice(id, msg) {
    let dev = zbControl.getDevice(id);
    if (dev) {
        adapter.log.info('new dev '+dev.ieeeAddr + ' ' + dev.nwkAddr + ' ' + dev.modelId);
        logToPairing('New device joined '+dev.ieeeAddr + ' model ' + dev.modelId, true);
        updateDev(dev.ieeeAddr.substr(2), dev.modelId, dev.modelId, function () {
            syncDevStates(dev.ieeeAddr.substr(2), dev.modelId);
        });
        
    }
}

function onReady(){
    adapter.setState('info.connection', true);
    // create and update pairing State
    adapter.setObjectNotExists('info.pairingMode', {
        type: 'state',
        common: {name: 'Pairing mode'}
    }, {});
    adapter.setState('info.pairingMode', false);
    // get and list all registered devices (not in ioBroker)
    let activeDevices = zbControl.getAllClients();
    adapter.log.debug('Current active devices:');
    activeDevices.forEach((device) => {
        adapter.log.debug(safeJsonStringify(device));
    });
    activeDevices.forEach((device) => {
        adapter.log.info(getDeviceStartupLogMessage(device));
        configureDevice(device);
    });
}

function getDeviceStartupLogMessage(device) {
    let type = 'unknown';
    let friendlyDevice = {model: 'unkown', description: 'unknown'};
    const mappedModel = deviceMapping.findByZigbeeModel(device.modelId);
    if (mappedModel) {
        friendlyDevice = mappedModel;
    }

    if (device.type) {
        type = device.type;
    }

    return `(${device.ieeeAddr}): ${friendlyDevice.model} - ` +
        `${friendlyDevice.vendor} ${friendlyDevice.description} (${type})`;
}

function configureDevice(device) {
    // Configure reporting for this device.
    const ieeeAddr = device.ieeeAddr;
    if (ieeeAddr && device.modelId) {
        const mappedModel = deviceMapping.findByZigbeeModel(device.modelId);

        if (mappedModel && mappedModel.configure) {
            mappedModel.configure(ieeeAddr, zbControl.shepherd, zbControl.getCoordinator(), (ok, msg) => {
                if (ok) {
                    adapter.log.info(`Succesfully configured ${ieeeAddr}`);
                } else {
                    adapter.log.error(`Failed to configure ${ieeeAddr}`);
                }
            });
        }
    }
}

function onLog(level, msg, data) {
    if (msg) {
        let logger = adapter.log.info;
        switch (level) {
            case 'error':
                logger = adapter.log.error;
                if (data)
                    data = data.toString();
                logToPairing('Error: '+msg+'. '+data);
                break;
            case 'debug':
                logger = adapter.log.debug;
                break;
            case 'info':
                logger = adapter.log.info;
                break;
        }
        if (data) {
            if (typeof data === 'string') {
                logger(msg+ '. ' + data);
            } else {
                logger(msg+ '. ' + safeJsonStringify(data));
            }
        } else {
            logger(msg);
        }
    }
}

function logToPairing(message, ignoreJoin){
    if (zbControl) {
        const info = zbControl.getInfo();
        if (ignoreJoin || info.joinTimeLeft > 0) {
            adapter.setState('info.pairingMessage', message);
        }
    }
}

function publishFromState(deviceId, modelId, stateKey, value){
    const mappedModel = deviceMapping.findByZigbeeModel(modelId);
    if (!mappedModel) {
        adapter.log.error('Unknown device model ' + modelId);
        return;
    }
    const stateModel = statesMapping[modelId];
    if (!stateModel) {
        adapter.log.error('Device ' + deviceId + ' "' + modelId +'" not described in statesMapping.');
        return;
    }
    // find state for set
    const stateDesc = stateModel.states.find((statedesc) => stateKey == statedesc.id);
    if (!stateDesc) {
        adapter.log.error(
            `No state available for '${mappedModel.model}' with key '${stateKey}'`
        );
        return;
    }
    const converter = mappedModel.toZigbee.find((c) => c.key === stateDesc.prop || c.key === stateDesc.setattr || c.key === stateDesc.id);
    if (!converter) {
        adapter.log.error(
            `No converter available for '${mappedModel.model}' with key '${stateKey}'`
        );
        return;
    }
    const preparedValue = (stateDesc.setter) ? stateDesc.setter(value) : value;
    const epName = (stateDesc.epname || stateDesc.prop || stateDesc.id);
    const ep = mappedModel.ep && mappedModel.ep[epName] ? mappedModel.ep[epName] : null;
    const message = converter.convert(preparedValue.toString(), {});
    if (!message) {
        return;
    }

    zbControl.publish(deviceId, message.cid, message.cmd, message.zclData, ep);
}

function publishToState(devId, modelID, model, payload) {
    const stateModel = statesMapping[modelID];
    if (!stateModel) {
        adapter.log.debug('Device ' + devId + ' "' + modelID +'" not described in statesMapping.');
        return;
    }
    // find states for payload
    const states = stateModel.states.filter((statedesc) => payload.hasOwnProperty(statedesc.prop || statedesc.id));
    for (const stateInd in states) {
        const statedesc = states[stateInd];
        let value;
        if (statedesc.getter) {
            value = statedesc.getter(payload);
        } else {
            value = payload[statedesc.prop || statedesc.id]
        }
        // checking value
        if (value == undefined)
            continue;
        const common = {
            name: statedesc.name,
            type: statedesc.type,
            unit: statedesc.unit,
            read: statedesc.read,
            write: statedesc.write,
            icon: statedesc.icon,
            role: statedesc.role,
            min: statedesc.min,
            max: statedesc.max,
        };
        // if need return value to back after timeout
        if (statedesc.isEvent) {
            updateStateWithTimeout(devId, statedesc.id, value, common, 300, !value);
        } else {
            if (statedesc.prepublish) {
                statedesc.prepublish(devId, value, (newvalue) => {
                    updateState(devId, statedesc.id, newvalue, common);
                });
            } else {
                updateState(devId, statedesc.id, value, common);
            }
        }
    }
}

function syncDevStates(devId, modelId) {
    // devId - iobroker device id
    const stateModel = statesMapping[modelId];
    if (!stateModel) {
        adapter.log.debug('Device ' + devId + ' "' + modelId +'" not described in statesMapping.');
        return;
    }
    for (const stateInd in stateModel.states) {
        const statedesc = stateModel.states[stateInd];
        const common = {
            name: statedesc.name,
            type: statedesc.type,
            unit: statedesc.unit,
            read: statedesc.read,
            write: statedesc.write,
            icon: statedesc.icon,
            role: statedesc.role,
            min: statedesc.min,
            max: statedesc.max,
        };
        updateState(devId, statedesc.id, undefined, common);
    }
}


function onDevEvent(type, devId, message, data) {
    switch (type) {
        case 'interview':
            adapter.log.debug('Device ' + devId + ' try to connect '+ safeJsonStringify(data));
            logToPairing('Interview state: step '+data.currentEp+'/'+data.totalEp+'. progress: '+data.progress+'%', true);
            break;
        default:
            adapter.log.debug('Device ' + devId + ' emit event ' + type + ' with data:' + safeJsonStringify(message.data));
            // Map Zigbee modelID to vendor modelID.
            const modelID = data.modelId;
            const mappedModel = deviceMapping.findByZigbeeModel(modelID);
            // Find a conveter for this message.
            const cid = data.cid;
            if (!mappedModel) {
                adapter.log.error('Unknown device model ' + modelID + ' emit event ' + type + ' with data:' + safeJsonStringify(message.data));
                return;
            }
            const converters = mappedModel.fromZigbee.filter((c) => c.cid === cid && c.type === type);
            if (!converters.length) {
                adapter.log.error(
                    `No converter available for '${mappedModel.model}' with cid '${cid}' and type '${type}'`
                );
                return;
            }
            // Convert this Zigbee message to a MQTT message.
            // Get payload for the message.
            // - If a payload is returned publish it to the MQTT broker
            // - If NO payload is returned do nothing. This is for non-standard behaviour
            //   for e.g. click switches where we need to count number of clicks and detect long presses.
            converters.forEach((converter) => {
                const publish = (payload) => {
                    // Don't cache messages with click and action.
                    const cache = !payload.hasOwnProperty('click') && !payload.hasOwnProperty('action');
                    //this.mqttPublishDeviceState(device.ieeeAddr, payload, cache);
                    adapter.log.debug('Publish '+safeJsonStringify(payload));
                    publishToState(devId.substr(2), modelID, mappedModel, payload);
                };

                const payload = converter.convert(mappedModel, message, publish);

                if (payload) {
                    publish(payload);
                }
            });
            break;
    }
}

function main() {
    // file path for ZShepherd
    var dbDir = utils.controllerDir + '/' + adapter.systemConfig.dataDir + adapter.namespace.replace('.', '_');
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir);
    var port = adapter.config.port;
    adapter.log.info('Start on port: ' + port);
    let shepherd = new ZShepherd(port, {
        net: {panId: 0x1a62, channelList: [11]},
        sp: { baudRate: 115200, rtscts: false },
        dbPath: dbDir+'/shepherd.db'
    });
    // create contoller and handlers
    zbControl = new ZigbeeController(shepherd);
    zbControl.on('log', onLog);
    zbControl.on('ready', onReady);
    zbControl.on('new', newDevice);
    zbControl.on('join', onPermitJoining);
    zbControl.on('event', onDevEvent);

    // start the server
    zbControl.start((err) => {
        if (err) {
            adapter.setState('info.connection', false);
        }
    });

    // in this template all states changes inside the adapters namespace are subscribed
    adapter.subscribeStates('*');

    processMessages(true);
}
