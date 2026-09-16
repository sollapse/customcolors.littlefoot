// Reference packets from the BLOCKS SDK's own protocol code (roli_blocks_basics), written as JSON so the
// JavaScript port can be checked byte for byte. usage: sdkvec program.bin out.json
#include <juce_core/juce_core.h>
#include <climits>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <deque>
#include <string>
#include <vector>
namespace roli { using namespace juce; }
namespace littlefoot { using juce::readLittleEndianBitsInBuffer; using juce::writeLittleEndianBitsInBuffer; }
#include "roli_LittleFootRunner.h"
#include "roli_LittleFootRemoteHeap.h"
#include "roli_BitPackingUtilities.h"
#include "roli_BlocksProtocolDefinitions.h"
#include "roli_HostPacketBuilder.h"
#include "roli_HostPacketDecoder.h"

using namespace roli::BlocksProtocol;
using Bytes = std::vector<juce::uint8>;

static std::string hex (const Bytes& b)
{
    static const char* digits = "0123456789abcdef";
    std::string s;
    for (auto v : b) { s += digits[v >> 4]; s += digits[v & 15]; }
    return s;
}

static std::string q (const std::string& t)
{
    std::string o = "\"";
    for (char c : t) { if (c == '"' || c == '\\') o += '\\'; o += c; }
    return o + "\"";
}

template <typename B>
static Bytes bytesOf (const B& b)
{
    auto* d = (const juce::uint8*) b.getData();
    return Bytes (d, d + b.size());
}

static std::string fmt (const char* f, ...)
{
    char buf[512];
    va_list args;
    va_start (args, f);
    std::vsnprintf (buf, sizeof (buf), f, args);
    va_end (args);
    return buf;
}

struct FakeBlock
{
    static constexpr juce::uint32 maxBlockSize = 7200;
    static constexpr juce::uint32 maxPacketCounter = PacketCounter::maxValue;
    using PacketBuilder = HostPacketBuilder<200>;

    int getDeviceIndex() const { return 0; }

    std::vector<Bytes> sent;

    template <typename B>
    void sendMessageToDevice (const B& b) { sent.push_back (bytesOf (b)); }
};

static juce::uint32 packetIndexOf (const Bytes& p)
{
    Packed7BitArrayReader r (p.data() + 6, (int) p.size() - 8);
    r.readBits (7);
    return r.readBits (16);
}

struct Recorder
{
    std::vector<std::string> t;

    void beginTopology (int d, int c)     { t.push_back (fmt ("beginTopology devices=%d connections=%d", d, c)); }
    void extendTopology (int d, int c)    { t.push_back (fmt ("extendTopology devices=%d connections=%d", d, c)); }
    void endTopology()                    { t.push_back ("endTopology"); }

    void handleTopologyDevice (DeviceStatus s)
    {
        std::string serial ((const char*) s.serialNumber.data, s.serialNumber.length);
        t.push_back (fmt ("device serial=%s index=%d battery=%u charging=%u", serial.c_str(), (int) s.index,
                          (unsigned) s.batteryLevel.get(), (unsigned) s.batteryCharging.get()));
    }

    void handleTopologyConnection (DeviceConnection c)
    {
        t.push_back (fmt ("connection %d:%u %d:%u", (int) c.device1, (unsigned) c.port1.get(), (int) c.device2, (unsigned) c.port2.get()));
    }

    void handleVersion (DeviceVersion v)  { t.push_back (fmt ("version index=%d %s", (int) v.index, std::string ((const char*) v.version.data, v.version.length).c_str())); }
    void handleName (DeviceName n)        { t.push_back (fmt ("name index=%d %s", (int) n.index, std::string ((const char*) n.name.data, n.name.length).c_str())); }

    void handleTouchChange (TopologyIndex i, juce::uint32 ts, TouchIndex ti, TouchPosition p, TouchVelocity v, bool s, bool e)
    {
        t.push_back (fmt ("touch index=%d ts=%u touch=%u x=%u y=%u z=%u vx=%u vy=%u vz=%u start=%d end=%d", (int) i, ts,
                          (unsigned) ti.get(), (unsigned) p.x.get(), (unsigned) p.y.get(), (unsigned) p.z.get(),
                          (unsigned) v.vx.get(), (unsigned) v.vy.get(), (unsigned) v.vz.get(), (int) s, (int) e));
    }

