// Profiles a littlefoot script in the BLOCKS SDK bytecode runner: instructions (to within 64,
// the runner's timeout-check stride) and native calls per callback, for a scenario file.
// usage: lfprof script.littlefoot|program.bin scenario.txt
#include <juce_core/juce_core.h>
#include <algorithm>
#include <cstdio>
#include <regex>
#include <map>
#include <vector>
#include <array>
#include <fstream>
#include <sstream>
#include <utility>
namespace roli { using namespace juce; }
namespace littlefoot { using juce::readLittleEndianBitsInBuffer; }
#include "roli_LittleFootRunner.h"
#include "roli_LittleFootCompiler.h"
#include "natives.inc"

using namespace littlefoot;
using LFRunner = Runner<16384, 4096>;
using Impl = NativeFunction::ImplementationFunction;

static int cfgVals[128];
static bool hostConnected = false;

static const std::map<std::string, Impl> impls = {
    { "getLocalConfig/ii",   +[] (void*, const int32* a) -> int32 { return cfgVals[a[0] & 127]; } },
    { "isConnectedToHost/b", +[] (void*, const int32*)   -> int32 { return hostConnected ? 1 : 0; } },
    { "min/iii",             +[] (void*, const int32* a) -> int32 { return std::min (a[0], a[1]); } },
    { "max/iii",             +[] (void*, const int32* a) -> int32 { return std::max (a[0], a[1]); } },
    { "clamp/iiii",          +[] (void*, const int32* a) -> int32 { return std::max (a[0], std::min (a[1], a[2])); } },
};
static int32 stub (void*, const int32*) { return 0; }

static constexpr size_t maxNatives = 256;
static std::array<Impl, maxNatives> realImpl {};
static std::array<long, maxNatives> nativeCalls {};

template <size_t I>
static int32 tramp (void* ctx, const int32* a) { ++nativeCalls[I]; return realImpl[I] (ctx, a); }

template <size_t... I>
static std::array<Impl, sizeof... (I)> makeTramps (std::index_sequence<I...>) { return {{ &tramp<I>... }}; }

static LFRunner runner;
static std::vector<const char*> nativeNames;

struct Stats { long calls = 0, opBlocks = 0, maxBlocks = 0; std::array<long, maxNatives> natives {}; };
static std::map<std::string, Stats> stats;

static void runCtx (LFRunner::FunctionExecutionContext& ctx, const char* sig)
{
    long blocks = 0;
    auto before = nativeCalls;
    auto e = ctx.run ([&] { ++blocks; return false; });

    if (e != LFRunner::ErrorCode::ok)
        std::printf ("    RUNTIME ERROR in %s: %s\n", sig, LFRunner::getErrorDescription (e));

    auto& st = stats[sig];
    ++st.calls;
    st.opBlocks += blocks;
    st.maxBlocks = std::max (st.maxBlocks, blocks);
    for (size_t i = 0; i < maxNatives; ++i)
        st.natives[i] += nativeCalls[i] - before[i];
}

static void call (const char* sig)
{
    LFRunner::FunctionExecutionContext ctx (runner, sig);
    if (! ctx.isValid()) return;
    runCtx (ctx, sig);
}

