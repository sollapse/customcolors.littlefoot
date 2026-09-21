# customcolors editor

`editor.html` edits customcolors on a ROLI Piano M (LUMI Keys) over Web MIDI, in place of Dashboard: the per-key on and off colors, the octave button colors, all of the script's settings, and the keyboard settings Dashboard shows with them (pitch bend range, strike, pressure and lift sensitivity, and brightness). Changes show on the keyboard as you make them, and **Save to keyboard** writes them into the program and makes it the keyboard's default, so they stay after a restart.

## Run it

1. Stop anything else from talking to the keyboard. On Windows, close ROLI Connect and stop the ROLI Hardware Driver service, which otherwise holds the keyboard: `Stop-Service "ROLI Hardware Driver"` in an administrator PowerShell, and `Start-Service "ROLI Hardware Driver"` afterwards. On macOS and Linux, MIDI ports are shared between applications, so quitting ROLI Connect, ROLI Dashboard or a DAW that uses the keyboard is enough. The page shows the step for the system it runs on.
2. Connect the Piano M by USB and open `editor.html` in Chrome or Edge, as a local file or from a localhost server. Press **Connect** and allow MIDI access with system exclusive messages. Safari has no Web MIDI, and Firefox needs a site permission add-on for it.

## Using it

- **Keys**: the keyboard shows all 24 keys in the colors they will light. The switch above it chooses whether you're editing the on or the off colors, and the slider beside it sets that state's brightness. Click a key to select it: the field names it, and the picker beside the field takes a color or the full 32-bit ARGB value in hex, where 8 digits set every bit, 6 digits give an opaque color, and the picker keeps the alpha byte. The key under the pointer and the selected key are outlined in white with a black line inside it, drawn within the key, so neither mark changes the color you're judging.
- **Pitch bend and pressure**: keys can change color with pitch bend, pressure or both, starting from their on colors and moving toward three colors the panel sets: bend down, bend up and full pressure. Keys you hold follow your playing; keys lit by incoming notes follow the pitch bend, channel pressure and poly aftertouch on their note's channel, in either MIDI mode. Set to nothing, keys keep their plain on and off colors.
- **Sensitivity**: strike, pressure and lift have Dashboard's response graphs, showing how hard you play for full output. The curve reaches the top at the level you set, and 127 is a straight line; the shape is read from Dashboard's own drawing code.
- **Live preview**: while the keyboard runs customcolors, every change shows on it. A preview isn't kept: the keyboard goes back to its saved colors and settings when it restarts, when you disconnect, or with **Discard preview**.
- **Save to keyboard** uploads the program with the current colors and settings written in, saves it as the keyboard's default, and reads the values back to check them. **Try on keyboard** uploads without saving.
- **Load from keyboard** reads the keyboard's colors and settings into the page. When you connect and they differ from the page's, the page asks which to keep; replacing the page's edits keeps them as a saved set.
- **Saved on this computer**: the page keeps your current edits in the browser's local storage, along with named sets. **Export file** and **Import file** save and load the same data as JSON. Files and sets from before the pitch bend and pressure colors load them at their defaults; ones with the earlier five colors keep their down, up and full pressure colors.

If the keyboard runs another program, such as the Dashboard version of the script, the page says so, and **Save to keyboard** replaces it. To go back to the Dashboard version, send the script from ROLI Connect again with the service running.

## How it works

