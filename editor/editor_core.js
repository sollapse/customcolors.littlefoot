// Piano M color editor: values, program patching, shared-memory preview and the keyboard session.
// Runs in the browser (window.EditorCore, after blocks.js) and in Node for the tests.
(function (root, factory)
{
    if (typeof module !== 'undefined' && module.exports)
        module.exports = factory (require ('./blocks.js'));
    else
        root.EditorCore = factory (root.Blocks);
}) (typeof self !== 'undefined' ? self : this, function (Blocks)
{
'use strict';

//==============================================================================
// Value numbers, as in editor_program.littlefoot: 0-23 on colors, 24-47 off colors, 48-58 octave button colors,
// then the settings, the pitch bend colors and the pressure colors. Shared memory holds value n at offset n * 4.
const KEY_COUNT = 24;
const OCTAVE_COUNT = 11;
const OFF_BASE = KEY_COUNT;
const OCTAVE_BASE = 2 * KEY_COUNT;
const SETTINGS_BASE = OCTAVE_BASE + OCTAVE_COUNT;

// In the order loadBaked(), loadHeap() and getValue() use; switches are stored as 0 or 1.
// config: the keyboard's own setting (config item id) the program writes the value to, with the range and default
// of the BLOCKS SDK's config table (roli_BlockConfigManager.h)
const SETTINGS = [
    { name: 'onBright',            min: 0, max: 100, def: 100 },
    { name: 'offBright',           min: 0, max: 100, def: 100 },
    { name: 'midiChan',            min: 1, max: 16,  def: 1 },
    { name: 'polyAT',              bool: true, def: true },
    { name: 'mpeMode',             bool: true, def: false },
    { name: 'mpeUpperZone',        bool: true, def: false },
    { name: 'mpeMembers',          min: 1, max: 15,  def: 15 },
    { name: 'toggleVel',           bool: true, def: false },
    { name: 'fixedVel',            min: 1, max: 127, def: 93 },
    { name: 'toggleVB',            bool: true, def: false },
    { name: 'fadeColors',          bool: true, def: false },
    { name: 'fadeInc',             min: 1, max: 100, def: 10 },
    { name: 'pitchBendRange',      min: 1, max: 96,  def: 48,  config: 3 },
    { name: 'strikeSensitivity',   min: 0, max: 127, def: 100, config: 10 },
    { name: 'pressureSensitivity', min: 0, max: 127, def: 100, config: 13 },
    { name: 'liftSensitivity',     min: 0, max: 127, def: 100, config: 14 },
    { name: 'brightness',          min: 0, max: 100, def: 100, config: 36 },
    // What held keys' colors follow: 0 nothing, 1 pitch bend, 2 pressure, 3 both. Version 1 files don't have it
    { name: 'bendPressColors',     min: 0, max: 3,   def: 0, since: 2 }
];

// The pitch bend colors (down, center, up) and the pressure colors (off, full) follow the settings
const BEND_COUNT = 3;
const PRESSURE_COUNT = 2;
const BEND_BASE = SETTINGS_BASE + SETTINGS.length;
const PRESSURE_BASE = BEND_BASE + BEND_COUNT;
const BEND_DEFAULTS = [0xFFDB6108, 0xFFFFFFFF, 0xFF0099FF];
const PRESSURE_DEFAULTS = [0xFFFFFFFF, 0xFFDB6108];

const VALUE_COUNT = PRESSURE_BASE + PRESSURE_COUNT;
const HEAP_BLOCK_SIZE = VALUE_COUNT * 4;
const DEFAULT_COLOR = 0xFFFFFFFF;

// Program messages; replies use the same ids. Format 2 reports the pitch bend and pressure values too
const MSG = { info: 0x43430001, report: 0x43430002, apply: 0x43430003, revert: 0x43430004, values: 0x43430100 };
const MESSAGE_FORMAT = 2;

// Version 2 added the pitch bend and pressure colors; version 1 files load with their defaults
const FILE_FORMAT = 'customcolors-editor';
const FILE_VERSION = 2;

//==============================================================================
// 6 hex digits are an opaque color, 8 digits the full ARGB value; a leading '#' or '0x' is optional
function parseColor (text)
{
    if (typeof text === 'number')
        return Number.isInteger (text) && text >= -0x80000000 && text <= 0xFFFFFFFF ? text >>> 0 : null;

    const m = /^\s*(?:#|0x)?([0-9a-f]{6}|[0-9a-f]{8})\s*$/i.exec (String (text));

    if (! m)
        return null;

    const v = parseInt (m[1], 16);
    return (m[1].length === 6 ? 0xFF000000 | v : v) >>> 0;
}

const formatColor = v => (v >>> 0).toString (16).toUpperCase().padStart (8, '0');
const cssColor = v => '#' + ((v >>> 0) & 0xFFFFFF).toString (16).padStart (6, '0');

//==============================================================================
function defaultState()
{
    const settings = {};

    for (const s of SETTINGS)
        settings[s.name] = s.def;

    return {
        on: new Array (KEY_COUNT).fill (DEFAULT_COLOR),
        off: new Array (KEY_COUNT).fill (DEFAULT_COLOR),
        octave: new Array (OCTAVE_COUNT).fill (DEFAULT_COLOR),
        bend: BEND_DEFAULTS.slice(),
        pressure: PRESSURE_DEFAULTS.slice(),
        settings
    };
}

function cloneState (s)
{
    return { on: s.on.slice(), off: s.off.slice(), octave: s.octave.slice(), bend: s.bend.slice(), pressure: s.pressure.slice(),
             settings: Object.assign ({}, s.settings) };
}

function clampSetting (s, value)
{
    if (s.bool)
        return !! value;

    const n = Math.round (Number (value));
    return Number.isFinite (n) ? Math.min (s.max, Math.max (s.min, n)) : s.def;
}

function stateToValues (state)
{
    const values = new Int32Array (VALUE_COUNT);

    for (let i = 0; i < KEY_COUNT; ++i)
    {
        values[i] = state.on[i] | 0;
        values[OFF_BASE + i] = state.off[i] | 0;
    }

    for (let i = 0; i < OCTAVE_COUNT; ++i)
        values[OCTAVE_BASE + i] = state.octave[i] | 0;

    for (let i = 0; i < BEND_COUNT; ++i)
        values[BEND_BASE + i] = state.bend[i] | 0;

    for (let i = 0; i < PRESSURE_COUNT; ++i)
        values[PRESSURE_BASE + i] = state.pressure[i] | 0;

    SETTINGS.forEach ((s, i) =>
    {
        const v = clampSetting (s, state.settings[s.name]);
        values[SETTINGS_BASE + i] = s.bool ? (v ? 1 : 0) : v;
    });

    return values;
}

function valuesToState (values)
{
    const state = defaultState();

    for (let i = 0; i < KEY_COUNT; ++i)
    {
        state.on[i] = values[i] >>> 0;
        state.off[i] = values[OFF_BASE + i] >>> 0;
    }

    for (let i = 0; i < OCTAVE_COUNT; ++i)
        state.octave[i] = values[OCTAVE_BASE + i] >>> 0;

    for (let i = 0; i < BEND_COUNT; ++i)
        state.bend[i] = values[BEND_BASE + i] >>> 0;

    for (let i = 0; i < PRESSURE_COUNT; ++i)
        state.pressure[i] = values[PRESSURE_BASE + i] >>> 0;

    SETTINGS.forEach ((s, i) =>
    {
        const v = values[SETTINGS_BASE + i];
        state.settings[s.name] = s.bool ? v !== 0 : clampSetting (s, v);
    });

    return state;
}

// valueSum() in the program: a wrapping 32-bit sum
function valueSum (values)
{
    let sum = 0;

    for (let i = 0; i < values.length; ++i)
        sum = (sum + values[i]) | 0;

    return sum;
}

function sameValues (a, b)
{
    if (! a || ! b || a.length !== b.length)
        return false;

    for (let i = 0; i < a.length; ++i)
        if ((a[i] | 0) !== (b[i] | 0))
            return false;

    return true;
}

// The program with every value written into its placeholder, and its checksum updated
function patchProgram (program, values)
{
    const bytes = program.bytes.slice();

    for (let n = 0; n < VALUE_COUNT; ++n)
        Blocks.Program.writeInt32 (bytes, program.valueSlots[n], values[n] | 0);

    Blocks.Program.updateChecksum (bytes);
    return bytes;
}

// The values as the program reads them from shared memory
function heapBlock (values)
{
    const bytes = new Uint8Array (HEAP_BLOCK_SIZE);
    const view = new DataView (bytes.buffer);

    for (let n = 0; n < VALUE_COUNT; ++n)
        view.setInt32 (n * 4, values[n] | 0, true);

    return bytes;
}

//==============================================================================
function stateToFile (state, name)
{
    const settings = {};

    for (const s of SETTINGS)
        settings[s.name] = clampSetting (s, state.settings[s.name]);

    const colors = list => list.map (v => '0x' + formatColor (v));

    return {
        format: FILE_FORMAT,
        version: FILE_VERSION,
        name: name || '',
        onColors: colors (state.on),
        offColors: colors (state.off),
        octaveColors: colors (state.octave),
        bendColors: colors (state.bend),
        pressureColors: colors (state.pressure),
        settings
    };
}

// Entries that are missing or unreadable keep their defaults and are listed in problems
function stateFromFile (data)
{
    if (! data || typeof data !== 'object' || data.format !== FILE_FORMAT)
        return { state: null, name: '', problems: ['This is not a Piano M color editor file.'] };

    const state = defaultState();
    const problems = [];

    // Version 1 files predate the pitch bend and pressure colors, which keep their defaults
    const v1 = data.version === 1;

    if (data.version !== FILE_VERSION && ! v1)
        problems.push (`File version ${data.version}, this editor reads versions 1 and ${FILE_VERSION}.`);

    const readColors = (key, target, label) =>
    {
        const list = data[key];

        if (! Array.isArray (list))
        {
            problems.push (`${label} colors are missing.`);
            return;
        }

        for (let i = 0; i < target.length; ++i)
        {
            const v = i < list.length ? parseColor (list[i]) : null;

            if (v === null)
                problems.push (`${label} ${i + 1}: ${i < list.length ? `"${list[i]}" is not a color` : 'missing'}.`);
            else
                target[i] = v;
        }
    };

    readColors ('onColors', state.on, 'On color, key');
    readColors ('offColors', state.off, 'Off color, key');
    readColors ('octaveColors', state.octave, 'Octave button color');

    if (! v1)
    {
        readColors ('bendColors', state.bend, 'Pitch bend color');
        readColors ('pressureColors', state.pressure, 'Pressure color');
    }

    const settings = data.settings && typeof data.settings === 'object' ? data.settings : {};

    for (const s of SETTINGS)
    {
        const v = settings[s.name];

        if (v === undefined)
        {
            if (! (v1 && s.since === 2))
                problems.push (`Setting ${s.name} is missing.`);
        }
        else if (s.bool ? typeof v !== 'boolean' : typeof v !== 'number' || ! Number.isFinite (v))
            problems.push (`Setting ${s.name}: ${JSON.stringify (v)} is not ${s.bool ? 'true or false' : 'a number'}.`);
        else
        {
            state.settings[s.name] = clampSetting (s, v);

            if (! s.bool && state.settings[s.name] !== v)
                problems.push (`Setting ${s.name}: ${v} is outside ${s.min}-${s.max}, using ${state.settings[s.name]}.`);
        }
    }

    return { state, name: typeof data.name === 'string' ? data.name : '', problems };
}

//==============================================================================
// Collects the program's report: msgValues + n carries values n and n + 1, msgReport ends it with the count and sum
class ReportCollector
{
    constructor()
    {
        this.values = new Int32Array (VALUE_COUNT);
        this.received = new Uint8Array (VALUE_COUNT);
        this.done = false;
        this.count = 0;
        this.sum = 0;
    }

    handle (message)
    {
        const [id, a, b] = message;

        if (id >= MSG.values && id < MSG.values + VALUE_COUNT)
        {
            const n = id - MSG.values;
            this.values[n] = a;
            this.received[n] = 1;

            if (n + 1 < VALUE_COUNT)
            {
                this.values[n + 1] = b;
                this.received[n + 1] = 1;
            }

            return true;
        }

        if (id === MSG.report)
        {
            this.done = true;
            this.count = a;
            this.sum = b;
            return true;
        }

        return false;
    }

    missingCount()
    {
        return this.received.reduce ((n, r) => n + (r ? 0 : 1), 0);
    }

    isComplete()
    {
        return this.done && this.count === VALUE_COUNT && this.missingCount() === 0 && valueSum (this.values) === this.sum;
    }
}

//==============================================================================
const PROBE_INTERVAL_MS = 600;
const PROBE_TRIES = 3;
const REPLY_TIMEOUT_MS = 1500;
const REPORT_TIMEOUT_MS = 3000;
const LOAD_SETTLE_MS = 300;

// The keyboard session: finds out what the keyboard runs, takes over the editor program's memory state from its
// report, previews values through shared memory, and uploads or saves the program with values written in.
// Events: every BlocksConnection event except program messages the session handles, plus
//   keyboard { kind }      'unknown', 'checking', 'editor', 'otherBuild', 'otherFormat', 'other' or 'uploading'
//   ready { values }       the editor program runs and its memory is known: preview is available
//   report { values }      answer to readKeyboard()
//   reportFailed { purpose, missing }
//   previewed { ok }       the program loaded a preview; ok when it holds what was sent
//   reverted { ok }        the program went back to the values written into it
//   uploaded { saved, verified, values }
class EditorSession
{
    constructor ({ program, send, now = () => Date.now(), onEvent = () => {} })
    {
        if (! program || ! program.valueSlots || program.valueSlots.length !== VALUE_COUNT)
            throw new Error (`The editor program has ${program && program.valueSlots ? program.valueSlots.length : 0} value placeholders; the editor expects ${VALUE_COUNT}.`);

        this.program = program;
        this.now = now;
        this.onEvent = onEvent;
        this.conn = new Blocks.BlocksConnection ({ send, now, resendAfterReset: false, onEvent: ev => this.handleConnectionEvent (ev) });

        this.keyboard = 'unknown';
        this.ready = false;
        this.previewActive = false;
        this.lightsOn = false;
        this.keyboardValues = null;     // what the program shows, as far as the session knows
        this.bakedValues = null;        // what is written into the program on the keyboard

        this.waiting = null;
        this.report = null;
        this.reportPurpose = '';
        this.pendingPreview = null;
        this.applySent = null;
        this.loadedAt = 0;
        this.uploadedValues = null;
        this.uploadSaved = false;
    }

    start()                     { this.conn.start(); }
    handleMidiMessage (bytes)   { return this.conn.handleMidiMessage (bytes); }
    busy()                      { return !! (this.waiting || this.conn.uploading || this.loadedAt); }

    // Before ending API mode, puts back the values written into the program if the keyboard shows a preview
    stop()
    {
        if (this.conn.apiConnected && this.ready && this.previewActive)
            this.conn.sendProgramEvent ([MSG.revert, 0, 0]);

        this.conn.stop (true);
        this.lose();
    }

    emit (type, fields)
    {
        this.onEvent (Object.assign ({ type }, fields));
    }

    setKeyboard (kind)
    {
        this.keyboard = kind;
        this.emit ('keyboard', { kind, previewActive: this.previewActive, lightsOn: this.lightsOn });
    }

    tick()
    {
        this.conn.tick();

        const now = this.now();
        const w = this.waiting;

        if (w && now > w.sentAt + w.timeoutMs)
        {
            if (w.triesLeft > 0)
                this.send (w, now);
            else
            {
                this.waiting = null;

                if (w.onTimeout)
                    w.onTimeout();
            }
        }

        if (this.applySent && now > this.applySent.sentAt + REPLY_TIMEOUT_MS)
        {
            this.applySent = null;
            this.emit ('previewed', { ok: false });
        }

        if (this.ready && this.pendingPreview && ! this.applySent && this.conn.heap.isFullySynced())
        {
            const p = this.pendingPreview;
            this.pendingPreview = null;
            this.applySent = { values: p.values, sum: valueSum (p.values), sentAt: now };
            this.conn.sendProgramEvent ([MSG.apply, p.lights ? 1 : 0, 0]);
        }

        if (this.loadedAt && now >= this.loadedAt + LOAD_SETTLE_MS)
        {
            this.loadedAt = 0;
            this.checkUploadedProgram();
        }
    }

    //==============================================================================
    handleConnectionEvent (ev)
    {
        switch (ev.type)
        {
            case 'apiConnected':
                this.onEvent (ev);
                this.checkKeyboard();
                return;

            case 'memoryUnknown':
            case 'apiDisconnected':
                if (this.keyboard === 'uploading')
                    this.emit ('error', { message: 'The upload was interrupted. Upload again once the keyboard is connected.' });

                this.lose();

                // Still connected (an ACK for a packet the connection didn't send): check again what the keyboard runs
                if (ev.type === 'memoryUnknown' && this.conn.apiConnected)
                    this.checkKeyboard();
                break;

            case 'programLoaded':
                this.loadedAt = this.now();
                break;

            case 'message':
                if (ev.message.type === 'programEvent' && this.handleProgramMessage (ev.message.values.map (v => v | 0)))
                    return;
                break;
        }

        this.onEvent (ev);
    }

    lose()
    {
        this.ready = false;
        this.waiting = null;
        this.report = null;
        this.pendingPreview = null;
        this.applySent = null;
        this.loadedAt = 0;

        if (this.keyboard !== 'unknown')
            this.setKeyboard ('unknown');
    }

    // Sends a program message and waits for the reply with the same id; a report counts as the reply when it ends
    request (id, p2, { onReply = null, onTimeout = null, tries = 1, timeoutMs = REPLY_TIMEOUT_MS } = {})
    {
        this.send ({ id, p2, onReply, onTimeout, triesLeft: tries, timeoutMs, sentAt: 0 }, this.now());
    }

    send (w, now)
    {
        --w.triesLeft;
        w.sentAt = now;
        this.waiting = w;

        if (w.id === MSG.report)
            this.report = new ReportCollector();

        this.conn.sendProgramEvent ([w.id, w.p2, 0]);
    }

    handleProgramMessage (message)
    {
        const [id, a] = message;
        const w = this.waiting;

        if (this.report && this.report.handle (message))
        {
            if (this.report.done)
            {
                const r = this.report;
                this.report = null;

                if (r.isComplete())
                {
                    this.waiting = null;
                    this.reportDone (r.values);
                }
                else if (w && w.id === MSG.report && w.triesLeft > 0)
                    this.send (w, this.now());
                else
                {
                    this.waiting = null;
                    this.emit ('reportFailed', { purpose: this.reportPurpose, missing: r.missingCount() });
                }
            }

            return true;
        }

        if (id === MSG.apply && this.applySent)
        {
            const sent = this.applySent;
            this.applySent = null;
            const ok = a === sent.sum;

            if (ok)
            {
                this.previewActive = true;
                this.keyboardValues = sent.values;
            }

            this.emit ('previewed', { ok });
            return true;
        }

        if (w && id === w.id && id !== MSG.report)
        {
            this.waiting = null;

            if (w.onReply)
                w.onReply (message);

            return true;
        }

        return (id >= MSG.info && id <= MSG.revert) || (id >= MSG.values && id < MSG.values + VALUE_COUNT);
    }

    //==============================================================================
    // Only the editor program answers msgInfo
    checkKeyboard()
    {
        this.ready = false;
        this.setKeyboard ('checking');

        this.request (MSG.info, 0, {
            tries: PROBE_TRIES,
            timeoutMs: PROBE_INTERVAL_MS,
            onReply: m => this.handleInfo (m),
            onTimeout: () => this.setKeyboard ('other')
        });
    }

    handleInfo ([, buildId, flags])
    {
        this.previewActive = (flags & 1) !== 0;
        this.lightsOn = (flags & 2) !== 0;

        if (flags >> 8 !== MESSAGE_FORMAT)
            return this.setKeyboard ('otherFormat');

        if ((buildId >>> 0) !== (this.program.buildId >>> 0))
            return this.setKeyboard ('otherBuild');

        // Taking over the memory state needs the exact program bytes, so the values written into the program:
        // a preview left on the keyboard hides them, so go back to them first
        if (! this.previewActive)
            return this.requestReport ('adopt');

        this.request (MSG.revert, 0, {
            tries: 2,
            onReply: () =>
            {
                this.previewActive = false;
                this.requestReport ('adopt');
            },
            onTimeout: () => this.setKeyboard ('other')
        });
    }

    requestReport (purpose)
    {
        this.reportPurpose = purpose;

        this.request (MSG.report, 0, {
            tries: 2,
            timeoutMs: REPORT_TIMEOUT_MS,
            onTimeout: () =>
            {
                const missing = this.report ? this.report.missingCount() : VALUE_COUNT;
                this.report = null;
                this.emit ('reportFailed', { purpose, missing });
            }
        });
    }

    reportDone (values)
    {
        this.keyboardValues = values;

        if (this.reportPurpose === 'adopt' || this.reportPurpose === 'verify')
        {
            if (this.reportPurpose === 'adopt' && ! this.conn.adoptProgram (patchProgram (this.program, values)))
            {
                this.emit ('error', { message: 'The keyboard\'s program could not be matched to this editor\'s program.' });
                return this.setKeyboard ('otherBuild');
            }

            this.bakedValues = values;
            this.ready = true;
            this.setKeyboard ('editor');

            if (this.reportPurpose === 'adopt')
                this.emit ('ready', { values });
            else
                this.emit ('uploaded', { saved: this.uploadSaved, verified: sameValues (values, this.uploadedValues), values });
        }
        else
            this.emit ('report', { values });
    }

    //==============================================================================
    readKeyboard()
    {
        if (this.busy() || ! (this.keyboard === 'editor' || this.keyboard === 'otherBuild'))
            return false;

        this.requestReport ('read');
        return true;
    }

    // Writes the values to shared memory; the program loads them once they have all arrived
    preview (values, lightsOn)
    {
        if (! this.ready)
            return false;

        this.conn.setHeapBytes (0, heapBlock (values));

        // A later change that doesn't ask for the lights keeps an earlier request that did
        const lights = !! lightsOn || (this.pendingPreview !== null && this.pendingPreview.lights);
        this.pendingPreview = { values: Int32Array.from (values), lights };
        return true;
    }

    revert()
    {
        if (! this.ready || this.busy())
            return false;

        this.pendingPreview = null;

        this.request (MSG.revert, 0, {
            tries: 2,
            onReply: ([, sum]) =>
            {
                this.previewActive = false;
                const ok = this.bakedValues !== null && sum === valueSum (this.bakedValues);

                if (ok)
                    this.keyboardValues = this.bakedValues;

                this.emit ('reverted', { ok });
            },
            onTimeout: () => this.emit ('reverted', { ok: false })
        });

        return true;
    }

    // Uploads the program with the values written in, and saves it as the keyboard's default when save is set.
    // Once it runs, the session checks it reports the uploaded values.
    upload (values, save)
    {
        if (! this.conn.apiConnected || this.busy())
            return false;

        this.lose();
        this.uploadedValues = Int32Array.from (values);
        this.uploadSaved = !! save;
        this.previewActive = false;
        this.setKeyboard ('uploading');
        this.conn.uploadProgram (patchProgram (this.program, values), !! save);
        return true;
    }

    checkUploadedProgram()
    {
        this.request (MSG.info, 0, {
            tries: PROBE_TRIES,
            timeoutMs: PROBE_INTERVAL_MS,
            onReply: ([, buildId, flags]) =>
            {
                this.previewActive = (flags & 1) !== 0;
                this.lightsOn = (flags & 2) !== 0;

                if ((buildId >>> 0) === (this.program.buildId >>> 0))
                    return this.requestReport ('verify');

                this.setKeyboard ('otherBuild');
                this.emit ('uploaded', { saved: this.uploadSaved, verified: false, values: null });
            },
            onTimeout: () =>
            {
                this.setKeyboard ('other');
                this.emit ('uploaded', { saved: this.uploadSaved, verified: false, values: null });
            }
        });
    }
}

//==============================================================================
// The three sensitivity settings, with what Dashboard draws for each when its value is 0
const SENSITIVITY = [
    { name: 'strikeSensitivity',   label: 'Strike',   zero: 'top' },
    { name: 'pressureSensitivity', label: 'Pressure', zero: 'none' },
    { name: 'liftSensitivity',     label: 'Lift',     zero: 'bottom' }
];

// The response curve Dashboard graphs for a sensitivity: the output, 0 to 1, for an input, 0 to 1. Read from
// Dashboard's own drawing code: a quadratic ease-out that reaches full output at value / 127, blended into a
// straight line by a smoothstep over the last fifth of the range, so 127 is exactly straight.
function sensitivityCurve (t, value)
{
    const v = Math.min (1, Math.max (0, value / 127));

    if (v <= 0)
        return 1;

    const c = Math.min (1, Math.max (0, (v - 0.8) / 0.2));
    const straight = c * c * (3 - 2 * c);
    const p = Math.min (1, Math.max (0, t / v));

    return (1 - straight) * ((1 - p) * (t / (v + 0.0001)) + p) + straight * t;
}

return {
    KEY_COUNT, OCTAVE_COUNT, OFF_BASE, OCTAVE_BASE, SETTINGS_BASE, SETTINGS, BEND_COUNT, PRESSURE_COUNT, BEND_BASE, PRESSURE_BASE,
    VALUE_COUNT, HEAP_BLOCK_SIZE, DEFAULT_COLOR,
    MSG, MESSAGE_FORMAT, FILE_FORMAT, FILE_VERSION, SENSITIVITY,
    parseColor, formatColor, cssColor, defaultState, cloneState, clampSetting, stateToValues, valuesToState, valueSum,
    sameValues, patchProgram, heapBlock, stateToFile, stateFromFile, sensitivityCurve, ReportCollector, EditorSession
};
});
