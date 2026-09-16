// Runs editor_program in lfsim with values patched in the way the editor does, and checks the program's messages,
// that a preview through shared memory draws and plays the same as values written into the program, and that MIDI
// and LED output match customcolors.littlefoot with the same settings.
// usage: node test_program.js
//   LFSIM: the simulator command (default: ~/lfcheck/build/lfsim run through WSL on Windows, lfsim on the path
//   elsewhere); ORIGINAL: the script to compare with
'use strict';

const fs = require ('fs');
const os = require ('os');
const path = require ('path');
const { execFileSync } = require ('child_process');
const Core = require ('../editor_core.js');
const PROGRAM = require ('../editor_program.js');

// The simulator runs directly, except on Windows, where it runs in WSL
const WINDOWS = process.platform === 'win32';
const LFSIM = process.env.LFSIM || (WINDOWS ? '~/lfcheck/build/lfsim' : 'lfsim');
const ORIGINAL = process.env.ORIGINAL || path.resolve (__dirname, '../../customcolors.littlefoot');
const work = fs.mkdtempSync (path.join (os.tmpdir(), 'editor-program-test-'));
const MSG = Core.MSG;

let passed = 0, failed = 0, files = 0;

function check (name, ok, detail)
{
    if (ok) ++passed;
    else    { ++failed; console.log (`FAIL ${name}${detail ? '\n  ' + detail : ''}`); }
}

//==============================================================================
// A Windows path as WSL sees it
function wslPath (file)
{
    const full = path.resolve (file);
    const m = /^([A-Za-z]):[\\/](.*)$/.exec (full);
    return m ? `/mnt/${m[1].toLowerCase()}/${m[2].split (path.sep).join ('/')}` : full;
}

function runSimulator (programFile, scenario)
{
    const options = { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 };

    if (WINDOWS)
        return execFileSync ('wsl', ['bash', '-c', `${LFSIM} '${wslPath (programFile)}' '${wslPath (scenario)}'`], options);

    return execFileSync ('/bin/sh', ['-c', `${LFSIM} '${path.resolve (programFile)}' '${path.resolve (scenario)}'`], options);
}

// Output lines the program produced, with the scenario section (last "# name" line), command and frame they follow
function simulate (programFile, lines)
{
    const scenario = path.join (work, `scenario${++files}.txt`);
    fs.writeFileSync (scenario, lines.join ('\n') + '\n');

    const text = runSimulator (programFile, scenario);
    const events = [];
    let section = '', cmd = '', frame = 0;

    for (const line of text.split (/\r?\n/))
    {
        if (line.startsWith (' # '))            section = line.slice (3);
        else if (line.startsWith ('> '))        cmd = line.slice (2);
        else if (line.startsWith ('  frame '))  frame = parseInt (line.slice (8), 10);
        else if (line.startsWith ('    '))      events.push ({ text: line.trim(), section, cmd, frame });
        else if (line.startsWith ('COMPILE FAILED')) throw new Error (line);
    }

    const errors = events.filter (e => e.text.startsWith ('RUNTIME ERROR'));
    check (`no runtime errors in scenario ${files}`, errors.length === 0, errors.map (e => `${e.text} after ${e.cmd}`).join ('; '));
    return events;
}

function writeProgram (values)
{
    const file = path.join (work, `program${++files}.bin`);
    fs.writeFileSync (file, Core.patchProgram (PROGRAM, values));
    return file;
}

const hostMessages = (events, section) => events
    .filter (e => e.text.startsWith ('HostMsg') && (section === undefined || e.section === section))
    .map (e => Object.assign ({ values: e.text.split (/\s+/).slice (1).map (h => parseInt (h, 16) | 0) }, e));

const heapWrites = values => Array.from (values, (v, n) => `heap ${n * 4} ${v}`);
const hex = v => (v >>> 0).toString (16).toUpperCase().padStart (8, '0');

function makeValues (seed, settings)
{
    const state = Core.defaultState();
    let x = seed >>> 0;
    const next = () => (x = (Math.imul (x, 1664525) + 1013904223) >>> 0);

    for (let i = 0; i < Core.KEY_COUNT; ++i)
    {
        state.on[i] = next();
        state.off[i] = next();
    }

    for (let i = 0; i < Core.OCTAVE_COUNT; ++i)
        state.octave[i] = next();

    Object.assign (state.settings, settings);
    return Core.stateToValues (state);
}

