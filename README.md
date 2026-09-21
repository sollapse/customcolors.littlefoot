# Custom Colors for ROLI LUMI Keys/Piano M
**A Littlefoot script that customizes active/inactive per-key colors and octave buttons. Supports one LUMI Key/Piano M (24 keys) along with Single and MPE mode (script refactored with Claude Opus 5)**

![Custom Colors interface in ROLI Dashboard](https://github.com/sollapse/customcolors.littlefoot/blob/main/customcolors1.gif)

**In action**
![Clip of LUMI Key being triggered](https://github.com/sollapse/customcolors.littlefoot/blob/main/customcolors2.gif)

## Pitch bend and pressure colors

Keys you hold can follow their pitch bend and pressure in color, chosen with Held Keys Follow (0 nothing, 1 pitch bend, 2 pressure, 3 both). A held key starts from its own on color: pressure mixes it toward the full pressure color, and a bend moves it toward the down or up color, all the way at the key's full travel. With both, pressure sets the color and a bend moves it. Keys lit by incoming notes keep their own on colors.

## Messages from a host

A plug-in or other host can recolor the keys and octave buttons live during a session, and read the octave. It sends the keyboard BLOCKS program messages: SysEx in ROLI's own format, carrying three 32-bit ints to the script. The first int names the message, in ASCII:

| Message | First int | Second int | Third int |
|---|---|---|---|
| `HCOL` host color mode | `0x48434F4C` | 1 on, 0 off | unused |
| `KCOL` key color | `0x4B434F4C` | key 0-23 (Key 1-24) for its off color, 256 + key for its on color | color, `0xRRGGBBAA` |
| `OCOL` octave button color | `0x4F434F4C` | octave, -2 to 8 | color, `0xRRGGBBAA` |
| `BCOL` pitch bend color | `0x42434F4C` | 0 down, 1 up | color, `0xRRGGBBAA` |
| `PCOL` pressure color | `0x50434F4C` | 0 full pressure | color, `0xRRGGBBAA` |
| `GOCT` get octave | `0x474F4354` | unused | unused |

- Host color mode is for other software, such as a plug-in, and is off whenever the script starts. `KCOL`, `OCOL`, `BCOL` and `PCOL` work only while it's on: each color the host sends shows in place of the saved one, and the rest keep their saved colors. Nothing is saved: turning the mode off puts the saved colors back everywhere, and turning it on again starts from them. Turning it on while it's on keeps the host's colors.
- The script answers `GOCT` with `GOCT`, the octave the keys are on (-2 to 8) and the note Key 1 plays (24 + 12 × octave). It sends nothing else, because everything it sends also reaches the MIDI port as SysEx, which a DAW may record.
- Host colors show with the brightness settings, and the LEDs ignore alpha, as with Dashboard's colors. Colors changed in Dashboard during host color mode show once it's off. Messages with a key, octave, color or id out of range are ignored.
- The web editor's program (`editor/`) takes the same messages. The web editor takes the keyboard over: connecting it, previewing or discarding a preview ends host color mode and puts the saved colors back.

A message is a 23-byte SysEx: `F0 00 21 10 77`, the keyboard's index from its topology message (a Piano M on its own reported 19, `13`), 15 bytes holding the message type 3 (7 bits) and the three ints (32 bits each) as one bit stream, least significant bit first and 7 bits to a byte, a checksum, and `F7`. These turn host color mode on, then set Key 4's off color to red:

    F0 00 21 10 77 13 03 4C 1E 0D 42 14 00 00 00 00 00 00 00 00 00 1F F7
    F0 00 21 10 77 13 03 4C 1E 0D 5A 34 00 00 00 00 7E 03 00 70 1F 75 F7

`programEventPacket` in `editor/blocks.js` builds them, and `decodePacket` reads the answer to `GOCT`. The keyboard takes them from a host that holds it in BLOCKS API mode, as Dashboard and the web editor do; whether it also does without that hasn't been tried.

