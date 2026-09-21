// Converts a ROLI Dashboard preset of customcolors (.mode) to the editor's JSON file, using the editor's own file
// code, then reads the result back with the editor's import code and checks every value against the preset.
// usage: node convert_mode.js input.mode output.json
'use strict';

const fs = require ('fs');
const Core = require ('../editor_core.js');

// Dashboard stores the keyboard settings a script activates under their display names
const KEYBOARD_SETTINGS = {
    'Pitch Bend Range': 'pitchBendRange',
    'Strike Sensitivity': 'strikeSensitivity',
    'Pressure Sensitivity': 'pressureSensitivity',
    'Lift Sensitivity': 'liftSensitivity',
    'Brightness': 'brightness'
};

// The script's names for the pitch bend and pressure colors, in the editor's order
const BEND_NAMES = ['bendDownCol', 'bendUpCol'];
const PRESSURE_NAMES = ['pressFullCol'];

const decode = s => s.replace (/&quot;/g, '"').replace (/&apos;/g, "'").replace (/&lt;/g, '<').replace (/&gt;/g, '>').replace (/&amp;/g, '&');
const settingIndex = name => Core.SETTINGS_BASE + Core.SETTINGS.findIndex (s => s.name === name);

const [input, output] = process.argv.slice (2);

if (! input || ! output)
{
    console.log ('usage: node convert_mode.js input.mode output.json');
    process.exit (2);
}

const text = fs.readFileSync (input, 'utf8');
const modeMatch = /<mode\s+name="([^"]*)"/.exec (text);
const modeName = modeMatch ? decode (modeMatch[1]) : '';

const variables = [];

for (const m of text.matchAll (/<variable\b([^>]*?)\/?>/g))
{
    const n = /\sname="([^"]*)"/.exec (m[1]);
    const v = /\svalue="([^"]*)"/.exec (m[1]);
    variables.push ({ name: n ? decode (n[1]) : null, value: v ? decode (v[1]) : null });
}

const state = Core.defaultState();
const taken = new Map();        // value number -> value from the preset, as stored in the program
const problems = [];
const unknown = [];

function take (n, value, label)
{
    if (taken.has (n))
        problems.push (`${label} appears more than once`);

    taken.set (n, value | 0);
}

function readColor (list, base, i, text, label)
{
    const c = Core.parseColor (text);

    if (c === null)
        return problems.push (`${label}: "${text}" is not a color`);

    list[i] = c;
    take (base + i, c, label);
}

function readSetting (name, text, label)
{
    const s = Core.SETTINGS.find (x => x.name === name);

    if (s.bool)
    {
        if (text !== 'true' && text !== 'false')
            return problems.push (`${label}: "${text}" is not true or false`);

        state.settings[name] = text === 'true';
        return take (settingIndex (name), text === 'true' ? 1 : 0, label);
    }

    const v = Number (text);

    if (! Number.isInteger (v))
        return problems.push (`${label}: "${text}" is not a whole number`);

    if (v < s.min || v > s.max)
        return problems.push (`${label}: ${v} is outside ${s.min}-${s.max}`);

    state.settings[name] = v;
    take (settingIndex (name), v, label);
}

for (const { name, value } of variables)
{
    let m;

    if (name === null || value === null)
        problems.push ('a variable without a name or value');
    else if ((m = /^keyOnCol(\d+)$/.exec (name)) && Number (m[1]) < Core.KEY_COUNT)
        readColor (state.on, 0, Number (m[1]), value, name);
    else if ((m = /^keyOffCol(\d+)$/.exec (name)) && Number (m[1]) < Core.KEY_COUNT)
        readColor (state.off, Core.OFF_BASE, Number (m[1]), value, name);
    else if ((m = /^octCol(\d+)$/.exec (name)) && Number (m[1]) < Core.OCTAVE_COUNT)
        readColor (state.octave, Core.OCTAVE_BASE, Number (m[1]), value, name);
    else if (BEND_NAMES.includes (name))
        readColor (state.bend, Core.BEND_BASE, BEND_NAMES.indexOf (name), value, name);
    else if (PRESSURE_NAMES.includes (name))
        readColor (state.pressure, Core.PRESSURE_BASE, PRESSURE_NAMES.indexOf (name), value, name);
    else if (KEYBOARD_SETTINGS[name])
        readSetting (KEYBOARD_SETTINGS[name], value, name);
    else if (Core.SETTINGS.some (s => s.name === name && s.config === undefined))
        readSetting (name, value, name);
    else
        unknown.push (name);
}

const missing = [];

for (let n = 0; n < Core.VALUE_COUNT; ++n)
{
    if (taken.has (n))
        continue;

    if (n < Core.OFF_BASE)           missing.push (`keyOnCol${n} = ${Core.formatColor (state.on[n])}`);
    else if (n < Core.OCTAVE_BASE)   missing.push (`keyOffCol${n - Core.OFF_BASE} = ${Core.formatColor (state.off[n - Core.OFF_BASE])}`);
    else if (n < Core.SETTINGS_BASE) missing.push (`octCol${n - Core.OCTAVE_BASE} = ${Core.formatColor (state.octave[n - Core.OCTAVE_BASE])}`);
    else if (n < Core.BEND_BASE)
    {
        const s = Core.SETTINGS[n - Core.SETTINGS_BASE];
        missing.push (`${s.name} = ${state.settings[s.name]}`);
    }
    else if (n < Core.PRESSURE_BASE) missing.push (`${BEND_NAMES[n - Core.BEND_BASE]} = ${Core.formatColor (state.bend[n - Core.BEND_BASE])}`);
    else                             missing.push (`${PRESSURE_NAMES[n - Core.PRESSURE_BASE]} = ${Core.formatColor (state.pressure[n - Core.PRESSURE_BASE])}`);
}

const json = JSON.stringify (Core.stateToFile (state, modeName), null, 2) + '\n';
fs.writeFileSync (output, json);

// Read the written file back the way the page's Import file does
const back = Core.stateFromFile (JSON.parse (fs.readFileSync (output, 'utf8')));
const values = back.state ? Core.stateToValues (back.state) : null;
const differ = values ? [...taken].filter (([n, v]) => values[n] !== v).map (([n]) => n) : ['file unreadable'];

console.log (`preset "${modeName}": ${variables.length} variables, ${taken.size} of the editor's ${Core.VALUE_COUNT} values taken from it`);
console.log (`unknown variables: ${unknown.length ? unknown.join (', ') : 'none'}`);
console.log (`problems: ${problems.length ? problems.join ('; ') : 'none'}`);
console.log (`not in the preset, editor defaults used: ${missing.length ? missing.join (', ') : 'none'}`);
console.log (`read back with the editor's import: ${back.problems.length} problems${back.problems.length ? ' (' + back.problems.join (' ') + ')' : ''}, ` +
             `name "${back.name}", ${differ.length} values differ from the preset`);

process.exit (problems.length || unknown.length || back.problems.length || differ.length ? 1 : 0);