function checkReport (name, messages, expected)
{
    const r = new Core.ReportCollector();

    for (const m of messages)
        check (`${name}: message ${hex (m.values[0])} belongs to the report`, r.handle (m.values));

    check (`${name}: complete, count and sum match`, r.isComplete(), `done ${r.done}, count ${r.count}, missing ${r.missingCount()}`);
    check (`${name}: values`, Core.sameValues (r.values, expected),
           Array.from (r.values).map ((v, n) => v === expected[n] ? null : `value ${n} ${hex (v)} expected ${hex (expected[n])}`).filter (Boolean).slice (0, 4).join (', '));

    const perFrame = {};

    for (const m of messages)
        perFrame[m.frame] = (perFrame[m.frame] || 0) + 1;

    check (`${name}: at most 4 messages a frame`, Math.max (...Object.values (perFrame)) <= 4, JSON.stringify (perFrame));
}

function expectMessage (name, messages, expected)
{
    const got = messages.map (m => m.values.map (hex).join (' '));
    check (name, got.length === 1 && got[0] === expected.map (hex).join (' '), `got [${got.join (' | ')}], expected ${expected.map (hex).join (' ')}`);
}

//==============================================================================
// Messages: info, report, silence while playing, preview, revert
{
    const A = makeValues (1, { onBright: 70, offBright: 40, midiChan: 3 });
    const B = makeValues (2, { onBright: 55, offBright: 20, midiChan: 3, fadeColors: true, fadeInc: 25, toggleVB: true });
    const info = flags => [MSG.info, PROGRAM.buildId, flags];

    const events = simulate (writeProgram (A), [
        '# start', 'init', 'host 1', 'repaint 1',
        '# info1', `msg ${MSG.info}`,
        '# report1', `msg ${MSG.report}`, 'repaint 12',
        '# play', 'btn 0', 'repaint 2', 'strike 3 100', 'press 3 50', 'move 3 9000', 'repaint 2', 'lift 3 20',
                  'midi 144 72 100', 'midi 128 72 0', 'btn 2', 'btn 0', 'repaint 3',
        '# preview', ...heapWrites (B), `msg ${MSG.apply} 1`,
        '# info2', `msg ${MSG.info}`,
        '# report2', `msg ${MSG.report}`, 'repaint 12',
        '# revert', `msg ${MSG.revert}`,
        '# info3', `msg ${MSG.info}`,
        '# report3', `msg ${MSG.report}`, 'repaint 12',
        '# idle', 'repaint 30'
    ]);

    expectMessage ('info at start: format 1, values from the program, lights off', hostMessages (events, 'info1'), info (0x100));
    checkReport ('report of the values written into the program', hostMessages (events, 'report1'), A);
    check ('no messages while playing', hostMessages (events, 'play').length === 0);
    expectMessage ('apply replies with the sum of the previewed values', hostMessages (events, 'preview'), [MSG.apply, Core.valueSum (B), 0]);
    expectMessage ('info after preview: values from shared memory, lights turned on', hostMessages (events, 'info2'), info (0x103));
    checkReport ('report of the previewed values', hostMessages (events, 'report2'), B);
    expectMessage ('revert replies with the sum of the values written into the program', hostMessages (events, 'revert'), [MSG.revert, Core.valueSum (A), 0]);
    expectMessage ('info after revert', hostMessages (events, 'info3'), info (0x102));
    checkReport ('report after revert', hostMessages (events, 'report3'), A);
    check ('no messages when idle', hostMessages (events, 'idle').length === 0);
}

const settingIndex = name => Core.SETTINGS_BASE + Core.SETTINGS.findIndex (s => s.name === name);
const configWrites = (events, section) => events.filter (e => e.section === section && e.text.startsWith ('Config')).map (e => e.text);

