// Runs a littlefoot script in the BLOCKS SDK bytecode runner with MIDI, LED, config and host message natives logged,
// driven by a scenario file of key/button/setting/message events.
// usage: lfsim script.littlefoot scenario.txt   (Dashboard metadata variables become settable globals)
//        lfsim program.bin scenario.txt         (compiled program, e.g. one the web editor patched)
#include <juce_core/juce_core.h>
#include <algorithm>
#include <climits>
#include <cstdio>
#include <cstring>
#include <regex>
#include <map>
#include <vector>
#include <fstream>
#include <sstream>
namespace roli { using namespace juce; }
namespace littlefoot { using juce::readLittleEndianBitsInBuffer; }
#include "roli_LittleFootRunner.h"
#include "roli_LittleFootCompiler.h"
#include "natives.inc"

using namespace littlefoot;
using LFRunner = Runner<16384, 4096>;

// Config items: values survive a reboot like the device's flash; user items 64-95 default to a 0-127 range
static int32 cfgVals[128];
static int32 cfgMin[128], cfgMax[128];
static bool hostConnected = false;

static void resetConfigRanges()
{
    for (int i = 0; i < 128; ++i)
    {
        bool user = i >= 64 && i <= 95;
        cfgMin[i] = user ? 0 : INT_MIN;
        cfgMax[i] = user ? 127 : INT_MAX;
    }
}

static void setConfig (int32 item, int32 value)
{
    int i = item & 127;
    cfgVals[i] = std::clamp (value, cfgMin[i], cfgMax[i]);

    std::printf ("    Config %d = %d%s\n", i, cfgVals[i], cfgVals[i] != value ? " (clamped)" : "");
}

static void logm (const char* n, const int32* a, int k)
{
    std::printf ("    %s", n);
    for (int i = 0; i < k; ++i) std::printf (" %d", a[i]);
    std::printf ("\n");
}

static float toFloat (int32 v)  { float f; std::memcpy (&f, &v, sizeof (f)); return f; }
static int32 fromFloat (float f) { int32 v; std::memcpy (&v, &f, sizeof (v)); return v; }

using Impl = NativeFunction::ImplementationFunction;
static const std::map<std::string, Impl> impls = {
    //Raw bytes, logged in hex: these are what a program would use to build a message of its own
    { "sendMIDI/vi",              +[] (void*, const int32* a) -> int32 { std::printf ("    MIDI %02X\n", a[0] & 0xFF); return 0; } },
    { "sendMIDI/vii",             +[] (void*, const int32* a) -> int32 { std::printf ("    MIDI %02X %02X\n", a[0] & 0xFF, a[1] & 0xFF); return 0; } },
    { "sendMIDI/viii",            +[] (void*, const int32* a) -> int32 { std::printf ("    MIDI %02X %02X %02X\n", a[0] & 0xFF, a[1] & 0xFF, a[2] & 0xFF); return 0; } },
    { "sendNoteOn/viii",          +[] (void*, const int32* a) -> int32 { logm ("NoteOn     ", a, 3); return 0; } },
    { "sendNoteOff/viii",         +[] (void*, const int32* a) -> int32 { logm ("NoteOff    ", a, 3); return 0; } },
    { "sendAftertouch/viii",      +[] (void*, const int32* a) -> int32 { logm ("PolyAT     ", a, 3); return 0; } },
    { "sendCC/viii",              +[] (void*, const int32* a) -> int32 { logm ("CC         ", a, 3); return 0; } },
    { "sendPitchBend/vii",        +[] (void*, const int32* a) -> int32 { logm ("PitchBend  ", a, 2); return 0; } },
    { "sendChannelPressure/vii",  +[] (void*, const int32* a) -> int32 { logm ("ChanPress  ", a, 2); return 0; } },
    { "sendMessageToHost/viii",   +[] (void*, const int32* a) -> int32
        { std::printf ("    HostMsg %08X %08X %08X\n", (uint32) a[0], (uint32) a[1], (uint32) a[2]); return 0; } },
    { "getLocalConfig/ii",        +[] (void*, const int32* a) -> int32 { return cfgVals[a[0] & 127]; } },
    { "setLocalConfig/vii",       +[] (void*, const int32* a) -> int32 { setConfig (a[0], a[1]); return 0; } },
    { "setLocalConfigItemRange/viii", +[] (void*, const int32* a) -> int32 { cfgMin[a[0] & 127] = a[1]; cfgMax[a[0] & 127] = a[2]; return 0; } },
    { "isConnectedToHost/b",      +[] (void*, const int32*)   -> int32 { return hostConnected ? 1 : 0; } },
    { "fillPixel/viii",           +[] (void*, const int32* a) -> int32 { std::printf ("    LED %d,%d %08X\n", a[1], a[2], (uint32) a[0]); return 0; } },
    { "clearDisplay/v",           +[] (void*, const int32*)   -> int32 { return 0; } },
    { "abs/ii",                   +[] (void*, const int32* a) -> int32 { return a[0] < 0 ? -a[0] : a[0]; } },
    { "min/iii",                  +[] (void*, const int32* a) -> int32 { return std::min (a[0], a[1]); } },
    { "max/iii",                  +[] (void*, const int32* a) -> int32 { return std::max (a[0], a[1]); } },
    { "clamp/iiii",               +[] (void*, const int32* a) -> int32 { return std::max (a[0], std::min (a[1], a[2])); } },
    { "makeARGB/iiiii",           +[] (void*, const int32* a) -> int32
        { return (int32) ((((uint32) a[0] & 255u) << 24) | (((uint32) a[1] & 255u) << 16) | (((uint32) a[2] & 255u) << 8) | ((uint32) a[3] & 255u)); } },
    { "map/ffffff",               +[] (void*, const int32* a) -> int32
        {
            auto v = toFloat (a[0]), sMin = toFloat (a[1]), sMax = toFloat (a[2]), dMin = toFloat (a[3]), dMax = toFloat (a[4]);
            return fromFloat (dMin + (v - sMin) * (dMax - dMin) / (sMax - sMin));
        } },
};
static int32 stub (void*, const int32*) { return 0; }

