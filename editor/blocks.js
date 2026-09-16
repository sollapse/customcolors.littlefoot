/*
  blocks.js: BLOCKS host protocol for a ROLI Piano M / LUMI Keys, for a browser page using Web MIDI.

  Ported from the BLOCKS SDK host code (roli_blocks_basics: protocol/roli_BitPackingUtilities.h,
  roli_BlocksProtocolDefinitions.h, roli_HostPacketBuilder.h, roli_HostPacketDecoder.h,
  littlefoot/roli_LittleFootRemoteHeap.h, littlefoot/roli_LittleFootRunner.h, topology/internal/
  roli_ConnectedDeviceGroup.cpp and roli_BlockImplementation.cpp), modified: JavaScript, no JUCE, and the
  shared-memory diff coalescing runs in linear time with the SDK's exact merge order.

  Original notice:

   Copyright (c) 2020 - ROLI Ltd

   Permission to use, copy, modify, and/or distribute this software for any
   purpose with or without fee is hereby granted, provided that the above
   copyright notice and this permission notice appear in all copies.

   THE SOFTWARE IS PROVIDED "AS IS" AND ROLI LTD DISCLAIMS ALL WARRANTIES WITH
   REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
   AND FITNESS. IN NO EVENT SHALL ROLI LTD BE LIABLE FOR ANY SPECIAL, DIRECT,
   INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
   LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE
   OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
   PERFORMANCE OF THIS SOFTWARE.
*/