// Out-of-range values in shared memory are clamped before use
{
    const A = makeValues (3, {});
    const bad = Int32Array.from (A);
    bad[settingIndex ('midiChan')] = 0;
    bad[settingIndex ('mpeMode')] = 1;
    bad[settingIndex ('mpeMembers')] = 99;
    bad[settingIndex ('onBright')] = 250;
    bad[settingIndex ('fixedVel')] = 0;
    bad[settingIndex ('fadeInc')] = -5;
    bad[settingIndex ('pitchBendRange')] = 200;
    bad[settingIndex ('brightness')] = -20;

    const clamped = Core.stateToValues (Core.valuesToState (bad));

    const events = simulate (writeProgram (A), [
        'init', 'host 1', 'repaint 1',
        '# apply', ...heapWrites (bad), `msg ${MSG.apply} 1`,
        '# report', `msg ${MSG.report}`, 'repaint 12',
        '# play', 'repaint 20', 'strike 0 100', 'strike 1 100', 'repaint 2', 'lift 0 0', 'lift 1 0', 'repaint 20'
    ]);

    expectMessage ('apply with out-of-range values replies with the clamped sum', hostMessages (events, 'apply'), [MSG.apply, Core.valueSum (clamped), 0]);
    checkReport ('report shows the clamped values', hostMessages (events, 'report'), clamped);
    check ('clamped MPE settings play notes', events.filter (e => e.section === 'play' && e.text.startsWith ('NoteOn')).length === 2);
    check ('clamped keyboard settings are written', configWrites (events, 'apply').join() === 'Config 3 = 96,Config 36 = 0', configWrites (events, 'apply').join ('; '));
}

// The keyboard's own settings: written when values load, and only the ones that differ from the keyboard's
{
    const P = makeValues (6, { pitchBendRange: 1, strikeSensitivity: 64, pressureSensitivity: 127, liftSensitivity: 127, brightness: 50 });
    const Q = Int32Array.from (P);
    Q[settingIndex ('brightness')] = 30;
    const R = Int32Array.from (P);
    R[settingIndex ('mpeMode')] = 1;
    R[settingIndex ('pitchBendRange')] = 24;

    const events = simulate (writeProgram (P), [
        '# start', 'cfg 3 48', 'cfg 10 100', 'cfg 13 100', 'cfg 14 100', 'cfg 36 100', 'init',
        '# restart', 'reboot',
        '# preview', ...heapWrites (Q), `msg ${MSG.apply} 1`,
        '# same', ...heapWrites (Q), `msg ${MSG.apply} 1`,
        '# revert', `msg ${MSG.revert}`,
        '# mpe', ...heapWrites (R), `msg ${MSG.apply} 1`, 'repaint 20'
    ]);

    const writes = section => configWrites (events, section).join();
    check ('start writes every keyboard setting that differs', writes ('start') === 'Config 3 = 1,Config 10 = 64,Config 13 = 127,Config 14 = 127,Config 36 = 50', writes ('start'));
    check ('a restart with the settings in place writes nothing', writes ('restart') === '', writes ('restart'));
    check ('a preview writes only the setting it changes', writes ('preview') === 'Config 36 = 30', writes ('preview'));
    check ('the same preview again writes nothing', writes ('same') === '', writes ('same'));
    check ('revert writes the program\'s value back', writes ('revert') === 'Config 36 = 50', writes ('revert'));
    check ('MPE announces a previewed pitch bend range', writes ('mpe') === 'Config 3 = 24' && events.some (e => e.section === 'mpe' && /^CC\s+1 6 24$/.test (e.text)), writes ('mpe'));
}