static LFRunner runner;

static void runCtx (LFRunner::FunctionExecutionContext& ctx, const char* sig)
{
    auto e = ctx.run ([] { return false; });
    if (e != LFRunner::ErrorCode::ok)
        std::printf ("    RUNTIME ERROR in %s: %s\n", sig, LFRunner::getErrorDescription (e));
}

// No-argument callbacks: the context's initial push already serves as the return address.
static void call (const char* sig)
{
    LFRunner::FunctionExecutionContext ctx (runner, sig);
    if (! ctx.isValid()) { std::printf ("    (no %s)\n", sig); return; }
    runCtx (ctx, sig);
}

template <typename A0, typename... A>
static void call (const char* sig, A0 a0, A... args)
{
    LFRunner::FunctionExecutionContext ctx (runner, sig);
    if (! ctx.isValid()) { std::printf ("    (no %s)\n", sig); return; }
    ctx.setArguments ((int32) a0, ((int32) args)...);
    runCtx (ctx, sig);
}

static int32 parseValue (const std::string& text)
{
    if (text == "true")  return 1;
    if (text == "false") return 0;
    return (int32) (uint32) std::stoll (text, nullptr, 0);
}

int main (int argc, char** argv)
{
    if (argc < 3) { std::fprintf (stderr, "usage: lfsim script.littlefoot|program.bin scenario.txt\n"); return 2; }
    auto file = juce::File (juce::String (argv[1]));

    std::vector<uint8> code;
    std::map<std::string, int> ids;
    std::vector<int32> values;

    if (file.hasFileExtension ("bin"))
    {
        juce::MemoryBlock data;
        file.loadFileAsData (data);
        code.assign ((const uint8*) data.getData(), (const uint8*) data.getData() + data.getSize());
        std::printf ("(program %d B)\n", (int) code.size());
    }
    else
    {
        auto src = file.loadFileAsString();
        auto s = src.toStdString();

        // Metadata variables become globals; simSet() lets the scenario change them like the Dashboard does.
        std::string prelude, simSet = "void simSet (int id, int v)\n{\n";
        const std::regex re ("<variable[^>]*[ ]name=\"([A-Za-z0-9_]+)\"[^>]*type=\"([a-z]+)\"[^>]*value=\"([^\"]*)\"");

        for (std::sregex_iterator it (s.begin(), s.end(), re), end; it != end; ++it)
        {
            auto name = (*it)[1].str(), type = (*it)[2].str(), val = (*it)[3].str();
            prelude += (type == "bool" ? "bool " : "int ") + name + ";\n";

            int id = (int) ids.size();
            ids[name] = id;
            simSet += "    if (id == " + std::to_string (id) + ") " + name + (type == "bool" ? " = (v != 0);\n" : " = v;\n");
            values.push_back (parseValue (val));
        }
        simSet += "}\n";
        std::printf ("(%d metadata variables)\n", (int) ids.size());

        Compiler c;
        c.addNativeFunctions (lfNatives);
        auto r = c.compile (juce::String (prelude) + src + "\n" + juce::String (simSet), 512);
        if (r.failed()) { std::printf ("COMPILE FAILED: %s\n", r.getErrorMessage().toRawUTF8()); return 1; }
        code.assign (c.compiledObjectCode.begin(), c.compiledObjectCode.end());
    }

    static std::vector<NativeFunction> natives;
    for (auto p = lfNatives; *p != nullptr; ++p)
    {
        auto f = impls.find (*p);
        natives.push_back (NativeFunction (*p, f != impls.end() ? f->second : &stub));
    }
    runner.setNativeFunctions (natives.data(), (int) natives.size(), nullptr);

    auto loadProgram = [&]
    {
        runner.reset();
        for (size_t i = 0; i < code.size(); ++i)
            runner.setDataByte ((uint32) i, code[i]);
        for (int id = 0; id < (int) values.size(); ++id)
            call ("simSet/vii", id, values[(size_t) id]);
    };

    resetConfigRanges();
    cfgVals[3] = 48;
    loadProgram();

    std::ifstream in (argv[2]);
    std::string line;
    int frame = 0;
    while (std::getline (in, line))
    {
        if (line.empty()) continue;
        std::printf ("%s %s\n", line[0] == '#' ? "\n" : ">", line.c_str());
        std::istringstream ls (line);
        std::string cmd; ls >> cmd;
        int a = 0, b = 0, c3 = 0;
        if (cmd == "init")         call ("initialise/v");
        else if (cmd == "repaint") { ls >> a; if (a <= 0) a = 1; for (int i = 0; i < a; ++i) { std::printf ("  frame %d\n", ++frame); call ("repaint/v"); } }
        else if (cmd == "strike")  { ls >> a >> b; call ("keyStrike/viii", a, 0, b); }
        else if (cmd == "press")   { ls >> a >> b; call ("keyPress/viii", a, b, 0); }
        else if (cmd == "move")    { ls >> a >> b; call ("keyMove/viii", a, b, 0); }
        else if (cmd == "lift")    { ls >> a >> b; call ("keyLift/viii", a, 0, b); }
        else if (cmd == "btn")     { ls >> a; call ("handleButtonDown/vi", a); }
        else if (cmd == "midi")    { ls >> a >> b >> c3; call ("handleMIDI/viii", a, b, c3); }
        else if (cmd == "cfg")     { ls >> a >> b; cfgVals[a & 127] = b; }
        else if (cmd == "host")    { ls >> a; hostConnected = a != 0; }
        else if (cmd == "msg")
        {
            std::string p1, p2 = "0", p3 = "0"; ls >> p1 >> p2 >> p3;
            call ("handleMessage/viii", parseValue (p1), parseValue (p2), parseValue (p3));
        }
        else if (cmd == "heap")
        {
            // heap offset value: a 4-byte write to shared memory, as the host's data changes make
            std::string off, v; ls >> off >> v;
            runner.setHeapInt ((uint32) parseValue (off), (uint32) parseValue (v));
        }
        else if (cmd == "set")
        {
            std::string n, v; ls >> n >> v;
            if (ids.count (n)) { values[(size_t) ids[n]] = parseValue (v); call ("simSet/vii", ids[n], values[(size_t) ids[n]]); }
            else std::printf ("    (script has no %s)\n", n.c_str());
        }
        else if (cmd == "reboot")
        {
            // Power cycle: memory and globals reset, stored config values kept, ranges back to their defaults.
            // "reboot clamp" also clamps the stored values to those default ranges.
            std::string mode; ls >> mode;
            resetConfigRanges();
            if (mode == "clamp")
                for (int i = 0; i < 128; ++i)
                    cfgVals[i] = std::clamp (cfgVals[i], cfgMin[i], cfgMax[i]);
            loadProgram();
            std::printf ("  (rebooted%s)\n", mode == "clamp" ? ", stored values clamped" : "");
            call ("initialise/v");
        }
    }
    return 0;
}