- `editor_program.littlefoot` is customcolors with every setting and color as a placeholder int literal (`0x5A5A0000 + n`) in place of a Dashboard variable. The compiler stores those literals as 4-byte operands, so the page writes the values into the compiled program and updates its checksum before uploading. The keyboard keeps a program saved as its default, but not the program's shared memory, so saved values have to live in the program.
- A preview writes the 80 values to the program's shared memory (value n at offset n × 4), then sends a message: the program loads them and replies with their sum, which the page checks.
- The keyboard settings are the keyboard's own configuration (config items 3, 10, 13, 14 and 36), which Dashboard keeps in its presets under their display names. The program writes each one whenever its values load (at start, on a preview, and when a preview is discarded), and only when the keyboard's value differs. A saved program puts them back each time it starts, so a change made elsewhere, such as in Dashboard, lasts until then.
- The program sends messages only in reply: to the page's info (its build id and state), report (all values, spread over a few frames), apply and revert, and to a host's `GOCT`. Every message also reaches the MIDI port as SysEx, which a DAW can see, so nothing is sent while you play.
- It also takes the script's host messages, `HCOL`, `KCOL`, `OCOL`, `BCOL`, `PCOL` and `GOCT` (see the main README), which are for other software rather than the page. A host's colors replace the loaded ones until host color mode ends. While it's on, the info flags report them as they do a preview, so the page puts the program's values back before taking it over, and a preview or discarding one also ends host color mode.
- When the keyboard already runs the same build, the page takes over its memory state from the report instead of uploading, so connecting doesn't restart the program. After a lost connection it checks the program again rather than resending memory.
- Playing costs the same as the optimised script: a repaint is about 1130 instructions (1860 at most) and an MPE key strike about 260. Applying a preview takes about 4750 instructions in one callback, a little more than the script spent on every frame before it was optimised.
- With pitch bend or pressure colors on, a held key's bend or pressure event costs about 490 instructions more, an incoming bend or pressure message about 1150 plus about 520 for each further key it moves, and applying a preview about 360 more for each lit key. With them off, an incoming bend or pressure message takes about 30.

## Files

- `editor.html`, `editor_ui.js`: the page.
- `editor_core.js`: the values, file format, program patching and keyboard session. It also loads in Node, which `tools/convert_mode.js` uses.
- `blocks.js`: the BLOCKS host protocol, ported from ROLI's BLOCKS SDK under its ISC licence (the notice is in the file), with two additions for the editor: taking over a known running program without uploading, and not resending memory after a lost connection.
- `editor_program.littlefoot`: the program. `editor_program.js`: the program compiled, with its placeholder offsets and build id. Generated, don't edit.
- `presets/1.json`: the Dashboard preset named "1", converted with `tools/convert_mode.js`. Load it with **Import file**.
- `tools/`: the generator, the simulator, the profiler and a converter for Dashboard presets.

## Regenerating

The page and `tools/convert_mode.js` need nothing but a browser and Node, on any system.

The C++ tools build with `tools/Makefile`, against two checkouts that aren't vendored here: ROLI's BLOCKS SDK (https://github.com/WeAreROLI/BLOCKS-SDK), which supplies JUCE's `juce_core`, and `roli_blocks_basics` (https://github.com/WeAreROLI/roli_blocks_basics), which has the littlefoot compiler and runner. Point the makefile at them, where `SDK` is the folder holding `juce_core` rather than the top of that repository:

```
cd tools
make SDK=~/BLOCKS-SDK/SDK BLOCKS=~/roli_blocks_basics
```

That writes `lfgen`, `lfsim` and `lfprof` into `tools/build`, along with `natives.inc`, the SDK's own table of littlefoot functions, which the compiler front end needs. `make regen` rebuilds `editor_program.js` from the program source with `lfgen`, and `make clean` removes the build directory. On Windows, build inside WSL: the tools are plain C++, but `juce_core` expects a POSIX system. Two defines in the makefile are not optional — `juce_core` refuses to compile without `JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED`, and without `JUCE_USE_CURL=0` the link fails on curl symbols none of the tools ever reach.

- `tools/lfgen.cpp`: `lfgen editor_program.littlefoot editor_program.js editor_program.bin EDITOR_PROGRAM` compiles the program, finds the placeholders (it fails if one is missing, repeated or out of sequence), writes the build id and writes the JS file. Run it after changing the program.
- `tools/lfsim.cpp`: runs a script or a compiled `.bin` against a scenario of key, button, MIDI, setting, shared-memory and message events, and logs MIDI, LEDs and messages.
- `tools/lfprof.cpp`: instructions and native calls per callback for a scenario.
- `tools/convert_mode.js`: `node convert_mode.js preset.mode preset.json` turns a Dashboard preset of the script into a file the page imports, using the editor's own file code, and checks every value it wrote against the preset.
