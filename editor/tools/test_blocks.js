// Checks blocks.js against packets produced by the BLOCKS SDK's C++ protocol code (sdk_vectors.json from sdkvec).
// usage: node test_blocks.js [path/to/sdk_vectors.json]
'use strict';

const path = require ('path');
const Blocks = require ('../blocks.js');
const vectors = require (path.resolve (process.argv[2] || path.join (__dirname, 'sdk_vectors.json')));

let passed = 0, failed = 0;

function check (name, actual, expected)
{
    if (actual === expected)
    {
        ++passed;
        return true;
    }

    ++failed;
    console.log (`FAIL ${name}\n  expected ${expected}\n  actual   ${actual}`);
    return false;
}

const hex = Blocks.toHex;

for (const c of vectors.commands)
    check (`command ${c.command} index ${c.index}`, hex (Blocks.commandPacket (c.index, c.command)), c.hex);

for (const e of vectors.programEvents)
    check (`program event ${e.values} index ${e.index}`, hex (Blocks.programEventPacket (e.index, e.values)), e.hex);

for (const c of vectors.configSet)
    check (`config set ${c.item}=${c.value}`, hex (Blocks.configSetPacket (c.index, c.item, c.value)), c.hex);

for (const c of vectors.configRequest)
    check (`config request ${c.item}`, hex (Blocks.configRequestPacket (c.index, c.item)), c.hex);

// Upload replay: same calls and ACK order as sdkvec.cpp
{
    const program = Blocks.fromHex (vectors.upload.programHex);
    const sent = [];
    const heap = new Blocks.RemoteHeap ({ getDeviceIndex: () => 0, sendMessageToDevice: p => sent.push (p), now: () => 1e9 });
    const events = [];
    const unacked = [];
    let reported = 0;

    const flush = () =>
    {
        for (; reported < sent.length; ++reported)
        {
            events.push ('send ' + hex (sent[reported]));
            unacked.push (Blocks.packetIndexOf (sent[reported]));
        }
    };

    const ackAll = () =>
    {
        for (let guard = 0; unacked.length > 0 && guard < 5000; ++guard)
        {
            const index = unacked.shift();
            events.push ('ack ' + index);
            heap.handleACKFromDevice (index);
            flush();
        }
    };

    const status = () =>
    {
        events.push (heap.isFullySynced() ? 'synced' : 'not synced');
        events.push (heap.isProgramLoaded() ? 'program loaded' : 'program not loaded');
    };

    const started = Date.now();

    events.push ('step upload');
    heap.resetDataRangeToUnknown (0, 7200);
    heap.clearTargetData();
    heap.sendChanges (true);
    flush();
    heap.resetDataRangeToUnknown (0, program.length);
    heap.setBytes (0, program);
    heap.sendChanges (true);
    flush();
    ackAll();
    status();

    events.push ('step heap test value');
    heap.setBytes (program.length, [0x31, 0x4D, 0x50, 0x4C]);
    heap.sendChanges (false);
    flush();
    ackAll();
    status();

    events.push ('step scattered writes');
    heap.setByte (program.length + 20, 7);
    heap.setByte (program.length + 400, 9);
    heap.setByte (5000, 200);
    heap.sendChanges (false);
    flush();
    ackAll();
    status();

    events.push ('step unknown ack');
    heap.handleACKFromDevice (900);
    flush();
    heap.sendChanges (false);
    flush();
    ackAll();
    status();

    const expected = vectors.upload.events;
    const count = Math.max (expected.length, events.length);
    let firstMismatch = -1;

    for (let i = 0; i < count; ++i)
        if (events[i] !== expected[i]) { firstMismatch = i; break; }

    if (check ('upload event count', events.length, expected.length) && firstMismatch < 0)
        ++passed;
    else if (firstMismatch >= 0)
        check (`upload event ${firstMismatch}`, events[firstMismatch], expected[firstMismatch]);

    const sends = expected.filter (e => e.startsWith ('send ')).length;
    console.log (`upload replay: ${events.length} events, ${sends} packets, ${Date.now() - started} ms`);
}

// Program patching: patch a slot, recompute the checksum, and the header check still passes
{
    const program = Blocks.fromHex (vectors.upload.programHex);
    check ('stored checksum matches', Blocks.Program.checksumMatches (program, program.length), true);
    const copy = program.slice();
    Blocks.Program.writeInt32 (copy, 100, 0x12345678);
    check ('patched without checksum update fails', Blocks.Program.checksumMatches (copy, copy.length), false);
    Blocks.Program.updateChecksum (copy);
    check ('patched with checksum update passes', Blocks.Program.checksumMatches (copy, copy.length), true);
}

// Decoder
const u = v => v >>> 0;

function traceOf (m)
{
    switch (m.type)
    {
        case 'beginTopology':   return `beginTopology devices=${m.devices} connections=${m.connections}`;
        case 'extendTopology':  return `extendTopology devices=${m.devices} connections=${m.connections}`;
        case 'topologyDevice':  return `device serial=${m.serial} index=${m.index} battery=${m.batteryLevel} charging=${m.batteryCharging}`;
        case 'topologyConnection': return `connection ${m.device1}:${m.port1} ${m.device2}:${m.port2}`;
        case 'endTopology':     return 'endTopology';
        case 'version':         return `version index=${m.index} ${m.version}`;
        case 'name':            return `name index=${m.index} ${m.name}`;
        case 'touch':           return `touch index=${m.index} ts=${u (m.timestamp)} touch=${m.touchIndex} x=${m.x} y=${m.y} z=${m.z} vx=${m.vx} vy=${m.vy} vz=${m.vz} start=${m.isStart ? 1 : 0} end=${m.isEnd ? 1 : 0}`;
        case 'button':          return `button index=${m.index} ts=${u (m.timestamp)} id=${m.buttonId} down=${m.isDown ? 1 : 0}`;
        case 'programEvent':    return `program index=${m.index} ts=${u (m.timestamp)} ${m.values[0]} ${m.values[1]} ${m.values[2]}`;
        case 'ack':             return `ack index=${m.index} counter=${m.counter}`;
        case 'firmwareAck':     return `firmwareAck index=${m.index} code=${m.code} detail=${u (m.detail)}`;
        case 'configUpdate':    return `configUpdate index=${m.index} item=${m.item} value=${m.value} min=${m.min} max=${m.max}`;
        case 'configSet':       return `configSet index=${m.index} item=${m.item} value=${m.value}`;
        case 'configFactorySyncEnd':   return `configFactorySyncEnd index=${m.index}`;
        case 'configFactorySyncReset': return `configFactorySyncReset index=${m.index}`;
        case 'log':             return `log index=${m.index} ${m.text}`;
        default:                return 'unknown ' + JSON.stringify (m);
    }
}

for (const d of vectors.decode)
{
    const packet = Blocks.decodePacket (Blocks.fromHex (d.hex));
    const trace = packet ? packet.messages.map (traceOf) : [];
    check (`decode ${d.name}`, JSON.stringify (trace), JSON.stringify (d.trace));
}

console.log (`${passed} passed, ${failed} failed`);
process.exit (failed ? 1 : 0);