//==============================================================================
// A preview draws and plays the same as the same values written into the program
{
    const midi = { midiChan: 2, polyAT: true, mpeMode: false, toggleVel: false, fixedVel: 93 };
    const A = makeValues (4, Object.assign ({ onBright: 90, offBright: 60 }, midi));
    const B = makeValues (5, Object.assign ({ onBright: 35, offBright: 75, fadeColors: true, fadeInc: 15, toggleVB: true }, midi));

    const tail = ['# after', 'repaint 3', 'strike 7 60', 'press 7 30', 'repaint 4', 'lift 5 10', 'lift 7 10', 'repaint 6',
                  'btn 2', 'midi 144 90 64', 'repaint 3', 'midi 128 90 0', 'repaint 8', 'btn 0', 'repaint 2', 'btn 0', 'repaint 2'];

    const preview = simulate (writeProgram (A), ['init', 'host 1', 'repaint 2', 'strike 5 90', 'repaint 1', ...heapWrites (B), `msg ${MSG.apply} 1`, ...tail]);
    const baked = simulate (writeProgram (B), ['init', 'host 1', 'repaint 2', 'strike 5 90', 'repaint 1', 'btn 0', ...tail]);

    const output = events => events.filter (e => e.section === 'after' && ! e.text.startsWith ('HostMsg')).map (e => `${e.frame} ${e.text}`);
    const a = output (preview), b = output (baked);
    const at = a.findIndex ((line, i) => line !== b[i]);

    check ('preview output matches the same values written into the program', a.length === b.length && at < 0,
           `lines ${a.length} vs ${b.length}, first difference: ${a[at]} vs ${b[at]}`);
    check ('preview comparison covers LED output', a.filter (l => l.includes ('LED')).length > 500);
}

//==============================================================================
// Parity with customcolors.littlefoot: settings set before init are written into the program, later changes are
// previewed through shared memory, as the Dashboard changes them in the original. The keyboard settings aren't script
// variables in the original: they keep ROLI's defaults, whose pitch bend range of 48 is lfsim's, so MPE announcements match
function originalDefaults()
{
    const values = new Int32Array (Core.VALUE_COUNT);
    const source = fs.readFileSync (ORIGINAL, 'utf8');
    const re = /<variable[^>]*[ ]name="([A-Za-z0-9_]+)"[^>]*type="([a-z]+)"[^>]*value="([^"]*)"/g;
    const keyboardSettings = Core.SETTINGS.filter (s => s.config !== undefined);
    let count = 0;

    for (let m; (m = re.exec (source)) !== null; ++count)
        values[valueIndex (m[1])] = simValue (m[3]);

    for (const s of keyboardSettings)
        values[settingIndex (s.name)] = s.def;

    check ('original script declares every value but the keyboard settings', count === Core.VALUE_COUNT - keyboardSettings.length, `${count} metadata variables`);
    return values;
}

function valueIndex (name)
{
    let m;

    if ((m = /^keyOnCol(\d+)$/.exec (name)))  return Number (m[1]);
    if ((m = /^keyOffCol(\d+)$/.exec (name))) return Core.OFF_BASE + Number (m[1]);
    if ((m = /^octCol(\d+)$/.exec (name)))    return Core.OCTAVE_BASE + Number (m[1]);

    const i = Core.SETTINGS.findIndex (s => s.name === name);

    if (i < 0)
        throw new Error (`no editor value for ${name}`);

    return Core.SETTINGS_BASE + i;
}

const simValue = text => text === 'true' ? 1 : text === 'false' ? 0 : Number (text) | 0;

function translate (lines, defaults)
{
    const values = Int32Array.from (defaults);
    let baked = null;
    const out = [];

    for (const line of lines)
    {
        const [cmd, name, value] = line.split (/\s+/);

        if (cmd !== 'set')
        {
            if (cmd === 'init' && baked === null)
                baked = Int32Array.from (values);

            out.push (line);
            continue;
        }

        values[valueIndex (name)] = simValue (value);

        if (baked !== null)
            out.push (...heapWrites (values), `msg ${MSG.apply} 0`);
    }

    return { baked, lines: out };
}

const scenarios = {
    single: ['init', 'repaint 2', 'strike 0 100', 'press 0 60', 'move 0 9000', 'btn 2', 'lift 0 40'],

    mpe: ['init', 'set mpeMode 1', 'repaint 18', 'strike 0 100', 'strike 4 90', 'strike 7 80', 'move 4 10000', 'press 4 70',
          'lift 4 30', 'strike 9 100', 'host 1', 'repaint 17', 'set mpeUpperZone 1', 'repaint 17', 'strike 2 100',
          'lift 0 10', 'lift 7 10', 'lift 9 10', 'lift 2 10', 'set mpeMembers 2', 'repaint 4', 'strike 0 100', 'strike 1 100',
          'strike 2 100', 'lift 0 0', 'lift 1 0', 'lift 2 0', 'set mpeMode 0', 'repaint 3', 'btn 2', 'btn 2', 'btn 2', 'btn 2',
          'strike 23 100', 'lift 23 0', 'midi 144 10 100']
};