(function (root, factory)
{
    const api = factory();

    if (typeof module !== 'undefined' && module.exports)
        module.exports = api;
    else
        root.Blocks = api;
}) (typeof self !== 'undefined' ? self : this, function ()
{
'use strict';

//==============================================================================
// Protocol constants (roli_BlocksProtocolDefinitions.h)

const SYSEX_HEADER = [0xF0, 0x00, 0x21, 0x10, 0x77];

const MessageFromDevice = {
    deviceTopology: 0x01, packetACK: 0x02, firmwareUpdateACK: 0x03, deviceTopologyExtend: 0x04,
    deviceTopologyEnd: 0x05, deviceVersion: 0x06, deviceName: 0x07,
    touchStart: 0x10, touchMove: 0x11, touchEnd: 0x12,
    touchStartWithVelocity: 0x13, touchMoveWithVelocity: 0x14, touchEndWithVelocity: 0x15,
    configMessage: 0x18, controlButtonDown: 0x20, controlButtonUp: 0x21,
    programEventMessage: 0x28, logMessage: 0x30
};

const MessageFromHost = {
    deviceCommandMessage: 0x01, sharedDataChange: 0x02, programEventMessage: 0x03, firmwareUpdatePacket: 0x04,
    configMessage: 0x10, factoryReset: 0x11, blockReset: 0x12, setName: 0x20
};

const DeviceCommand = { beginAPIMode: 0, requestTopologyMessage: 1, endAPIMode: 2, ping: 3, debugMode: 4, saveProgramAsDefault: 5 };

const ConfigCommand = {
    setConfig: 0, requestConfig: 1, requestFactorySync: 2, requestUserSync: 3, updateConfig: 4,
    updateUserConfig: 5, setConfigState: 6, factorySyncEnd: 7, clusterConfigSync: 8, factorySyncReset: 9
};

const DataChange = {
    endOfPacket: 0, endOfChanges: 1, skipBytesFew: 2, skipBytesMany: 3,
    setSequenceOfBytes: 4, setFewBytesWithValue: 5, setFewBytesWithLastValue: 6, setManyBytesWithValue: 7
};

const BITS = {
    messageType: 7, protocolVersion: 8, packetTimestamp: 32, packetTimestampOffset: 5,
    deviceCount: 7, connectionCount: 8, topologyIndex: 7, batteryLevel: 5, batteryCharging: 1, connectorPort: 5,
    touchIndex: 5, packetCounter: 10, deviceCommand: 9, configCommand: 4, packetIndex: 16,
    dataChangeCommand: 3, byteCountFew: 4, byteCountMany: 8, byteValue: 8, byteSequenceContinues: 1,
    controlButtonID: 12, firmwareUpdateACKCode: 7, firmwareUpdateACKDetail: 32
};

const BYTE_COUNT_FEW_MAX = 15;
const BYTE_COUNT_MANY_MAX = 255;
const NUM_PROGRAM_MESSAGE_INTS = 3;
const MAX_BLOCKS_IN_TOPOLOGY_PACKET = 6;
const MAX_CONNECTIONS_IN_TOPOLOGY_PACKET = 24;
const SERIAL_LENGTH = 16;
const CURRENT_PROTOCOL_VERSION = 1;
const PACKET_COUNTER_MAX = 1023;

const BIT_SIZES = {
    topologyDeviceInfo: SERIAL_LENGTH * 7 + BITS.batteryLevel + BITS.batteryCharging,
    topologyConnectionInfo: BITS.topologyIndex + BITS.connectorPort + BITS.topologyIndex + BITS.connectorPort,
    touchMessage: BITS.messageType + BITS.packetTimestampOffset + BITS.touchIndex + 12 + 12 + 8,
    touchMessageWithVelocity: BITS.messageType + BITS.packetTimestampOffset + BITS.touchIndex + 12 + 12 + 8 + 24,
    programEventMessage: BITS.messageType + 32 * NUM_PROGRAM_MESSAGE_INTS,
    packetACK: BITS.messageType + BITS.packetCounter,
    controlButtonMessage: BITS.messageType + BITS.packetTimestampOffset + BITS.controlButtonID,
    configSetMessage: BITS.messageType + BITS.configCommand + 8 + 32
};

// Piano M / LUMI Keys block (roli_BlockModels.h, roli_BlockImplementation.cpp)
const PROGRAM_AND_HEAP_SIZE = 7200;
const MAX_PACKET_SIZE = 200;
const MASTER_PING_INTERVAL_MS = 400;
const PING_TIMEOUT_MS = 6000;
const API_RETRY_INTERVAL_MS = 200;
const RESEND_AFTER_MS = 250;

//==============================================================================
function calculatePacketChecksum (bytes, start, end)
{
    let checksum = (end - start) & 0xFF;

    for (let i = start; i < end; ++i)
        checksum = (checksum + (checksum * 2 + bytes[i])) & 0xFF;

    return checksum & 0x7F;
}

//==============================================================================
// roli_BitPackingUtilities.h: Packed7BitArrayBuilder / Packed7BitArrayReader

class Packed7BitArrayBuilder
{
    constructor (allocatedBytes)
    {
        this.allocatedBytes = allocatedBytes;
        this.data = new Uint8Array (allocatedBytes);
        this.bytesWritten = 0;
        this.bitsInCurrentByte = 0;
    }

    size()                  { return this.bytesWritten + (this.bitsInCurrentByte > 0 ? 1 : 0); }
    getBytes()              { return this.data.slice (0, this.size()); }
    getState()              { return { bytesWritten: this.bytesWritten, bitsInCurrentByte: this.bitsInCurrentByte }; }
    restore (state)         { this.bytesWritten = state.bytesWritten; this.bitsInCurrentByte = state.bitsInCurrentByte; }

    hasCapacity (bitsNeeded)
    {
        return ((this.bytesWritten + 2) * 7 + this.bitsInCurrentByte + bitsNeeded) <= this.allocatedBytes * 7;
    }

    writeHeaderSysexBytes (deviceIndex)
    {
        for (const b of SYSEX_HEADER)
            this.data[this.bytesWritten++] = b;

        this.data[this.bytesWritten++] = deviceIndex & 0x7F;
    }

    writePacketSysexFooter()
    {
        if (this.bitsInCurrentByte !== 0)
        {
            this.bitsInCurrentByte = 0;
            ++this.bytesWritten;
        }

        const headerBytes = SYSEX_HEADER.length + 1;
        this.data[this.bytesWritten] = calculatePacketChecksum (this.data, headerBytes, this.bytesWritten);
        ++this.bytesWritten;
        this.data[this.bytesWritten++] = 0xF7;
    }

    writeBits (value, numBits)
    {
        value = value >>> 0;

        while (numBits > 0)
        {
            if (this.bitsInCurrentByte === 0)
            {
                if (numBits < 7)
                {
                    this.data[this.bytesWritten] = value;
                    this.bitsInCurrentByte = numBits;
                    return;
                }

                if (numBits === 7)
                {
                    this.data[this.bytesWritten++] = value;
                    return;
                }

                this.data[this.bytesWritten++] = value & 0x7F;
                value >>>= 7;
                numBits -= 7;
            }
            else
            {
                const bitsToDo = Math.min (7 - this.bitsInCurrentByte, numBits);

                this.data[this.bytesWritten] = this.data[this.bytesWritten] | ((value & ((1 << bitsToDo) - 1)) << this.bitsInCurrentByte);
                value >>>= bitsToDo;
                numBits -= bitsToDo;
                this.bitsInCurrentByte += bitsToDo;

                if (this.bitsInCurrentByte === 7)
                {
                    this.bitsInCurrentByte = 0;
                    ++this.bytesWritten;
                }
            }
        }
    }
}

class Packed7BitArrayReader
{
    constructor (bytes, start, numBytes)
    {
        this.data = bytes;
        this.pos = start;
        this.totalBits = numBytes * 7;
        this.bitsReadInCurrentByte = 0;
    }

    getRemainingBits()      { return this.totalBits - this.bitsReadInCurrentByte; }

    readBits (numBits)
    {
        let value = 0, bitsSoFar = 0;

        while (numBits > 0)
        {
            const valueInCurrentByte = (this.data[this.pos] | 0) >>> this.bitsReadInCurrentByte;
            const bitsAvailable = 7 - this.bitsReadInCurrentByte;

            if (bitsAvailable > numBits)
            {
                value |= (valueInCurrentByte & ((1 << numBits) - 1)) << bitsSoFar;
                this.bitsReadInCurrentByte += numBits;
                break;
            }

            value |= valueInCurrentByte << bitsSoFar;
            numBits -= bitsAvailable;
            bitsSoFar += bitsAvailable;
            this.bitsReadInCurrentByte = 0;
            ++this.pos;
            this.totalBits -= 7;
        }

        return value >>> 0;
    }
}

//==============================================================================
// roli_HostPacketBuilder.h

class HostPacketBuilder
{
    constructor (maxPacketBytes)        { this.data = new Packed7BitArrayBuilder (maxPacketBytes); }

    size()                              { return this.data.size(); }
    getBytes()                          { return this.data.getBytes(); }
    writePacketSysexHeaderBytes (index) { this.data.writeHeaderSysexBytes (index); }
    writePacketSysexFooter()            { this.data.writePacketSysexFooter(); }
    writeMessageType (type)             { this.data.writeBits (type, BITS.messageType); }

    deviceControlMessage (command)
    {
        if (! this.data.hasCapacity (BITS.messageType + BITS.deviceCommand))
            return false;

        this.writeMessageType (MessageFromHost.deviceCommandMessage);
        this.data.writeBits (command, BITS.deviceCommand);
        return true;
    }

    beginDataChanges (packetIndex)
    {
        if (! this.data.hasCapacity (BITS.messageType + BITS.packetIndex + BITS.dataChangeCommand))
            return false;

        this.writeMessageType (MessageFromHost.sharedDataChange);
        this.data.writeBits (packetIndex, BITS.packetIndex);
        return true;
    }

    endDataChanges (isLastChange)
    {
        if (! this.data.hasCapacity (BITS.dataChangeCommand))
            return false;

        this.data.writeBits (isLastChange ? DataChange.endOfChanges : DataChange.endOfPacket, BITS.dataChangeCommand);
        return true;
    }

    skipBytes (numToSkip)
    {
        if (numToSkip <= 0)
            return true;

        const state = this.data.getState();

        while (numToSkip > BYTE_COUNT_MANY_MAX)
        {
            if (! this.skipBytes (BYTE_COUNT_MANY_MAX))
            {
                this.data.restore (state);
                return false;
            }

            numToSkip -= BYTE_COUNT_MANY_MAX;
        }

        if (numToSkip > BYTE_COUNT_FEW_MAX)
        {
            if (! this.data.hasCapacity (BITS.dataChangeCommand * 2 + BITS.byteCountMany))
            {
                this.data.restore (state);
                return false;
            }

            this.data.writeBits (DataChange.skipBytesMany, BITS.dataChangeCommand);
            this.data.writeBits (numToSkip, BITS.byteCountMany);
            return true;
        }

        if (! this.data.hasCapacity (BITS.dataChangeCommand * 2 + BITS.byteCountFew))
        {
            this.data.restore (state);
            return false;
        }

        this.data.writeBits (DataChange.skipBytesFew, BITS.dataChangeCommand);
        this.data.writeBits (numToSkip, BITS.byteCountFew);
        return true;
    }

    // setMultipleBytes (const uint8* values, int num)
    setByteSequence (values, offset, num)
    {
        if (num <= 0)
            return true;

        if (! this.data.hasCapacity (BITS.dataChangeCommand * 2 + num * (1 + BITS.byteValue)))
            return false;

        this.data.writeBits (DataChange.setSequenceOfBytes, BITS.dataChangeCommand);

        for (let i = 0; i < num; ++i)
        {
            this.data.writeBits (values[offset + i], BITS.byteValue);
            this.data.writeBits (i < num - 1 ? 1 : 0, BITS.byteSequenceContinues);
        }

        return true;
    }

    // setMultipleBytes (uint8 value, uint8 lastValue, int num)
    setRepeatedBytes (value, lastValue, num)
    {
        if (num <= 0)
            return true;

        if (num === 1)
            return this.setByteSequence ([value], 0, 1);

        const state = this.data.getState();

        if (num > BYTE_COUNT_MANY_MAX)
        {
            if (! this.setRepeatedBytes (value, lastValue, BYTE_COUNT_MANY_MAX))
            {
                this.data.restore (state);
                return false;
            }

            return this.setRepeatedBytes (value, lastValue, num - BYTE_COUNT_MANY_MAX);
        }

        if (num > BYTE_COUNT_FEW_MAX)
        {
            if (! this.data.hasCapacity (BITS.dataChangeCommand * 2 + BITS.byteCountMany + BITS.byteValue))
            {
                this.data.restore (state);
                return false;
            }

            this.data.writeBits (DataChange.setManyBytesWithValue, BITS.dataChangeCommand);
            this.data.writeBits (num, BITS.byteCountMany);
            this.data.writeBits (value, BITS.byteValue);
            return true;
        }

        if (value === lastValue)
        {
            if (! this.data.hasCapacity (BITS.dataChangeCommand * 2 + BITS.byteCountFew))
            {
                this.data.restore (state);
                return false;
            }

            this.data.writeBits (DataChange.setFewBytesWithLastValue, BITS.dataChangeCommand);
            this.data.writeBits (num, BITS.byteCountFew);
            return true;
        }

        if (! this.data.hasCapacity (BITS.dataChangeCommand * 2 + BITS.byteCountFew + BITS.byteValue))
        {
            this.data.restore (state);
            return false;
        }

        this.data.writeBits (DataChange.setFewBytesWithValue, BITS.dataChangeCommand);
        this.data.writeBits (num, BITS.byteCountFew);
        this.data.writeBits (value, BITS.byteValue);
        return true;
    }

    addProgramEventMessage (values)
    {
        if (! this.data.hasCapacity (BIT_SIZES.programEventMessage))
            return false;

        this.writeMessageType (MessageFromHost.programEventMessage);

        for (let i = 0; i < NUM_PROGRAM_MESSAGE_INTS; ++i)
            this.data.writeBits (values[i] >>> 0, 32);

        return true;
    }

    addConfigSetMessage (item, value)
    {
        if (! this.data.hasCapacity (BIT_SIZES.configSetMessage))
            return false;

        this.writeMessageType (MessageFromHost.configMessage);
        this.data.writeBits (ConfigCommand.setConfig, BITS.configCommand);
        this.data.writeBits (item & 0xFF, 8);
        this.data.writeBits (value >>> 0, 32);
        return true;
    }

    // The SDK writes the 32-bit zero before the item here
    addRequestMessage (item)
    {
        if (! this.data.hasCapacity (BIT_SIZES.configSetMessage))
            return false;

        this.writeMessageType (MessageFromHost.configMessage);
        this.data.writeBits (ConfigCommand.requestConfig, BITS.configCommand);
        this.data.writeBits (0, 32);
        this.data.writeBits (item & 0xFF, 8);
        return true;
    }
}

function buildPacket (maxBytes, deviceIndex, fill)
{
    const p = new HostPacketBuilder (maxBytes);
    p.writePacketSysexHeaderBytes (deviceIndex);

    if (! fill (p))
        return null;

    p.writePacketSysexFooter();
    return p.getBytes();
}

const commandPacket      = (deviceIndex, command)     => buildPacket (64, deviceIndex, p => p.deviceControlMessage (command));
const programEventPacket = (deviceIndex, values)      => buildPacket (128, deviceIndex, p => p.addProgramEventMessage (values));
const configSetPacket    = (deviceIndex, item, value) => buildPacket (64, deviceIndex, p => p.addConfigSetMessage (item, value));
const configRequestPacket = (deviceIndex, item)       => buildPacket (64, deviceIndex, p => p.addRequestMessage (item));

//==============================================================================
// roli_HostPacketDecoder.h. Takes a whole SysEx message (F0 ... F7); returns null if it isn't a valid BLOCKS packet,
// otherwise { deviceIndex, timestamp, messages }.

function decodePacket (bytes)
{
    const n = bytes.length;

    if (n < SYSEX_HEADER.length + 3 || bytes[n - 1] !== 0xF7)
        return null;

    for (let i = 0; i < SYSEX_HEADER.length; ++i)
        if (bytes[i] !== SYSEX_HEADER[i])
            return null;

    const start = SYSEX_HEADER.length + 1;   // after the index byte
    const size = n - 1 - start;              // body plus checksum, without F7

    if (! (size > 1 && calculatePacketChecksum (bytes, start, start + size - 1) === bytes[start + size - 1]))
        return null;

    const reader = new Packed7BitArrayReader (bytes, start, size - 1);

    if (reader.getRemainingBits() < BITS.packetTimestamp)
        return null;

    const timestamp = reader.readBits (BITS.packetTimestamp);
    const deviceIndex = bytes[SYSEX_HEADER.length] & 63;   // top bit is used as a direction indicator
    const messages = [];

    for (;;)
    {
        const type = reader.getRemainingBits() < BITS.messageType ? 0 : reader.readBits (BITS.messageType);

        if (type === 0)
            break;

        if (! decodeMessage (reader, type, deviceIndex, timestamp, messages))
            break;
    }

    return { deviceIndex, timestamp, messages };
}

function readString7 (reader, length)
{
    let s = '';

    for (let i = 0; i < length; ++i)
        s += String.fromCharCode (reader.readBits (7));

    return s;
}

function decodeMessage (reader, type, deviceIndex, timestamp, out)
{
    const remaining = () => reader.getRemainingBits();

    switch (type)
    {
        case MessageFromDevice.deviceTopology:
        case MessageFromDevice.deviceTopologyExtend:
        {
            if (remaining() < BITS.deviceCount + BITS.connectionCount)
                return false;

            const version = reader.readBits (BITS.protocolVersion);

            if (version > CURRENT_PROTOCOL_VERSION)
                return false;

            const numDevices = reader.readBits (BITS.deviceCount);
            const numConnections = reader.readBits (BITS.connectionCount);

            if (remaining() < numDevices * BIT_SIZES.topologyDeviceInfo + numConnections * BIT_SIZES.topologyConnectionInfo)
                return false;

            out.push ({ type: type === MessageFromDevice.deviceTopology ? 'beginTopology' : 'extendTopology', devices: numDevices, connections: numConnections });

            for (let i = 0; i < numDevices; ++i)
            {
                const serial = readString7 (reader, SERIAL_LENGTH);
                const index = reader.readBits (BITS.topologyIndex);
                const batteryLevel = reader.readBits (BITS.batteryLevel);
                const batteryCharging = reader.readBits (BITS.batteryCharging);
                out.push ({ type: 'topologyDevice', serial, index, batteryLevel, batteryCharging });
            }

            for (let i = 0; i < numConnections; ++i)
            {
                const device1 = reader.readBits (BITS.topologyIndex);
                const port1 = reader.readBits (BITS.connectorPort);
                const device2 = reader.readBits (BITS.topologyIndex);
                const port2 = reader.readBits (BITS.connectorPort);
                out.push ({ type: 'topologyConnection', device1, port1, device2, port2 });
            }

            if (numDevices < MAX_BLOCKS_IN_TOPOLOGY_PACKET && numConnections < MAX_CONNECTIONS_IN_TOPOLOGY_PACKET)
                out.push ({ type: 'endTopology' });

            return true;
        }

        case MessageFromDevice.deviceTopologyEnd:
        {
            if (reader.readBits (BITS.protocolVersion) > CURRENT_PROTOCOL_VERSION)
                return false;

            out.push ({ type: 'endTopology' });
            return true;
        }

        case MessageFromDevice.deviceVersion:
        case MessageFromDevice.deviceName:
        {
            const index = reader.readBits (BITS.topologyIndex);
            const length = reader.readBits (7);
            const text = readString7 (reader, length);
            out.push (type === MessageFromDevice.deviceVersion ? { type: 'version', index, version: text } : { type: 'name', index, name: text });
            return true;
        }

        case MessageFromDevice.touchStart:
        case MessageFromDevice.touchMove:
        case MessageFromDevice.touchEnd:
        case MessageFromDevice.touchStartWithVelocity:
        case MessageFromDevice.touchMoveWithVelocity:
        case MessageFromDevice.touchEndWithVelocity:
        {
            const withVelocity = type >= MessageFromDevice.touchStartWithVelocity;

            if (remaining() < (withVelocity ? BIT_SIZES.touchMessageWithVelocity : BIT_SIZES.touchMessage) - BITS.messageType)
                return false;

            const offset = reader.readBits (BITS.packetTimestampOffset);
            const touchIndex = reader.readBits (BITS.touchIndex);
            const x = reader.readBits (12), y = reader.readBits (12), z = reader.readBits (8);
            let vx = 0, vy = 0, vz = 0;

            if (withVelocity)
            {
                vx = reader.readBits (8);
                vy = reader.readBits (8);
                vz = reader.readBits (8);
            }

            const kind = withVelocity ? type - MessageFromDevice.touchStartWithVelocity : type - MessageFromDevice.touchStart;
            out.push ({ type: 'touch', index: deviceIndex, timestamp: (timestamp + offset) >>> 0, touchIndex, x, y, z, vx, vy, vz,
                        isStart: kind === 0, isEnd: kind === 2 });
            return true;
        }

        case MessageFromDevice.controlButtonDown:
        case MessageFromDevice.controlButtonUp:
        {
            if (remaining() < BIT_SIZES.controlButtonMessage - BITS.messageType)
                return false;

            const offset = reader.readBits (BITS.packetTimestampOffset);
            const buttonId = reader.readBits (BITS.controlButtonID);
            out.push ({ type: 'button', index: deviceIndex, timestamp: (timestamp + offset) >>> 0, buttonId, isDown: type === MessageFromDevice.controlButtonDown });
            return true;
        }

        case MessageFromDevice.programEventMessage:
        {
            if (remaining() < BIT_SIZES.programEventMessage - BITS.messageType)
                return false;

            const values = [];

            for (let i = 0; i < NUM_PROGRAM_MESSAGE_INTS; ++i)
                values.push (reader.readBits (32) | 0);

            out.push ({ type: 'programEvent', index: deviceIndex, timestamp, values });
            return true;
        }

        case MessageFromDevice.packetACK:
        {
            if (remaining() < BIT_SIZES.packetACK - BITS.messageType)
                return false;

            out.push ({ type: 'ack', index: deviceIndex, counter: reader.readBits (BITS.packetCounter) });
            return true;
        }

        case MessageFromDevice.firmwareUpdateACK:
        {
            if (remaining() < BITS.firmwareUpdateACKCode)
                return false;

            const code = reader.readBits (BITS.firmwareUpdateACKCode);
            const detail = reader.readBits (BITS.firmwareUpdateACKDetail);
            out.push ({ type: 'firmwareAck', index: deviceIndex, code, detail });
            return true;
        }

        case MessageFromDevice.configMessage:
        {
            const command = reader.readBits (BITS.configCommand);

            if (command === ConfigCommand.updateConfig)
            {
                const item = reader.readBits (8) | 0;
                const value = reader.readBits (32) | 0;
                const min = reader.readBits (32) | 0;
                const max = reader.readBits (32) | 0;
                out.push ({ type: 'configUpdate', index: deviceIndex, item, value, min, max });
                return true;
            }

            if (command === ConfigCommand.setConfig)
            {
                const item = reader.readBits (8) | 0;
                const value = reader.readBits (32) | 0;
                out.push ({ type: 'configSet', index: deviceIndex, item, value });
                return true;
            }

            if (command === ConfigCommand.factorySyncEnd)
                out.push ({ type: 'configFactorySyncEnd', index: deviceIndex });

            if (command === ConfigCommand.factorySyncReset)
                out.push ({ type: 'configFactorySyncReset', index: deviceIndex });

            return true;
        }

        case MessageFromDevice.logMessage:
        {
            let text = '';

            while (remaining() >= 7)
                text += String.fromCharCode (reader.readBits (7));

            out.push ({ type: 'log', index: deviceIndex, text });
            return true;
        }

        default:
            return false;
    }
}

// The packet index of a sharedDataChange packet we built
function packetIndexOf (bytes)
{
    const reader = new Packed7BitArrayReader (bytes, SYSEX_HEADER.length + 1, bytes.length - SYSEX_HEADER.length - 3);
    reader.readBits (BITS.messageType);
    return reader.readBits (BITS.packetIndex);
}

//==============================================================================
// littlefoot::Program (roli_LittleFootRunner.h): header = checksum, size, function count, global count, heap size (int16 LE)

const PROGRAM_HEADER_SIZE = 10;

const Program = {
    getStoredChecksum (b)           { return (b[0] | (b[1] << 8)) & 0xFFFF; },

    getProgramSize (b, maxSize)
    {
        const size = (b[2] | (b[3] << 8)) & 0xFFFF;
        return size < PROGRAM_HEADER_SIZE ? PROGRAM_HEADER_SIZE : (size > maxSize ? maxSize : size);
    },

    calculateChecksum (b, maxSize)
    {
        const size = Program.getProgramSize (b, maxSize);
        let n = size & 0xFFFF;

        for (let i = 2; i < size; ++i)
            n = (n + (n * 2) + b[i]) & 0xFFFF;

        return n;
    },

    checksumMatches (b, maxSize)    { return Program.calculateChecksum (b, maxSize) === Program.getStoredChecksum (b); },

    writeInt32 (b, offset, value)
    {
        b[offset] = value & 0xFF;
        b[offset + 1] = (value >>> 8) & 0xFF;
        b[offset + 2] = (value >>> 16) & 0xFF;
        b[offset + 3] = (value >>> 24) & 0xFF;
    },

    updateChecksum (b)
    {
        const n = Program.calculateChecksum (b, b.length);
        b[0] = n & 0xFF;
        b[1] = (n >> 8) & 0xFF;
    }
};

//==============================================================================
// roli_LittleFootRemoteHeap.h

const UNKNOWN_BYTE = 0x100;

// Doubly linked ranges: the SDK keeps these in an array and removes elements one at a time, which is quadratic.
// coalesce() walks the list with the SDK loop's exact index arithmetic, so the merges happen in the same order.
function makeRangeList (count, init)
{
    const list = { head: null, tail: null, size: 0 };

    for (let i = 0; i < count; ++i)
    {
        const node = init (i);
        node.prev = list.tail;
        node.next = null;

        if (list.tail) list.tail.next = node; else list.head = node;

        list.tail = node;
        ++list.size;
    }

    return list;
}

function removeNode (list, node)
{
    if (node.prev) node.prev.next = node.next; else list.head = node.next;
    if (node.next) node.next.prev = node.prev; else list.tail = node.prev;
    --list.size;
}

// for (int i = ranges.size(); --i > 0;) { r1 = ranges[i - 1]; r2 = ranges[i];
//     if (merge (r1, r2)) { ranges.remove (i); i = jmin (ranges.size() - 1, i + 1); } }
function coalesce (list, tryMerge)
{
    let i = list.size;
    let cur = null;   // node at index i; null while i == size

    for (;;)
    {
        --i;
        cur = cur === null ? list.tail : cur.prev;

        if (! (i > 0))
            break;

        const r2 = cur, r1 = cur.prev;

        if (tryMerge (r1, r2))
        {
            const next = r2.next;
            removeNode (list, r2);

            if (i + 1 <= list.size - 1)
            {
                i = i + 1;
                cur = next.next;
            }
            else
            {
                i = list.size - 1;
                cur = list.tail;
            }
        }
    }
}

function diffRanges (current, target, blockSize)
{
    const list = makeRangeList (blockSize, i => ({ index: i, length: 1, isSkipped: target[i] === current[i], isMixed: false }));

    // coalesceUniformRegions
    coalesce (list, (r1, r2) =>
    {
        if (r1.isSkipped === r2.isSkipped && (r1.isSkipped || target[r1.index] === target[r2.index]))
        {
            r1.length += r2.length;
            return true;
        }

        return false;
    });

    // coalesceSequences
    coalesce (list, (r1, r2) =>
    {
        if (! (r1.isSkipped || r2.isSkipped) && (r1.isMixed || r1.length === 1) && (r2.isMixed || r2.length === 1)
             && r1.length + r2.length < 32)
        {
            r1.length += r2.length;
            r1.isMixed = true;
            return true;
        }

        return false;
    });

    // trim
    while (list.size > 0 && list.tail.isSkipped)
        removeNode (list, list.tail);

    const ranges = [];

    for (let r = list.head; r; r = r.next)
        ranges.push (r);

    return ranges;
}

class RemoteHeap
{
    constructor ({ blockSize = PROGRAM_AND_HEAP_SIZE, maxBlockSize = PROGRAM_AND_HEAP_SIZE, maxPacketCounter = PACKET_COUNTER_MAX,
                   maxPacketSize = MAX_PACKET_SIZE, getDeviceIndex, sendMessageToDevice, now = () => Date.now() })
    {
        this.blockSize = blockSize;
        this.maxBlockSize = maxBlockSize;
        this.maxPacketCounter = maxPacketCounter;
        this.maxPacketSize = maxPacketSize;
        this.getDeviceIndex = getDeviceIndex;
        this.sendMessageToDevice = sendMessageToDevice;
        this.now = now;

        this.deviceState = new Uint16Array (maxBlockSize);
        this.targetData = new Uint8Array (maxBlockSize);
        this.programSize = 0;
        this.needsSyncing = true;
        this.programStateKnown = true;
        this.programLoaded = false;
        this.messagesSent = [];
        this.lastPacketIndexReceived = 0;

        this.resetDeviceStateToUnknown();
    }

    reset()
    {
        this.clearTargetData();
        this.resetDeviceStateToUnknown();
        this.lastPacketIndexReceived = 0;
    }

    clearTargetData()
    {
        this.targetData.fill (0);
        this.needsSyncing = true;
        this.programStateKnown = false;
    }

    resetDeviceStateToUnknown()
    {
        this.needsSyncing = true;
        this.programStateKnown = false;
        this.messagesSent = [];
        this.resetDataRangeToUnknown (0, this.maxBlockSize);

        // Not in the SDK: lets the owner clear the target before the next sendChanges() sends all of it again
        if (this.onDeviceStateReset)
            this.onDeviceStateReset();
    }

    resetDataRangeToUnknown (offset, size)
    {
        const state = this.getLatestExpectedDataState();

        for (let i = 0; i < size; ++i)
            state[offset + i] = UNKNOWN_BYTE;
    }

    setByte (offset, value)
    {
        if (offset >= this.blockSize)
            return;

        if (this.targetData[offset] !== value)
        {
            this.targetData[offset] = value;
            this.needsSyncing = true;

            if (offset < this.programSize)
                this.programStateKnown = false;
        }
    }

    setBytes (offset, data)
    {
        for (let i = 0; i < data.length; ++i)
            this.setByte (offset + i, data[i]);
    }

    getByte (offset)            { return offset < this.blockSize ? this.targetData[offset] : 0; }
    isFullySynced()             { return ! this.needsSyncing; }

    getLatestExpectedDataState()
    {
        return this.messagesSent.length === 0 ? this.deviceState : this.messagesSent[this.messagesSent.length - 1].resultDataState;
    }

    getTotalSizeOfMessagesSent()
    {
        let total = 0;

        for (const m of this.messagesSent)
            if (m.dispatchTime !== 0)
                total += m.packet.length;

        return total;
    }

    sendChanges (forceSend)
    {
        if ((this.needsSyncing && this.messagesSent.length === 0) || forceSend)
        {
            for (let maxChanges = 30; --maxChanges >= 0;)
            {
                if (isAllZero (this.targetData, this.blockSize))
                    break;

                const data = new Uint16Array (this.maxBlockSize);
                data.set (this.getLatestExpectedDataState().subarray (0, this.blockSize));

                let packetIndex = this.messagesSent.length === 0 ? this.lastPacketIndexReceived
                                                                 : this.messagesSent[this.messagesSent.length - 1].packetIndex;

                packetIndex = (packetIndex + 1) & this.maxPacketCounter;

                if (! this.createChangeMessage (data, packetIndex))
                    break;
            }
        }

        for (const m of this.messagesSent)
        {
            const now = this.now();

            if (m.dispatchTime >= now - RESEND_AFTER_MS)
                break;

            m.dispatchTime = now;
            this.sendMessageToDevice (m.packet);

            if (this.getTotalSizeOfMessagesSent() > 200)
                break;
        }
    }

    // Diff::createChangeMessage; returns true when the packet overflowed (more changes follow)
    createChangeMessage (currentState, nextPacketIndex)
    {
        const ranges = diffRanges (currentState, this.targetData, this.blockSize);

        if (ranges.length === 0)
            return false;

        const deviceIndex = this.getDeviceIndex();

        if (deviceIndex < 0)
            return false;

        const message = { packetIndex: nextPacketIndex, dispatchTime: 0, packet: null, resultDataState: new Uint16Array (this.maxBlockSize) };
        message.resultDataState.set (currentState.subarray (0, this.blockSize));
        this.messagesSent.push (message);

        const p = new HostPacketBuilder (this.maxPacketSize);
        p.writePacketSysexHeaderBytes (deviceIndex);
        p.beginDataChanges (nextPacketIndex);

        const newData = this.targetData;
        let lastValue = 0;
        let packetOverflow = false;

        for (const r of ranges)
        {
            if (r.isSkipped)
            {
                packetOverflow = ! p.skipBytes (r.length);
            }
            else if (r.isMixed)
            {
                packetOverflow = ! p.setByteSequence (newData, r.index, r.length);

                if (! packetOverflow)
                    lastValue = newData[r.index + r.length - 1];
            }
            else
            {
                const value = newData[r.index];
                packetOverflow = ! p.setRepeatedBytes (value, lastValue, r.length);

                if (! packetOverflow)
                    lastValue = value;
            }

            if (packetOverflow)
                break;

            if (! r.isSkipped)
                for (let i = r.index; i < r.index + r.length; ++i)
                    message.resultDataState[i] = newData[i];
        }

        p.endDataChanges (! packetOverflow);
        p.writePacketSysexFooter();
        message.packet = p.getBytes();

        return packetOverflow;
    }

    handleACKFromDevice (packetIndex)
    {
        if (packetIndex === this.lastPacketIndexReceived)
            return;

        this.lastPacketIndexReceived = packetIndex;

        for (let i = this.messagesSent.length; --i >= 0;)
        {
            const m = this.messagesSent[i];

            if (m.packetIndex === packetIndex)
            {
                this.deviceState.set (m.resultDataState.subarray (0, this.blockSize));
                this.programStateKnown = false;
                this.messagesSent.splice (0, i + 1);
                this.sendChanges (false);

                if (this.messagesSent.length === 0)
                    this.needsSyncing = false;

                return;
            }
        }

        this.resetDeviceStateToUnknown();
    }

    isProgramLoaded()
    {
        if (! this.programStateKnown)
        {
            const memory = new Uint8Array (this.maxBlockSize);

            for (let i = 0; i < this.blockSize; ++i)
                memory[i] = this.deviceState[i] & 0xFF;

            this.programLoaded = Program.checksumMatches (memory, this.blockSize);
            this.programSize = Program.getProgramSize (memory, this.blockSize);
            this.programStateKnown = true;
        }

        return this.programLoaded;
    }
}

function isAllZero (data, size)
{
    for (let i = 0; i < size; ++i)
        if (data[i] !== 0)
            return false;

    return true;
}

//==============================================================================
// Connection to one keyboard, following roli_ConnectedDeviceGroup.cpp and BlockImplementation: topology request,
// API mode retries until the device ACKs, pings, ping timeout, shared-memory sync, program upload and save.
// The page calls tick() on a timer (about every 20 ms) and handleMidiMessage() for every incoming SysEx.

class BlocksConnection
{
    // resendAfterReset: when the device's memory state is lost (ping timeout, an ACK for a packet that wasn't sent),
    // the SDK sends its whole target memory again, which rewrites the program and zeroes the memory the program uses.
    // With false the target is cleared instead, and a 'memoryUnknown' event tells the caller to check what runs first.
    constructor ({ send, now = () => Date.now(), onEvent = () => {}, resendAfterReset = true })
    {
        this.send = send;
        this.now = now;
        this.onEvent = onEvent;
        this.resendAfterReset = resendAfterReset;

        this.deviceIndex = -1;
        this.device = null;
        this.pendingDevices = [];
        this.apiConnected = false;
        this.lastAckTime = 0;
        this.lastPingSendTime = 0;
        this.lastApiTryTime = 0;
        this.lastTopologyRequestTime = 0;
        this.topologyRequestsSent = 0;
        this.running = false;

        this.programSize = 0;
        this.uploading = false;
        this.programLoaded = false;
        this.saveWhenLoaded = false;

        this.heap = new RemoteHeap ({
            getDeviceIndex: () => this.deviceIndex,
            sendMessageToDevice: packet => this.sendPacket (packet, 'data'),
            now: this.now
        });

        this.heap.onDeviceStateReset = () => this.handleDeviceStateReset();
    }

    sendPacket (packet, what)
    {
        this.send (packet);
        this.onEvent ({ type: 'sent', what, bytes: packet });
    }

    start()
    {
        this.running = true;
        this.requestTopology();
    }

    stop (endApiMode = true)
    {
        if (endApiMode && this.deviceIndex >= 0)
            this.sendPacket (commandPacket (this.deviceIndex, DeviceCommand.endAPIMode), 'endAPIMode');

        this.running = false;
        this.apiConnected = false;
        this.onEvent ({ type: 'stopped' });
    }

    requestTopology()
    {
        ++this.topologyRequestsSent;
        this.lastTopologyRequestTime = this.now();
        this.sendPacket (commandPacket (0, DeviceCommand.requestTopologyMessage), 'requestTopology');
    }

    tick()
    {
        if (! this.running)
            return;

        const now = this.now();

        if (this.device === null)
        {
            if (now > this.lastTopologyRequestTime + 1000 && this.topologyRequestsSent < 4)
                this.requestTopology();
            else if (this.topologyRequestsSent >= 4 && now > this.lastTopologyRequestTime + 1000)
            {
                this.onEvent ({ type: 'error', message: 'No topology reply after 4 requests. Is another program (ROLI Connect, the ROLI Hardware Driver service) holding the keyboard?' });
                this.topologyRequestsSent = 0;
                this.lastTopologyRequestTime = now + 4000;
            }

            return;
        }

        if (! this.apiConnected)
        {
            if (now >= this.lastApiTryTime + API_RETRY_INTERVAL_MS)
            {
                this.lastApiTryTime = now;
                this.sendPacket (commandPacket (this.deviceIndex, DeviceCommand.endAPIMode), 'endAPIMode');
                this.sendPacket (commandPacket (this.deviceIndex, DeviceCommand.beginAPIMode), 'beginAPIMode');
            }

            return;
        }

        if (now > this.lastAckTime + PING_TIMEOUT_MS)
        {
            this.apiConnected = false;
            this.heap.resetDeviceStateToUnknown();
            this.onEvent ({ type: 'apiDisconnected' });
            return;
        }

        this.heap.sendChanges (false);

        if (now >= this.lastPingSendTime + MASTER_PING_INTERVAL_MS)
        {
            this.lastPingSendTime = now;
            this.sendPacket (commandPacket (this.deviceIndex, DeviceCommand.ping), 'ping');
        }

        if (this.uploading && this.heap.isFullySynced() && this.heap.isProgramLoaded())
        {
            this.uploading = false;
            this.programLoaded = true;
            this.onEvent ({ type: 'programLoaded' });

            if (this.saveWhenLoaded)
                this.saveProgramAsDefault();
        }
    }

    handleMidiMessage (bytes)
    {
        const packet = decodePacket (bytes);

        if (packet === null)
            return false;

        this.onEvent ({ type: 'received', bytes, packet });

        for (const m of packet.messages)
        {
            switch (m.type)
            {
                case 'beginTopology':   this.pendingDevices = []; break;
                case 'extendTopology':  break;
                case 'topologyDevice':  this.pendingDevices.push (m); break;

                case 'endTopology':
                {
                    const devices = this.pendingDevices;
                    this.pendingDevices = [];
                    const chosen = devices.find (d => d.serial.startsWith ('LKB')) || devices[0] || null;
                    this.onEvent ({ type: 'topology', devices, chosen });

                    if (chosen !== null)
                    {
                        const changed = this.device === null || this.device.serial !== chosen.serial || this.deviceIndex !== chosen.index;
                        this.device = chosen;
                        this.deviceIndex = chosen.index;
                        this.topologyRequestsSent = 0;

                        if (changed)
                        {
                            this.apiConnected = false;
                            this.lastApiTryTime = 0;
                        }
                    }
                    break;
                }

                case 'ack':
                {
                    if (m.index !== this.deviceIndex)
                        break;

                    this.lastAckTime = this.now();
                    const connecting = ! this.apiConnected;

                    if (connecting)
                    {
                        this.apiConnected = true;
                        this.lastPingSendTime = 0;
                    }

                    // Before the event: taking the device's packet counter can reset the memory state, which mustn't
                    // undo what a listener starts on connecting
                    this.heap.handleACKFromDevice (m.counter);

                    if (connecting)
                        this.onEvent ({ type: 'apiConnected', counter: m.counter });

                    break;
                }

                default:
                    this.onEvent ({ type: 'message', message: m });
            }
        }

        return true;
    }

    handleDeviceStateReset()
    {
        if (this.resendAfterReset)
            return;

        const hadTarget = ! isAllZero (this.heap.targetData, this.heap.blockSize);

        this.heap.clearTargetData();
        this.uploading = false;
        this.saveWhenLoaded = false;
        this.programLoaded = false;

        if (hadTarget)
            this.onEvent ({ type: 'memoryUnknown' });
    }

    // Not in the SDK: for a device the caller knows runs exactly these program bytes (the program said so), takes
    // them, followed by zeros, as both the device's memory and the target without sending anything. setHeapBytes()
    // then sends only the bytes it changes; memory the program uses itself is never sent unless the caller writes it.
    adoptProgram (programBytes)
    {
        const heap = this.heap;

        if (! this.apiConnected || this.uploading || heap.messagesSent.length > 0)
            return false;

        heap.targetData.fill (0);
        heap.targetData.set (programBytes);
        heap.deviceState.fill (0);
        heap.deviceState.set (programBytes);
        heap.needsSyncing = false;
        heap.programStateKnown = false;

        this.programSize = programBytes.length;
        this.programLoaded = heap.isProgramLoaded();
        return this.programLoaded;
    }

    // BlockImplementation::loadProgram
    uploadProgram (programBytes, saveAsDefault)
    {
        this.programSize = programBytes.length;
        this.programLoaded = false;
        this.uploading = true;
        this.saveWhenLoaded = saveAsDefault;

        this.heap.resetDataRangeToUnknown (0, this.heap.blockSize);
        this.heap.clearTargetData();
        this.heap.sendChanges (true);

        this.heap.resetDataRangeToUnknown (0, programBytes.length);
        this.heap.setBytes (0, programBytes);
        this.heap.sendChanges (true);
    }

    // Block::setDataBytes: offsets are relative to the end of the program
    setHeapBytes (offset, bytes)
    {
        this.heap.setBytes (this.programSize + offset, bytes);
    }

    sendProgramEvent (values)
    {
        if (this.deviceIndex >= 0)
            this.sendPacket (programEventPacket (this.deviceIndex, values), 'programEvent');
    }

    saveProgramAsDefault()
    {
        this.saveWhenLoaded = false;
        this.sendPacket (commandPacket (this.deviceIndex, DeviceCommand.saveProgramAsDefault), 'saveProgramAsDefault');
        this.onEvent ({ type: 'saveSent' });
    }

    syncProgress()
    {
        const heap = this.heap;
        let known = 0, matching = 0;

        for (let i = 0; i < heap.blockSize; ++i)
        {
            if (heap.deviceState[i] !== UNKNOWN_BYTE)
                ++known;

            if (heap.deviceState[i] === heap.targetData[i])
                ++matching;
        }

        return { known, matching, total: heap.blockSize, pendingPackets: heap.messagesSent.length };
    }
}

//==============================================================================
const toHex = bytes => Array.from (bytes, b => b.toString (16).padStart (2, '0')).join ('');

const fromHex = hex =>
{
    const out = new Uint8Array (hex.length / 2);

    for (let i = 0; i < out.length; ++i)
        out[i] = parseInt (hex.substr (i * 2, 2), 16);

    return out;
};

return {
    SYSEX_HEADER, MessageFromDevice, MessageFromHost, DeviceCommand, ConfigCommand, DataChange,
    PROGRAM_AND_HEAP_SIZE, UNKNOWN_BYTE,
    calculatePacketChecksum, Packed7BitArrayBuilder, Packed7BitArrayReader, HostPacketBuilder,
    commandPacket, programEventPacket, configSetPacket, configRequestPacket,
    decodePacket, packetIndexOf, Program, RemoteHeap, BlocksConnection, toHex, fromHex
};
});