    void handleControlButtonUpDown (TopologyIndex i, juce::uint32 ts, ControlButtonID id, bool down)
    {
        t.push_back (fmt ("button index=%d ts=%u id=%u down=%d", (int) i, ts, (unsigned) id.get(), (int) down));
    }

    void handleCustomMessage (TopologyIndex i, juce::uint32 ts, const juce::int32* d)
    {
        t.push_back (fmt ("program index=%d ts=%u %d %d %d", (int) i, ts, d[0], d[1], d[2]));
    }

    void handlePacketACK (TopologyIndex i, PacketCounter c)  { t.push_back (fmt ("ack index=%d counter=%u", (int) i, (unsigned) c.get())); }

    void handleFirmwareUpdateACK (TopologyIndex i, FirmwareUpdateACKCode c, FirmwareUpdateACKDetail d)
    {
        t.push_back (fmt ("firmwareAck index=%d code=%u detail=%u", (int) i, (unsigned) c.get(), (unsigned) d.get()));
    }

    void handleConfigUpdateMessage (TopologyIndex i, juce::int32 item, juce::int32 value, juce::int32 mn, juce::int32 mx)
    {
        t.push_back (fmt ("configUpdate index=%d item=%d value=%d min=%d max=%d", (int) i, item, value, mn, mx));
    }

    void handleConfigSetMessage (TopologyIndex i, juce::int32 item, juce::int32 value)
    {
        t.push_back (fmt ("configSet index=%d item=%d value=%d", (int) i, item, value));
    }

    void handleConfigFactorySyncEndMessage (TopologyIndex i)   { t.push_back (fmt ("configFactorySyncEnd index=%d", (int) i)); }
    void handleConfigFactorySyncResetMessage (TopologyIndex i) { t.push_back (fmt ("configFactorySyncReset index=%d", (int) i)); }
    void handleLogMessage (TopologyIndex i, const juce::String& m) { t.push_back (fmt ("log index=%d %s", (int) i, m.toRawUTF8())); }
};

// A device-to-host packet, laid out the way HostPacketDecoder reads it
struct Dev
{
    Packed7BitArrayBuilder<200> b;

    Dev (int index, juce::uint32 ts)                  { b.writeHeaderSysexBytes ((juce::uint8) (0x40 | index)); b.writeBits (ts, 32); }
    Dev& w (juce::uint32 v, int n)                    { b.writeBits (v, n); return *this; }
    Dev& str (const char* s, int n)                   { for (int i = 0; i < n; ++i) b.writeBits ((juce::uint32) s[i], 7); return *this; }
    Bytes done()                                      { b.writePacketSysexFooter(); return bytesOf (b); }
};

static std::string list (const std::vector<std::string>& items, const char* indent)
{
    std::string s = "[";
    for (size_t i = 0; i < items.size(); ++i)
        s += (i ? ",\n" : "\n") + std::string (indent) + q (items[i]);
    return s + "\n" + std::string (indent).substr (2) + "]";
}