for (const fade of [0, 1])
    for (const vb of [0, 1])
        scenarios[`led fade ${fade} velocity brightness ${vb}`] = [
            `set fadeColors ${fade}`, `set toggleVB ${vb}`, 'set fadeInc 15', 'set onBright 70', 'set offBright 40',
            'set keyOnCol0 0xFF8040', 'set keyOffCol0 0x102030', 'set keyOnCol5 0xFF00FF00', 'set keyOffCol5 0x80FF0000',
            'set keyOnCol10 0x2040FF', 'set keyOffCol10 0xFFFFFF', 'set octCol6 0x00FFAA', 'set octCol7 0xAA00FF',
            'init', 'host 1', 'repaint 2', 'btn 0', 'repaint 2', 'strike 0 127', 'strike 5 64', 'repaint 3', 'midi 144 82 100',
            'repaint 2', 'lift 0 30', 'repaint 3', 'strike 0 20', 'repaint 2', 'lift 0 30', 'repaint 10', 'midi 128 82 0',
            'midi 128 82 0', 'repaint 10', 'btn 2', 'repaint 2', 'lift 5 0', 'repaint 10', 'btn 0', 'set onBright 100',
            'repaint 2', 'btn 0', 'strike 10 90', 'repaint 3', 'lift 10 10', 'repaint 8'];

for (const mode of [0, 1])
{
    const lines = [`set mpeMode ${mode}`, 'set fadeColors 1', 'set fadeInc 20'];

    for (let k = 0; k < 24; ++k)
        lines.push (`set keyOnCol${k} 0xFF0000`, `set keyOffCol${k} 0x0000FF`);

    lines.push ('init', 'host 1', 'repaint 20', 'btn 0', 'repaint 2');

    for (let k = 0; k < 24; ++k)
        lines.push (`strike ${k} 100`, 'repaint 2', `lift ${k} 50`, 'repaint 8');

    scenarios[`fade every key, MPE ${mode}`] = lines;
}

{
    const defaults = originalDefaults();
    // The editor program writes the keyboard settings when its values load; the original leaves them to Dashboard
    const configItems = Core.SETTINGS.filter (s => s.config !== undefined).map (s => s.config);
    const isKeyboardSetting = text => { const m = /^Config (\d+) = /.exec (text); return m !== null && configItems.includes (Number (m[1])); };
    const deviceOutput = events => events.filter (e => ! e.text.startsWith ('HostMsg') && ! e.text.startsWith ('(') && ! isKeyboardSetting (e.text)).map (e => `${e.frame} ${e.text}`);

    for (const [name, lines] of Object.entries (scenarios))
    {
        const t = translate (lines, defaults);
        const original = deviceOutput (simulate (ORIGINAL, lines));
        const editor = simulate (writeProgram (t.baked), t.lines);
        const e = deviceOutput (editor);
        const at = original.findIndex ((line, i) => line !== e[i]);

        check (`parity, ${name}`, original.length === e.length && at < 0,
               `lines ${original.length} vs ${e.length}, first difference at ${at}: ${original[at]} vs ${e[at]}`);

        // Every apply replies once with the sum of the values written before it, and nothing else is sent
        const heap = new Int32Array (Core.VALUE_COUNT);
        const expected = [];

        for (const line of t.lines)
        {
            const [cmd, a, b] = line.split (' ');

            if (cmd === 'heap')
                heap[Number (a) / 4] = Number (b);
            else if (cmd === 'msg')
                expected.push ([MSG.apply, Core.valueSum (heap), 0].map (hex).join (' '));
        }

        const replies = hostMessages (editor).map (m => m.values.map (hex).join (' '));
        check (`parity, ${name}: the program only sends replies to apply`, replies.join() === expected.join(),
               `got [${replies.join (' | ')}], expected [${expected.join (' | ')}]`);
        console.log (`parity ${name}: ${original.length} lines, ${original.filter (l => l.includes ('LED')).length} LED, ${original.filter (l => ! l.includes ('LED')).length} MIDI`);
    }
}

fs.rmSync (work, { recursive: true, force: true });
console.log (`${passed} passed, ${failed} failed`);
process.exit (failed ? 1 : 0);