template <typename A0, typename... A>
static void call (const char* sig, A0 a0, A... args)
{
    LFRunner::FunctionExecutionContext ctx (runner, sig);
    if (! ctx.isValid()) return;
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
    if (argc < 3) { std::fprintf (stderr, "usage: lfprof script.littlefoot|program.bin scenario.txt\n"); return 2; }
    auto file = juce::File (juce::String (argv[1]));

    std::vector<uint8> code;
    std::map<std::string, int> ids;
    std::vector<std::pair<int, int>> defaults;

    if (file.hasFileExtension ("bin"))
    {
        juce::MemoryBlock data;
        file.loadFileAsData (data);
        code.assign ((const uint8*) data.getData(), (const uint8*) data.getData() + data.getSize());
    }
    else
    {
        auto src = file.loadFileAsString();
        auto s = src.toStdString();

        std::string prelude, simSet = "void simSet (int id, int v)\n{\n";
        const std::regex re ("<variable[^>]*[ ]name=\"([A-Za-z0-9_]+)\"[^>]*type=\"([a-z]+)\"[^>]*value=\"([^\"]*)\"");

        for (std::sregex_iterator it (s.begin(), s.end(), re), end; it != end; ++it)
        {
            auto name = (*it)[1].str(), type = (*it)[2].str(), val = (*it)[3].str();
            prelude += (type == "bool" ? "bool " : "int ") + name + ";\n";

            if (type == "colour")
                continue;

            int id = (int) ids.size();
            ids[name] = id;
            simSet += "    if (id == " + std::to_string (id) + ") " + name + (type == "bool" ? " = (v != 0);\n" : " = v;\n");
            defaults.push_back ({ id, parseValue (val) });
        }
        simSet += "}\n";

        Compiler c;
        c.addNativeFunctions (lfNatives);
        auto r = c.compile (juce::String (prelude) + src + "\n" + juce::String (simSet), 512);
        if (r.failed()) { std::printf ("COMPILE FAILED: %s\n", r.getErrorMessage().toRawUTF8()); return 1; }
        code.assign (c.compiledObjectCode.begin(), c.compiledObjectCode.end());
    }

    static auto tramps = makeTramps (std::make_index_sequence<maxNatives>{});
    static std::vector<NativeFunction> natives;
    for (auto p = lfNatives; *p != nullptr && natives.size() < maxNatives; ++p)
    {
        auto f = impls.find (*p);
        realImpl[natives.size()] = f != impls.end() ? f->second : &stub;
        natives.push_back (NativeFunction (*p, tramps[natives.size()]));
        nativeNames.push_back (*p);
    }
    runner.setNativeFunctions (natives.data(), (int) natives.size(), nullptr);
    for (size_t i = 0; i < code.size(); ++i)
        runner.setDataByte ((uint32) i, code[i]);

    cfgVals[3] = 48;
    for (auto& d : defaults) call ("simSet/vii", d.first, d.second);
    stats.clear();

    std::ifstream in (argv[2]);
    std::string line;
    while (std::getline (in, line))
    {
        if (line.empty() || line[0] == '#') continue;
        std::istringstream ls (line);
        std::string cmd; ls >> cmd;
        int a = 0, b = 0, c3 = 0;
        if (cmd == "init")         call ("initialise/v");
        else if (cmd == "repaint") { ls >> a; if (a <= 0) a = 1; for (int i = 0; i < a; ++i) call ("repaint/v"); }
        else if (cmd == "strike")  { ls >> a >> b; call ("keyStrike/viii", a, 0, b); }
        else if (cmd == "press")   { ls >> a >> b; call ("keyPress/viii", a, b, 0); }
        else if (cmd == "move")    { ls >> a >> b; call ("keyMove/viii", a, b, 0); }
        else if (cmd == "lift")    { ls >> a >> b; call ("keyLift/viii", a, 0, b); }
        else if (cmd == "btn")     { ls >> a; call ("handleButtonDown/vi", a); }
        else if (cmd == "midi")    { ls >> a >> b >> c3; call ("handleMIDI/viii", a, b, c3); }
        else if (cmd == "cfg")     { ls >> a >> b; cfgVals[a & 127] = b; }
        else if (cmd == "host")    { ls >> a; hostConnected = a != 0; }
        else if (cmd == "set")     { std::string n; ls >> n >> a; if (ids.count (n)) call ("simSet/vii", ids[n], a); }
        else if (cmd == "msg")     { std::string p1, p2 = "0", p3 = "0"; ls >> p1 >> p2 >> p3; call ("handleMessage/viii", parseValue (p1), parseValue (p2), parseValue (p3)); }
        else if (cmd == "heap")    { std::string off, v; ls >> off >> v; runner.setHeapInt ((uint32) parseValue (off), (uint32) parseValue (v)); }
        else if (cmd == "reset")   stats.clear();
    }

    for (auto& [sig, st] : stats)
    {
        if (sig == "simSet/vii") continue;
        std::printf ("%-20s calls %5ld   ops/call ~%6ld   max ~%6ld   natives/call:", sig.c_str(), st.calls, st.opBlocks * 64 / st.calls, st.maxBlocks * 64);
        for (size_t i = 0; i < nativeNames.size(); ++i)
            if (st.natives[i] > 0)
                std::printf ("  %s %.1f", juce::String (nativeNames[i]).upToFirstOccurrenceOf ("/", false, false).toRawUTF8(), (double) st.natives[i] / (double) st.calls);
        std::printf ("\n");
    }
    return 0;
}