int main (int argc, char** argv)
{
    if (argc < 3) { std::fprintf (stderr, "usage: sdkvec program.bin out.json\n"); return 2; }

    juce::MemoryBlock mb;
    if (! juce::File (juce::String (argv[1])).loadFileAsData (mb)) return 1;
    Bytes program ((const juce::uint8*) mb.getData(), (const juce::uint8*) mb.getData() + mb.getSize());

    std::string json = "{\n";

    // Device commands
    json += "  \"commands\": [";
    bool first = true;
    for (int index : { 0, 5 })
        for (int cmd : { 0, 1, 2, 3, 5 })
        {
            HostPacketBuilder<64> p;
            p.writePacketSysexHeaderBytes ((TopologyIndex) index);
            p.deviceControlMessage (DeviceCommand ((juce::uint32) cmd));
            p.writePacketSysexFooter();
            json += fmt ("%s\n    { \"index\": %d, \"command\": %d, \"hex\": ", first ? "" : ",", index, cmd) + q (hex (bytesOf (p))) + " }";
            first = false;
        }
    json += "\n  ],\n";

    // Program events
    json += "  \"programEvents\": [";
    first = true;
    const juce::int32 eventValues[][3] = { { 1, 7, (juce::int32) 0xFF112233 }, { 5, 0, 0 }, { -1, INT_MIN, 123456789 } };
    for (int index : { 0, 3 })
        for (auto& v : eventValues)
        {
            HostPacketBuilder<128> p;
            p.writePacketSysexHeaderBytes ((TopologyIndex) index);
            p.addProgramEventMessage (v);
            p.writePacketSysexFooter();
            json += fmt ("%s\n    { \"index\": %d, \"values\": [%d, %d, %d], \"hex\": ", first ? "" : ",", index, v[0], v[1], v[2]) + q (hex (bytesOf (p))) + " }";
            first = false;
        }
    json += "\n  ],\n";

    // Config set and request
    json += "  \"configSet\": [";
    first = true;
    const juce::int32 configs[][2] = { { 3, 48 }, { 64, 0x7FFFFFFF }, { 95, -5 } };
    for (auto& c : configs)
    {
        HostPacketBuilder<64> p;
        p.writePacketSysexHeaderBytes (0);
        p.addConfigSetMessage (c[0], c[1]);
        p.writePacketSysexFooter();
        json += fmt ("%s\n    { \"index\": 0, \"item\": %d, \"value\": %d, \"hex\": ", first ? "" : ",", c[0], c[1]) + q (hex (bytesOf (p))) + " }";
        first = false;
    }
    json += "\n  ],\n  \"configRequest\": [";
    first = true;
    for (int item : { 95, 3 })
    {
        HostPacketBuilder<64> p;
        p.writePacketSysexHeaderBytes (0);
        p.addRequestMessage (item);
        p.writePacketSysexFooter();
        json += fmt ("%s\n    { \"index\": 0, \"item\": %d, \"hex\": ", first ? "" : ",", item) + q (hex (bytesOf (p))) + " }";
        first = false;
    }
    json += "\n  ],\n";

    // Program upload and heap writes, replaying BlockImplementation::loadProgram with a device that ACKs every packet in order
    FakeBlock bi;
    littlefoot::LittleFootRemoteHeap<FakeBlock> heap (7200);
    std::vector<std::string> ev;
    std::deque<juce::uint32> unacked;
    size_t reported = 0;

    auto flush = [&]
    {
        for (; reported < bi.sent.size(); ++reported)
        {
            ev.push_back ("send " + hex (bi.sent[reported]));
            unacked.push_back (packetIndexOf (bi.sent[reported]));
        }
    };

    auto ackAll = [&]
    {
        for (int guard = 0; ! unacked.empty() && guard < 5000; ++guard)
        {
            auto idx = unacked.front();
            unacked.pop_front();
            ev.push_back ("ack " + std::to_string (idx));
            heap.handleACKFromDevice (bi, idx);
            flush();
        }
    };

    auto status = [&]
    {
        ev.push_back (heap.isFullySynced() ? "synced" : "not synced");
        ev.push_back (heap.isProgramLoaded() ? "program loaded" : "program not loaded");
    };

    ev.push_back ("step upload");
    heap.resetDataRangeToUnknown (0, 7200);
    heap.clearTargetData();
    heap.sendChanges (bi, true);
    flush();
    heap.resetDataRangeToUnknown (0, program.size());
    heap.setBytes (0, program.data(), program.size());
    heap.sendChanges (bi, true);
    flush();
    ackAll();
    status();

    ev.push_back ("step heap test value");
    const juce::uint8 magic[] = { 0x31, 0x4D, 0x50, 0x4C };
    heap.setBytes (program.size(), magic, 4);
    heap.sendChanges (bi, false);
    flush();
    ackAll();
    status();

    ev.push_back ("step scattered writes");
    heap.setByte (program.size() + 20, 7);
    heap.setByte (program.size() + 400, 9);
    heap.setByte (5000, 200);
    heap.sendChanges (bi, false);
    flush();
    ackAll();
    status();

    ev.push_back ("step unknown ack");
    heap.handleACKFromDevice (bi, 900);
    flush();
    heap.sendChanges (bi, false);
    flush();
    ackAll();
    status();

    json += "  \"upload\": {\n    \"programHex\": " + q (hex (program)) + ",\n    \"events\": " + list (ev, "      ") + "\n  },\n";

    // Device-to-host packets through HostPacketDecoder
    std::vector<std::pair<std::string, Bytes>> dv;
    dv.push_back ({ "topology", Dev (0, 1000).w (1, 7).w (1, 8).w (1, 7).w (0, 8).str ("LKB0123456789ABC", 16).w (0, 7).w (20, 5).w (1, 1).done() });
    dv.push_back ({ "topology end", Dev (0, 1002).w (5, 7).w (1, 8).done() });
    dv.push_back ({ "topology two devices", Dev (0, 1001).w (1, 7).w (1, 8).w (2, 7).w (1, 8)
                        .str ("LKB0123456789ABC", 16).w (0, 7).w (31, 5).w (0, 1)
                        .str ("SBB0000000000001", 16).w (1, 7).w (3, 5).w (1, 1)
                        .w (0, 7).w (4, 5).w (1, 7).w (9, 5).done() });
    dv.push_back ({ "ack", Dev (0, 2000).w (2, 7).w (17, 10).done() });
    dv.push_back ({ "program event", Dev (0, 3000).w (0x28, 7).w (6, 32).w (0x504F4331, 32).w (0, 32).done() });
    dv.push_back ({ "program event negative", Dev (2, 3001).w (0x28, 7).w (0xFFFFFFFFu, 32).w (0x80000000u, 32).w (123456789, 32).done() });
    dv.push_back ({ "button down", Dev (0, 4000).w (0x20, 7).w (3, 5).w (1, 12).done() });
    dv.push_back ({ "button up", Dev (0, 4001).w (0x21, 7).w (0, 5).w (2, 12).done() });
    dv.push_back ({ "config update", Dev (0, 5000).w (0x18, 7).w (4, 4).w (3, 8).w (48, 32).w (1, 32).w (96, 32).done() });
    dv.push_back ({ "config set", Dev (0, 5001).w (0x18, 7).w (0, 4).w (64, 8).w (0x3FFFFFFF, 32).done() });
    dv.push_back ({ "config sync end", Dev (0, 5002).w (0x18, 7).w (7, 4).done() });
    dv.push_back ({ "log", Dev (0, 6000).w (0x30, 7).str ("poc ok", 6).done() });
    dv.push_back ({ "version", Dev (0, 7000).w (6, 7).w (0, 7).w (5, 7).str ("1.2.3", 5).done() });
    dv.push_back ({ "name", Dev (0, 7001).w (7, 7).w (0, 7).w (7, 7).str ("Piano M", 7).done() });
    dv.push_back ({ "ack then program event", Dev (0, 8000).w (2, 7).w (5, 10).w (0x28, 7).w (2, 32).w (1, 32).w (7, 32).done() });
    dv.push_back ({ "touch with velocity", Dev (0, 9000).w (0x13, 7).w (1, 5).w (2, 5).w (100, 12).w (200, 12).w (50, 8).w (1, 8).w (2, 8).w (3, 8).done() });
    dv.push_back ({ "firmware ack", Dev (0, 9500).w (3, 7).w (5, 7).w (77, 32).done() });

    auto bad = Dev (0, 2000).w (2, 7).w (17, 10).done();
    bad[bad.size() - 2] ^= 0x01;
    dv.push_back ({ "bad checksum", bad });

    json += "  \"decode\": [";
    for (size_t i = 0; i < dv.size(); ++i)
    {
        Recorder r;
        auto& p = dv[i].second;
        HostPacketDecoder<Recorder>::processNextPacket (r, p[5], p.data() + 6, (int) p.size() - 7);
        json += std::string (i ? "," : "") + "\n    { \"name\": " + q (dv[i].first) + ", \"hex\": " + q (hex (p)) + ", \"trace\": " + list (r.t, "        ") + " }";
    }
    json += "\n  ]\n}\n";

    auto* f = std::fopen (argv[2], "wb");
    if (f == nullptr) return 1;
    std::fwrite (json.data(), 1, json.size(), f);
    std::fclose (f);
    std::printf ("wrote %s: upload events %d, decode vectors %d\n", argv[2], (int) ev.size(), (int) dv.size());
    return 0;
}
