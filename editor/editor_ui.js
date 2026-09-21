// customcolors editor page: MIDI ports, the keyboard session, the color and settings editors, and what the page
// keeps in this browser (the current edits, named sets, preferences).
(function ()
{
'use strict';

const Core = EditorCore;
const $ = id => document.getElementById (id);

const STORAGE_WORKING = 'customcolors-editor.working';
const STORAGE_SETS = 'customcolors-editor.sets';
const STORAGE_PREFS = 'customcolors-editor.prefs';
const PORT_MATCH = /roli|lumi|piano m|block/i;    // port names differ between systems, so this only preselects
const SHARP = [1, 3, 6, 8, 10];

let state = Core.defaultState();
let editOn = false;
let fillValue = 0xFFFFFFFF;
let midi = null, input = null, output = null, session = null;
let tickTimer = 0, uiTimer = 0, saveTimer = 0;
let keyboardValuesOffered = null;   // the keyboard's values, while the page asks which to keep
let firmware = '';
const logLines = [];
const octaveSwatches = [];
const bendPressSwatches = [];

// The pitch bend colors, then the pressure colors, as the page shows them
const BEND_PRESS = [['Bend down', 'bend'], ['Bend center', 'bend'], ['Bend up', 'bend'], ['No pressure', 'pressure'], ['Full pressure', 'pressure']];

//==============================================================================
// Storage can be missing or refuse writes (private windows, blocked site data): the page works without it
function storageGet (key)
{
    try
    {
        const text = localStorage.getItem (key);
        return text === null ? null : JSON.parse (text);
    }
    catch (e)
    {
        return null;
    }
}

function storageSet (key, value)
{
    try
    {
        localStorage.setItem (key, JSON.stringify (value));
        return true;
    }
    catch (e)
    {
        $('storageWarning').hidden = false;
        return false;
    }
}

function scheduleSave()
{
    clearTimeout (saveTimer);
    saveTimer = setTimeout (saveWorking, 300);
}

function saveWorking()
{
    clearTimeout (saveTimer);
    saveTimer = 0;
    storageSet (STORAGE_WORKING, Core.stateToFile (state, ''));
}

function savePrefs()
{
    storageSet (STORAGE_PREFS, { editOn, livePreview: $('livePreview').checked, showPackets: $('showPackets').checked });
}

function loadSets()
{
    const data = storageGet (STORAGE_SETS);
    return data && Array.isArray (data.sets) ? data.sets.filter (s => s && typeof s.name === 'string' && s.data) : [];
}

//==============================================================================
function log (text, cls)
{
    const t = new Date();
    const stamp = t.toTimeString().slice (0, 8) + '.' + String (t.getMilliseconds()).padStart (3, '0');

    // Device strings can end in a NUL (the firmware version does), and a NUL cuts off text pasted from the Windows clipboard
    const printable = Array.from (String (text), ch =>
    {
        const code = ch.charCodeAt (0);
        return code === 9 || code === 10 || (code >= 32 && code !== 127) ? ch : '';
    }).join ('');

    const line = `${stamp}  ${printable}`;
    logLines.push (line);

    if (logLines.length > 3000)
        logLines.splice (0, logLines.length - 3000);

    const el = $('log');
    const div = document.createElement ('div');
    div.textContent = line;

    if (cls)
        div.className = cls;

    el.appendChild (div);

    while (el.childNodes.length > 1500)
        el.removeChild (el.firstChild);

    el.scrollTop = el.scrollHeight;
}

function showMessage (text, cls)
{
    $('message').textContent = text;
    $('message').className = 'message ' + (cls || '');
}

//==============================================================================
function hslColor (h, s, l)
{
    const f = n =>
    {
        const k = (n + h / 30) % 12;
        const a = s * Math.min (l, 1 - l);
        return Math.round ((l - a * Math.max (-1, Math.min (k - 3, 9 - k, 1))) * 255);
    };

    return (0xFF000000 | (f (0) << 16) | (f (8) << 8) | f (4)) >>> 0;
}

// A color picker plus the full ARGB value as hex; the picker has no alpha, so picking keeps the alpha byte
function makeSwatch (label, sharp, onChange)
{
    const cell = document.createElement ('div');
    cell.className = 'swatch' + (sharp ? ' sharp' : '');

    const name = document.createElement ('span');
    name.className = 'swatch-label';
    name.textContent = label;

    const color = document.createElement ('input');
    color.type = 'color';
    color.setAttribute ('aria-label', `${label} color`);

    const hex = document.createElement ('input');
    hex.type = 'text';
    hex.className = 'swatch-hex';
    hex.spellcheck = false;
    hex.maxLength = 10;
    hex.title = 'ARGB in hex: 8 digits set the full value, 6 digits an opaque color';
    hex.setAttribute ('aria-label', `${label}, ARGB hex`);

    cell.append (name, color, hex);

    const swatch = { cell, value: 0 };

    swatch.set = v =>
    {
        swatch.value = v >>> 0;
        color.value = Core.cssColor (v);

        if (document.activeElement !== hex)
        {
            hex.value = Core.formatColor (v);
            hex.classList.remove ('invalid');
        }
    };

    color.addEventListener ('input', () =>
    {
        swatch.value = ((swatch.value & 0xFF000000) | parseInt (color.value.slice (1), 16)) >>> 0;
        hex.value = Core.formatColor (swatch.value);
        hex.classList.remove ('invalid');
        onChange (swatch.value);
    });

    hex.addEventListener ('input', () =>
    {
        const v = Core.parseColor (hex.value);
        hex.classList.toggle ('invalid', v === null);

        if (v === null)
            return;

        swatch.value = v;
        color.value = Core.cssColor (v);
        onChange (v);
    });

    hex.addEventListener ('blur', () =>
    {
        hex.value = Core.formatColor (swatch.value);
        hex.classList.remove ('invalid');
    });

    return swatch;
}

//==============================================================================
// The 24 keys drawn as the keyboard, two octaves in the proportions of a real one. A white key is drawn as the
// shape you actually see, notched around the black keys sitting on it, so no two keys share any area.
const KEY_W = 30, KEY_H = 160, BLACK_W = 18, BLACK_H = 100, BOARD_PAD = 8, KEY_GAP = 1.5, KEY_R = 4;
const NOTCH_W = BLACK_W / 2 + KEY_GAP / 2;      // a notch clears its black key by the gap that separates two white keys
const NOTCH_D = BLACK_H + KEY_GAP;
const RING_INSETS = [0.75, 1.875];              // the white box's outer edge is the key's edge, the black line follows inside it
const BOARD_W = BOARD_PAD * 2 + 14 * KEY_W, BOARD_H = BOARD_PAD * 2 + KEY_H;
const WHITE_STEPS = [0, 2, 4, 5, 7, 9, 11];     // the semitones that are white keys

const keyCells = [];                            // per key: its path, its number, and the two marking outlines
let selectedKey = -1;

const roundTo = v => Math.round (v * 100) / 100;

function svgEl (name, attrs)
{
    const el = document.createElementNS (SVG_NS, name);

    for (const key in attrs)
        el.setAttribute (key, attrs[key]);

    return el;
}

function keyGeometry()
{
    const keys = [];

    for (let n = 0; n < Core.KEY_COUNT; ++n)
    {
        const oct = Math.floor (n / 12), s = n % 12;

        if (SHARP.includes (s))
        {
            //A black key straddles the line between the two white keys it sits between
            const below = WHITE_STEPS.filter (w => w < s).length - 1;
            const centre = BOARD_PAD + (oct * 7 + below + 1) * KEY_W;
            keys.push ({ black: true, x: centre - BLACK_W / 2, y: BOARD_PAD, w: BLACK_W, h: BLACK_H });
        }
        else
        {
            const x = BOARD_PAD + (oct * 7 + WHITE_STEPS.indexOf (s)) * KEY_W;
            keys.push ({ black: false, x: x + KEY_GAP / 2, y: BOARD_PAD, w: KEY_W - KEY_GAP, h: KEY_H,
                         notchLeft: SHARP.includes (s - 1), notchRight: SHARP.includes (s + 1) });
        }
    }

    return keys;
}

//Square at the top, rounded at the front. Shrinking the shape moves every edge inward, which widens and deepens a notch
function keyPath (k, inset)
{
    const i = inset || 0;
    const r = Math.max (0.5, (k.black ? KEY_R - 1 : KEY_R) - i);
    const x = roundTo (k.x + i), y = roundTo (k.y + i);
    const right = roundTo (k.x + k.w - i), bottom = roundTo (k.y + k.h - i);

    if (k.black)
        return `M${x},${y} H${right} V${roundTo (bottom - r)} a${r},${r} 0 0 1 ${-r},${r}`
             + ` H${roundTo (x + r)} a${r},${r} 0 0 1 ${-r},${-r} Z`;

    const depth = roundTo (k.y + NOTCH_D + i);
    const left = k.notchLeft ? roundTo (k.x + NOTCH_W + i) : x;
    const stem = k.notchRight ? roundTo (k.x + k.w - NOTCH_W - i) : right;
    const parts = [`M${left},${y}`, `H${stem}`];

    if (k.notchRight)
        parts.push (`V${depth}`, `H${right}`);

    parts.push (`V${roundTo (bottom - r)}`, `a${r},${r} 0 0 1 ${-r},${r}`,
                `H${roundTo (x + r)}`, `a${r},${r} 0 0 1 ${-r},${-r}`);

    if (k.notchLeft)
        parts.push (`V${depth}`, `H${left}`);

    parts.push (`V${y}`, 'Z');
    return parts.join (' ');
}

function buildKeyboard()
{
    const board = $('keys');
    const white = svgEl ('g', {}), black = svgEl ('g', {}), numbers = svgEl ('g', { 'aria-hidden': 'true' });

    board.setAttribute ('viewBox', `0 0 ${BOARD_W} ${BOARD_H}`);
    board.appendChild (svgEl ('rect', { class: 'bed', x: 0, y: 0, width: BOARD_W, height: BOARD_H, rx: 6 }));

    keyGeometry().forEach ((k, i) =>
    {
        const path = svgEl ('path', { class: 'key', d: keyPath (k), tabindex: 0, role: 'button',
                                      'aria-label': `Key ${i + 1}` });
        const title = svgEl ('title', {});
        title.textContent = `Key ${i + 1}`;
        path.appendChild (title);

        const number = svgEl ('text', { class: 'number', x: roundTo (k.x + k.w / 2),
                                        y: roundTo (k.y + k.h - (k.black ? 12 : 16)) });
        number.textContent = String (i + 1);

        (k.black ? black : white).appendChild (path);
        numbers.appendChild (number);
        keyCells.push ({ path, number, ring: keyPath (k, RING_INSETS[0]), inner: keyPath (k, RING_INSETS[1]) });

        path.addEventListener ('pointerover', () => markKey ('hover', i));
        path.addEventListener ('focus', () => markKey ('hover', i));
        path.addEventListener ('click', () => selectKey (i));
        path.addEventListener ('keydown', e =>
        {
            if (e.key === 'Enter' || e.key === ' ')
            {
                e.preventDefault();
                selectKey (i);
            }
        });
    });

    board.append (white, black, numbers);

    //Drawn last, so a mark is never hidden behind the key next to it
    for (const kind of ['selected', 'hover'])
    {
        const g = svgEl ('g', { class: `indicator ${kind}`, 'aria-hidden': 'true' });
        g.append (svgEl ('path', { class: 'ring-outer' }), svgEl ('path', { class: 'ring-inner' }));
        board.appendChild (g);
    }

    board.addEventListener ('pointerleave', () => clearMark ('hover'));
    board.addEventListener ('focusout', () => clearMark ('hover'));
}

function markKey (which, i)
{
    const g = $('keys').querySelector (`.indicator.${which}`);
    g.querySelector ('.ring-outer').setAttribute ('d', keyCells[i].ring);
    g.querySelector ('.ring-inner').setAttribute ('d', keyCells[i].inner);
    g.classList.add ('on');
}

function clearMark (which)
{
    $('keys').querySelector (`.indicator.${which}`).classList.remove ('on');
}

function selectKey (i)
{
    selectedKey = i;
    markKey ('selected', i);
    renderPicked();
}

//Relative luminance, so a key's number stays legible whatever color the key is
function readableOn (argb)
{
    const lin = v => { const f = v / 255; return f <= 0.03928 ? f / 12.92 : Math.pow ((f + 0.055) / 1.055, 2.4); };
    const l = 0.2126 * lin ((argb >> 16) & 0xFF) + 0.7152 * lin ((argb >> 8) & 0xFF) + 0.0722 * lin (argb & 0xFF);
    return l > 0.4 ? '#14161a' : '#ffffff';
}

function paintKey (i)
{
    const v = (editOn ? state.on : state.off)[i] >>> 0;
    keyCells[i].path.style.fill = Core.cssColor (v);
    keyCells[i].number.style.fill = readableOn (v);
}

function renderKeys()
{
    for (let i = 0; i < Core.KEY_COUNT; ++i)
        paintKey (i);

    if (selectedKey >= 0)
        markKey ('selected', selectedKey);

    renderPicked();
}

//The field names the selected key and the picker edits it, both following the selection and never the pointer
function renderPicked()
{
    const picked = selectedKey >= 0;
    const value = picked ? (editOn ? state.on : state.off)[selectedKey] >>> 0 : 0;

    $('pickedName').value = picked ? `Key ${selectedKey + 1}` : 'None';
    $('pickedColor').disabled = ! picked;
    $('pickedHex').disabled = ! picked;
    $('pickedColor').value = Core.cssColor (value);

    if (document.activeElement !== $('pickedHex'))
    {
        $('pickedHex').value = picked ? Core.formatColor (value) : '';
        $('pickedHex').classList.remove ('invalid');
    }
}

function makeKeyPicker()
{
    const color = $('pickedColor'), hex = $('pickedHex');

    const apply = v =>
    {
        (editOn ? state.on : state.off)[selectedKey] = v >>> 0;
        paintKey (selectedKey);
        changed (true);
    };

    color.addEventListener ('input', () =>
    {
        if (selectedKey < 0)
            return;

        //The picker has no alpha, so the key keeps the alpha byte it already had
        const current = (editOn ? state.on : state.off)[selectedKey] >>> 0;
        const v = ((current & 0xFF000000) | parseInt (color.value.slice (1), 16)) >>> 0;
        hex.value = Core.formatColor (v);
        hex.classList.remove ('invalid');
        apply (v);
    });

    hex.addEventListener ('input', () =>
    {
        if (selectedKey < 0)
            return;

        const v = Core.parseColor (hex.value);
        hex.classList.toggle ('invalid', v === null);

        if (v === null)
            return;

        color.value = Core.cssColor (v);
        apply (v);
    });

    hex.addEventListener ('blur', renderPicked);
}

function buildEditors()
{
    buildKeyboard();
    makeKeyPicker();

    for (let j = 0; j < Core.OCTAVE_COUNT; ++j)
    {
        const s = makeSwatch (`Octave ${j - 2}`, false, v =>
        {
            state.octave[j] = v;
            changed (true);
        });

        octaveSwatches.push (s);
        $('octaves').appendChild (s.cell);
    }

    BEND_PRESS.forEach (([label, group], j) =>
    {
        const s = makeSwatch (label, false, v =>
        {
            if (j < Core.BEND_COUNT)
                state.bend[j] = v;
            else
                state.pressure[j - Core.BEND_COUNT] = v;

            changed (true);
        });

        s.cell.dataset.group = group;
        bendPressSwatches.push (s);
        $('bendPressColors').appendChild (s.cell);
    });

    for (const el of document.querySelectorAll ('[data-setting]'))
    {
        const s = Core.SETTINGS.find (x => x.name === el.dataset.setting);

        if (el.type === 'checkbox')
        {
            el.addEventListener ('change', () =>
            {
                state.settings[s.name] = el.checked;
                updateSettingGroups();
                changed (false);
            });
        }
        else
        {
            el.addEventListener ('input', () =>
            {
                if (el.value.trim() === '' || ! Number.isFinite (Number (el.value)))
                    return;

                state.settings[s.name] = Core.clampSetting (s, el.value);
                updateSettingGroups();
                changed (el.hasAttribute ('data-lights'));
            });

            el.addEventListener ('change', () => { el.value = state.settings[s.name]; });
        }
    }

    const fill = makeFill();
    $('fillAll').onclick = () => fillKeys (() => true);
    $('fillWhite').onclick = () => fillKeys (i => ! SHARP.includes (i % 12));
    $('fillBlack').onclick = () => fillKeys (i => SHARP.includes (i % 12));
    fill.set (fillValue);
}

function makeFill()
{
    const color = $('fillColor'), hex = $('fillHex');

    const set = v =>
    {
        fillValue = v >>> 0;
        color.value = Core.cssColor (v);
        hex.value = Core.formatColor (v);
        hex.classList.remove ('invalid');
    };

    color.addEventListener ('input', () => set ((fillValue & 0xFF000000) | parseInt (color.value.slice (1), 16)));

    hex.addEventListener ('input', () =>
    {
        const v = Core.parseColor (hex.value);
        hex.classList.toggle ('invalid', v === null);

        if (v !== null)
        {
            fillValue = v;
            color.value = Core.cssColor (v);
        }
    });

    hex.addEventListener ('blur', () => set (fillValue));
    return { set };
}

function fillKeys (which)
{
    const colors = editOn ? state.on : state.off;

    for (let i = 0; i < Core.KEY_COUNT; ++i)
        if (which (i))
            colors[i] = fillValue;

    render();
    changed (true);
}

function setEditOn (on)
{
    editOn = on;
    savePrefs();
    render();
}

function render()
{
    renderKeys();
    octaveSwatches.forEach ((s, j) => s.set (state.octave[j]));
    bendPressSwatches.forEach ((s, j) => s.set (j < Core.BEND_COUNT ? state.bend[j] : state.pressure[j - Core.BEND_COUNT]));

    $('editOn').checked = editOn;
    $('onSide').classList.toggle ('active', editOn);
    $('offSide').classList.toggle ('active', ! editOn);
    $('brightnessLabel').textContent = editOn ? 'Key On Brightness' : 'Key Off Brightness';
    $('copyToOther').textContent = editOn ? 'Copy to off colors' : 'Copy to on colors';

    const bright = state.settings[editOn ? 'onBright' : 'offBright'];
    $('brightness').value = bright;
    $('brightnessValue').textContent = `${bright}%`;

    for (const el of document.querySelectorAll ('[data-setting]'))
    {
        const v = state.settings[el.dataset.setting];

        if (el.type === 'checkbox')
            el.checked = !! v;
        else if (document.activeElement !== el)
            el.value = v;
    }

    updateSettingGroups();
    renderCurves();
}

// Dims the settings the other ones make irrelevant; they stay editable
function updateSettingGroups()
{
    const s = state.settings;
    const dim = { single: s.mpeMode, mpe: ! s.mpeMode, fixedVel: ! s.toggleVel, fade: ! s.fadeColors,
                  bend: ! (s.bendPressColors & 1), pressure: ! (s.bendPressColors & 2) };

    for (const el of document.querySelectorAll ('[data-group]'))
        el.classList.toggle ('disabled', !! dim[el.dataset.group]);
}

//==============================================================================
const SVG_NS = 'http://www.w3.org/2000/svg';
const curveCards = [];

// A sensitivity card: the name, a slider, Dashboard's response graph and the value
function buildCurves()
{
    for (const sensitivity of Core.SENSITIVITY)
    {
        const setting = Core.SETTINGS.find (s => s.name === sensitivity.name);
        const card = document.createElement ('div');
        card.className = 'curve';

        const name = document.createElement ('span');
        name.className = 'curve-name';
        name.textContent = sensitivity.label;

        const slider = document.createElement ('input');
        slider.type = 'range';
        slider.className = 'curve-slider';
        slider.min = setting.min;
        slider.max = setting.max;
        slider.step = 1;
        slider.dataset.setting = sensitivity.name;
        slider.setAttribute ('aria-label', `${sensitivity.label} Sensitivity`);

        const graph = document.createElementNS (SVG_NS, 'svg');
        graph.setAttribute ('class', 'curve-graph');
        graph.setAttribute ('viewBox', '0 0 100 70');
        graph.setAttribute ('preserveAspectRatio', 'none');
        graph.setAttribute ('aria-hidden', 'true');

        const grid = document.createElementNS (SVG_NS, 'path');
        grid.setAttribute ('class', 'curve-grid');
        grid.setAttribute ('vector-effect', 'non-scaling-stroke');
        let lines = '';

        for (let i = 1; i < 20; ++i)
            lines += `M${i * 5} 0V70M0 ${(i * 3.5).toFixed (1)}H100`;

        grid.setAttribute ('d', lines);

        const line = document.createElementNS (SVG_NS, 'path');
        line.setAttribute ('class', 'curve-line');
        line.setAttribute ('vector-effect', 'non-scaling-stroke');

        const value = document.createElement ('output');
        value.className = 'curve-value';

        graph.append (grid, line);
        card.append (name, slider, graph, value);
        $('curves').appendChild (card);

        slider.addEventListener ('input', () =>
        {
            state.settings[sensitivity.name] = Core.clampSetting (setting, slider.value);
            renderCurves();
            changed (false);
        });

        curveCards.push ({ sensitivity, slider, line, value });
    }
}

// Dashboard draws the curve from the bottom left corner; at 0 it draws a line along the top for strike,
// nothing for pressure and a line along the bottom for lift
function renderCurves()
{
    if (curveCards.length === 0)
        buildCurves();

    for (const card of curveCards)
    {
        const value = state.settings[card.sensitivity.name];
        let d = '';

        // The cards are built during the first draw, after render() has been round the other settings
        if (document.activeElement !== card.slider)
            card.slider.value = value;

        if (value > 0)
        {
            d = 'M0 70';

            for (let i = 1; i <= 100; ++i)
                d += `L${i} ${(70 * (1 - Core.sensitivityCurve (i / 100, value))).toFixed (2)}`;
        }
        else if (card.sensitivity.zero === 'top')
            d = 'M0 0H100';
        else if (card.sensitivity.zero === 'bottom')
            d = 'M0 70H100';

        card.line.setAttribute ('d', d);
        card.value.textContent = value;
    }
}

// Every edit: keep it in this browser and show it on the keyboard; lights asks the keyboard to turn its lights on
function changed (lights)
{
    scheduleSave();

    if (keyboardValuesOffered !== null)
    {
        keyboardValuesOffered = null;
        $('notice').hidden = true;
    }

    preview (lights);
}

function preview (lights)
{
    if (session && session.ready && $('livePreview').checked && keyboardValuesOffered === null)
        session.preview (Core.stateToValues (state), lights);
}

function loadState (newState)
{
    state = newState;
    render();
    scheduleSave();
}

//==============================================================================
function renderSets()
{
    const list = $('sets');
    const sets = loadSets();
    list.textContent = '';

    if (sets.length === 0)
    {
        const li = document.createElement ('li');
        li.className = 'empty';
        li.textContent = 'No saved sets yet.';
        list.appendChild (li);
        return;
    }

    sets.forEach ((entry, index) =>
    {
        const read = Core.stateFromFile (entry.data);
        const li = document.createElement ('li');

        const strip = document.createElement ('span');
        strip.className = 'strip';
        strip.style.gridTemplateRows = 'repeat(2, 1fr)';
        strip.title = 'Off colors above, on colors below';

        if (read.state)
        {
            for (const v of [...read.state.off, ...read.state.on])
            {
                const cell = document.createElement ('span');
                cell.style.background = Core.cssColor (v);
                strip.appendChild (cell);
            }
        }

        const name = document.createElement ('span');
        name.className = 'set-name';
        name.textContent = entry.name;

        const date = document.createElement ('span');
        date.className = 'set-date';
        date.textContent = entry.savedAt ? new Date (entry.savedAt).toLocaleString() : '';

        const load = document.createElement ('button');
        load.textContent = 'Load';
        load.disabled = ! read.state;
        load.onclick = () =>
        {
            // A copy: edits after loading mustn't change what this button loads next time
            loadState (Core.cloneState (read.state));
            $('setName').value = entry.name;
            changed (true);
            showMessage (`Loaded "${entry.name}".`, 'ok');
        };

        const exportButton = document.createElement ('button');
        exportButton.textContent = 'Export';
        exportButton.onclick = () => downloadJson (entry.data, entry.name);

        const remove = document.createElement ('button');
        remove.textContent = 'Delete';
        remove.onclick = () =>
        {
            if (! confirm (`Delete the set "${entry.name}" from this browser?`))
                return;

            const all = loadSets();
            all.splice (index, 1);
            storageSet (STORAGE_SETS, { sets: all });
            renderSets();
        };

        li.append (strip, name, date, load, exportButton, remove);
        list.appendChild (li);
    });
}

function addSet (name, data)
{
    const sets = loadSets();
    const existing = sets.findIndex (s => s.name === name);
    const entry = { name, savedAt: new Date().toISOString(), data };

    if (existing >= 0)
        sets[existing] = entry;
    else
        sets.unshift (entry);

    const ok = storageSet (STORAGE_SETS, { sets });
    renderSets();
    return ok;
}

function fileName (name)
{
    const base = String (name || 'customcolors').trim().replace (/[^A-Za-z0-9 _.-]+/g, '').replace (/\s+/g, '-');
    return (base || 'customcolors') + '.json';
}

function downloadJson (data, name)
{
    const blob = new Blob ([JSON.stringify (data, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL (blob);
    const a = document.createElement ('a');
    a.href = url;
    a.download = fileName (name);
    document.body.appendChild (a);
    a.click();
    a.remove();
    setTimeout (() => URL.revokeObjectURL (url), 1000);
}

async function importFile (file)
{
    let data;

    try
    {
        data = JSON.parse (await file.text());
    }
    catch (e)
    {
        showMessage (`${file.name} isn't a JSON file.`, 'bad');
        return;
    }

    const read = Core.stateFromFile (data);

    if (! read.state)
    {
        showMessage (`${file.name}: ${read.problems[0]}`, 'bad');
        return;
    }

    loadState (read.state);
    $('setName').value = read.name || file.name.replace (/\.json$/i, '');
    changed (true);

    if (read.problems.length === 0)
        showMessage (`Imported ${file.name}.`, 'ok');
    else
    {
        showMessage (`Imported ${file.name} with ${read.problems.length} problem${read.problems.length === 1 ? '' : 's'}, which kept their defaults: ${read.problems.slice (0, 3).join (' ')}${read.problems.length > 3 ? ' …' : ''}`, 'warn');
        read.problems.forEach (p => log (`Import: ${p}`, 'warn'));
    }
}

//==============================================================================
async function enableMidi()
{
    if (! navigator.requestMIDIAccess)
    {
        showMessage ('Web MIDI isn\'t available in this browser: use Chrome or Edge.', 'bad');
        return false;
    }

    try
    {
        midi = await navigator.requestMIDIAccess ({ sysex: true });
    }
    catch (e)
    {
        showMessage (`MIDI access was refused (${e.name}): allow MIDI with system exclusive messages for this page.`, 'bad');
        return false;
    }

    midi.onstatechange = fillPorts;
    fillPorts();
    log ('Web MIDI enabled with system exclusive messages.');
    return true;
}

function fillPorts()
{
    fillSelect ($('inPort'), [...midi.inputs.values()]);
    fillSelect ($('outPort'), [...midi.outputs.values()]);
}

function fillSelect (select, ports)
{
    const previous = select.value;
    select.textContent = '';
    select.disabled = false;

    if (ports.length === 0)
    {
        const option = document.createElement ('option');
        option.textContent = 'No MIDI ports';
        option.value = '';
        select.appendChild (option);
        return;
    }

    for (const p of ports)
    {
        const option = document.createElement ('option');
        option.value = p.id;
        option.textContent = p.name + (p.state === 'disconnected' ? ' (disconnected)' : '');
        select.appendChild (option);
    }

    const chosen = ports.find (p => p.id === previous) || ports.find (p => PORT_MATCH.test (p.name));

    if (chosen)
        select.value = chosen.id;
}

async function connect()
{
    if (! midi)
    {
        if (! await enableMidi())
            return;

        const found = [...midi.inputs.values()].some (p => PORT_MATCH.test (p.name)) && [...midi.outputs.values()].some (p => PORT_MATCH.test (p.name));

        if (! found)
        {
            showMessage ('No Piano M MIDI ports found. Connect the keyboard, or choose its ports below, then press Connect.', 'warn');
            return;
        }
    }

    input = midi.inputs.get ($('inPort').value);
    output = midi.outputs.get ($('outPort').value);

    if (! input || ! output)
    {
        showMessage ('Choose the keyboard\'s MIDI input and output, then press Connect.', 'warn');
        return;
    }

    try
    {
        await input.open();
        await output.open();
    }
    catch (e)
    {
        showMessage (`Couldn't open the MIDI ports (${e.message}). ROLI Connect or the ROLI Hardware Driver service may be holding them.`, 'bad');
        return;
    }

    input.onmidimessage = e =>
    {
        if (session && e.data[0] === 0xF0)
            session.handleMidiMessage (e.data);
    };

    firmware = '';
    session = new Core.EditorSession ({
        program: EDITOR_PROGRAM,
        send: bytes =>
        {
            try { output.send (bytes); }
            catch (e) { log (`Send failed: ${e.message}`, 'bad'); }
        },
        onEvent: handleSessionEvent
    });

    session.start();
    tickTimer = setInterval (() => session && session.tick(), 20);
    uiTimer = setInterval (updateStatus, 200);
    log (`Connecting through "${input.name}" and "${output.name}".`);
    showMessage ('', '');
    updateStatus();
}

function disconnect()
{
    if (session)
    {
        session.stop();
        log ('Disconnected.');
    }

    clearInterval (tickTimer);
    clearInterval (uiTimer);

    if (input)
        input.onmidimessage = null;

    session = null;
    keyboardValuesOffered = null;
    $('notice').hidden = true;
    updateStatus();
}

//==============================================================================
function handleSessionEvent (ev)
{
    const packets = $('showPackets').checked;

    switch (ev.type)
    {
        case 'sent':            if (packets) log (`→ ${ev.what} ${Blocks.toHex (ev.bytes)}`, 'muted'); break;
        case 'received':        if (packets) log (`← ${Blocks.toHex (ev.bytes)}`, 'muted'); break;
        case 'apiConnected':    log ('The keyboard accepted the connection.', 'ok'); break;
        case 'memoryUnknown':   log ('The keyboard\'s memory state was lost; checking what it runs.', 'warn'); break;
        case 'programLoaded':   log ('Program upload complete.', 'ok'); break;
        case 'saveSent':        log ('Asked the keyboard to save the program as its default.'); break;
        case 'stopped':         break;

        case 'topology':
            log (`Found ${ev.devices.map (d => `${d.serial} (battery ${d.batteryLevel}${d.batteryCharging ? ', charging' : ''})`).join (', ') || 'no devices'}.`);

            if (ev.chosen && ! ev.chosen.serial.startsWith ('LKB'))
                log (`${ev.chosen.serial} isn't a Piano M or LUMI Keys serial number (LKB…).`, 'warn');
            break;

        case 'apiDisconnected':
            log ('No reply from the keyboard for 6 seconds: reconnecting.', 'bad');
            showMessage ('Lost the connection to the keyboard; reconnecting.', 'warn');
            break;

        case 'error':
            log (ev.message, 'bad');
            showMessage (ev.message, 'bad');
            break;

        case 'keyboard':
            log ({ unknown: 'Keyboard program: unknown.', checking: 'Checking the keyboard\'s program.', editor: 'The keyboard runs this version of customcolors.',
                   otherBuild: 'The keyboard runs a different version of customcolors.', otherFormat: 'The keyboard runs a version of customcolors this page can\'t read.',
                   other: 'The keyboard runs another program.', uploading: 'Uploading customcolors.' }[ev.kind] || ev.kind);
            break;

        case 'ready':
            offerKeyboardValues (ev.values);
            break;

        case 'report':
            useKeyboardValues (ev.values);
            showMessage ('Loaded the keyboard\'s colors and settings.', 'ok');
            break;

        case 'reportFailed':
            log (`The keyboard's report was incomplete: ${ev.missing} values missing.`, 'bad');
            showMessage ('Couldn\'t read the keyboard\'s colors and settings. Try again, or save this page\'s to the keyboard.', 'bad');
            break;

        case 'previewed':
            if (! ev.ok)
            {
                log ('The keyboard didn\'t confirm a preview.', 'warn');
                showMessage ('The keyboard didn\'t confirm the last change; it gets the next one.', 'warn');
            }
            break;

        case 'reverted':
            showMessage (ev.ok ? 'Preview discarded: the keyboard shows its saved colors and settings.' : 'The keyboard didn\'t confirm going back to its saved colors.', ev.ok ? 'ok' : 'warn');
            break;

        case 'uploaded':
            if (ev.verified)
                showMessage (ev.saved ? 'Saved: the keyboard now runs these colors and settings on its own.'
                                      : 'Uploaded to try out: the keyboard goes back to its saved program when it restarts.', 'ok');
            else
                showMessage (`${ev.saved ? 'Sent and saved' : 'Sent'}, but the keyboard didn't report the values back. Check the keys, or use Load from keyboard.`, 'warn');

            log (`Upload ${ev.saved ? 'and save ' : ''}finished${ev.verified ? ', values verified' : ', not verified'}.`, ev.verified ? 'ok' : 'warn');
            break;

        case 'message':
            handleDeviceMessage (ev.message, packets);
            break;
    }

    updateStatus();
}

function handleDeviceMessage (m, packets)
{
    if (m.type === 'version')
    {
        firmware = m.version;
        log (`Firmware version ${m.version}`);
    }
    else if (m.type === 'log')
        log (`Keyboard log: ${m.text}`);
    else if (packets)
        log (`Keyboard: ${JSON.stringify (m)}`, 'muted');
}

// The keyboard runs customcolors: when its values differ from the page's, the page asks which to keep
function offerKeyboardValues (values)
{
    if (Core.sameValues (values, Core.stateToValues (state)))
    {
        showMessage ('The keyboard has the same colors and settings as this page.', 'ok');
        return;
    }

    keyboardValuesOffered = values;
    $('noticeText').textContent = 'The keyboard\'s colors and settings are different from this page\'s. Which do you want to keep editing?';
    $('notice').hidden = false;
}

// Replacing the page's edits keeps them as a set, unless they're the defaults
function useKeyboardValues (values)
{
    const current = Core.stateToValues (state);

    if (! Core.sameValues (current, values) && ! Core.sameValues (current, Core.stateToValues (Core.defaultState())))
    {
        const name = `Before loading from the keyboard, ${new Date().toLocaleString()}`;
        addSet (name, Core.stateToFile (state, name));
        log (`Kept this page's previous edits as the set "${name}".`);
    }

    loadState (Core.valuesToState (values));
    keyboardValuesOffered = null;
    $('notice').hidden = true;
}

//==============================================================================
const KEYBOARD_TEXT = {
    none:        'Not connected. Your edits are kept in this browser until you connect.',
    looking:     'Looking for the keyboard. If nothing happens, check that ROLI Connect is closed and the ROLI Hardware Driver service is stopped.',
    connecting:  'Found the keyboard; waiting for it to accept the connection.',
    unknown:     'Waiting for the keyboard.',
    checking:    'Checking which program the keyboard runs.',
    other:       'The keyboard runs another program. Try on keyboard uploads customcolors until the keyboard restarts; Save to keyboard replaces its saved program (you can send your script from ROLI Connect again later).',
    otherBuild:  'The keyboard runs a different version of customcolors. Load from keyboard reads its colors and settings; Save to keyboard updates it to this version.',
    otherFormat: 'The keyboard runs a version of customcolors this page can\'t read. Save to keyboard updates it to this version.',
    uploading:   'Uploading customcolors with this page\'s colors and settings.'
};

function updateStatus()
{
    const conn = session ? session.conn : null;
    const k = session ? session.keyboard : 'none';
    const connected = !! (conn && conn.apiConnected);
    const busy = !! (session && session.busy());

    let status, dot, text;

    if (! session)                  { status = 'Not connected'; dot = ''; text = KEYBOARD_TEXT.none; }
    else if (! conn.device)         { status = 'Looking for the keyboard…'; dot = 'warn'; text = KEYBOARD_TEXT.looking; }
    else if (! connected)           { status = 'Connecting…'; dot = 'warn'; text = KEYBOARD_TEXT.connecting; }
    else if (k === 'editor')
    {
        status = 'Connected';
        dot = 'ok';
        text = $('livePreview').checked ? 'The keyboard runs customcolors. Changes show on it as you edit; Save to keyboard keeps them after it restarts.'
                                        : 'The keyboard runs customcolors. Live preview is off: changes reach the keyboard when you save them.';

        if (session.previewActive)
            text += ' It\'s showing unsaved changes.';
    }
    else if (k === 'uploading')
    {
        const p = conn.syncProgress();
        status = `Uploading ${Math.round (100 * p.matching / p.total)}%`;
        dot = 'warn';
        text = KEYBOARD_TEXT.uploading;
    }
    else
    {
        status = k === 'checking' || k === 'unknown' ? 'Connected, checking…' : 'Connected';
        dot = k === 'checking' || k === 'unknown' ? 'warn' : 'ok';
        text = KEYBOARD_TEXT[k] || '';
    }

    $('statusText').textContent = status;
    $('statusDot').className = 'dot ' + dot;
    $('keyboardText').textContent = text;
    $('keyboardText').className = 'keyboard-text' + (session ? '' : ' muted');
    $('connectButton').textContent = session ? 'Disconnect' : 'Connect';
    $('connectButton').classList.toggle ('primary', ! session);
    $('setupPanel').hidden = connected;

    const uploading = k === 'uploading';
    $('progress').hidden = ! uploading;

    if (uploading)
    {
        const p = conn.syncProgress();
        $('progressBar').style.width = `${(100 * p.matching / p.total).toFixed (1)}%`;
    }

    const canUpload = connected && ! busy && ! ['checking', 'unknown', 'uploading'].includes (k);
    $('loadButton').disabled = ! connected || busy || ! (k === 'editor' || k === 'otherBuild');
    $('discardButton').disabled = ! (session && session.ready && session.previewActive) || busy;
    $('tryButton').disabled = ! canUpload;
    $('saveButton').disabled = ! canUpload;
}

//==============================================================================
function wire()
{
    $('connectButton').onclick = () => (session ? disconnect() : connect());

    $('editOn').addEventListener ('change', () => setEditOn ($('editOn').checked));
    $('offSide').addEventListener ('click', e => { e.preventDefault(); setEditOn (false); });
    $('onSide').addEventListener ('click', e => { e.preventDefault(); setEditOn (true); });

    $('brightness').addEventListener ('input', () =>
    {
        const v = Number ($('brightness').value);
        state.settings[editOn ? 'onBright' : 'offBright'] = v;
        $('brightnessValue').textContent = `${v}%`;
        changed (true);
    });

    $('copyToOther').onclick = () =>
    {
        if (editOn)
            state.off = state.on.slice();
        else
            state.on = state.off.slice();

        changed (true);
        showMessage (`Copied the ${editOn ? 'on' : 'off'} colors to the ${editOn ? 'off' : 'on'} colors.`, 'ok');
    };

    $('presetRainbow').onclick = () =>
    {
        const colors = editOn ? state.on : state.off;

        for (let i = 0; i < Core.KEY_COUNT; ++i)
            colors[i] = hslColor (i * 15, 1, 0.5);

        render();
        changed (true);
    };

    $('livePreview').addEventListener ('change', () =>
    {
        savePrefs();

        if ($('livePreview').checked)
            preview (true);
        else if (session && session.ready && session.previewActive)
            session.revert();

        updateStatus();
    });

    $('loadButton').onclick = () => session && session.readKeyboard() && showMessage ('Reading the keyboard\'s colors and settings…', '');
    $('discardButton').onclick = () => session && session.revert();

    $('tryButton').onclick = () =>
    {
        if (session && session.upload (Core.stateToValues (state), false))
            showMessage ('Uploading…', '');
    };

    $('saveButton').onclick = () =>
    {
        if (! session)
            return;

        const replacing = session.keyboard === 'editor' ? '' : '\n\nThis replaces the program the keyboard runs now. You can send your own script from ROLI Connect again later.';

        if (! confirm (`Save these colors and settings to the keyboard? It runs them on its own from now on, including after it restarts.${replacing}`))
            return;

        if (session.upload (Core.stateToValues (state), true))
            showMessage ('Saving to the keyboard…', '');
    };

    $('noticeKeyboard').onclick = () =>
    {
        if (keyboardValuesOffered === null)
            return;

        useKeyboardValues (keyboardValuesOffered);
        showMessage ('Editing the keyboard\'s colors and settings.', 'ok');
    };

    $('noticePage').onclick = () =>
    {
        keyboardValuesOffered = null;
        $('notice').hidden = true;
        preview (true);
        showMessage ($('livePreview').checked ? 'Showing this page\'s colors and settings on the keyboard. Save to keyboard keeps them.'
                                              : 'Keeping this page\'s colors and settings. Save to keyboard sends them.', 'ok');
    };

    $('saveSet').onclick = () =>
    {
        const name = $('setName').value.trim() || `Set ${loadSets().length + 1}`;

        if (loadSets().some (s => s.name === name) && ! confirm (`Replace the saved set "${name}"?`))
            return;

        if (addSet (name, Core.stateToFile (state, name)))
            showMessage (`Saved "${name}" in this browser.`, 'ok');
    };

    $('exportFile').onclick = () => downloadJson (Core.stateToFile (state, $('setName').value.trim()), $('setName').value.trim());
    $('importFile').onclick = () => $('importInput').click();

    $('importInput').addEventListener ('change', () =>
    {
        const file = $('importInput').files[0];
        $('importInput').value = '';

        if (file)
            importFile (file);
    });

    $('showPackets').addEventListener ('change', savePrefs);

    $('copyLog').onclick = async () =>
    {
        try
        {
            await navigator.clipboard.writeText (logLines.join ('\n'));
            log ('Log copied to the clipboard.', 'ok');
        }
        catch (e)
        {
            log (`Couldn't copy the log (${e.message}).`, 'bad');
        }
    };

    $('clearLog').onclick = () =>
    {
        logLines.length = 0;
        $('log').textContent = '';
    };

    window.addEventListener ('beforeunload', () =>
    {
        if (session)
            session.stop();
    });

    // A closing page never runs the save timer, and background tabs delay it
    window.addEventListener ('pagehide', () =>
    {
        if (saveTimer)
            saveWorking();
    });

    document.addEventListener ('visibilitychange', () =>
    {
        if (document.visibilityState === 'hidden' && saveTimer)
            saveWorking();
    });
}

//==============================================================================
// Only Windows needs something stopped: its ROLI driver service holds the keyboard, while macOS and Linux share
// MIDI ports between applications
function showPlatformStep()
{
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    const step = $('platformStep');
    const code = text => { const el = document.createElement ('code'); el.textContent = text; return el; };

    step.textContent = '';

    if (/win/i.test (platform))
        step.append ('Close ROLI Connect, then stop the ROLI Hardware Driver service, which otherwise holds the keyboard. In an administrator PowerShell: ',
                     code ('Stop-Service "ROLI Hardware Driver"'), '. Start it again afterwards with ',
                     code ('Start-Service "ROLI Hardware Driver"'), '.');
    else if (/mac/i.test (platform))
        step.textContent = 'Quit ROLI Connect and ROLI Dashboard so they don\'t talk to the keyboard while this page does. '
                         + 'macOS shares MIDI ports between applications, so nothing has to be stopped.';
    else
        step.textContent = 'Close anything else that talks to the keyboard, such as ROLI software or a DAW. '
                         + 'MIDI ports are shared between applications here, so nothing has to be stopped.';
}

function start()
{
    const saved = storageGet (STORAGE_WORKING);

    if (saved)
    {
        const read = Core.stateFromFile (saved);

        if (read.state)
            state = read.state;
    }

    const prefs = storageGet (STORAGE_PREFS) || {};
    editOn = prefs.editOn === true;
    $('livePreview').checked = prefs.livePreview !== false;
    $('showPackets').checked = prefs.showPackets === true;

    try
    {
        localStorage.setItem ('customcolors-editor.check', '1');
        localStorage.removeItem ('customcolors-editor.check');
    }
    catch (e)
    {
        $('storageWarning').hidden = false;
    }

    if (! window.isSecureContext)
    {
        $('contextWarning').textContent = 'This page isn\'t in a secure context, so the browser may refuse MIDI access. Open it as a local file or from http://localhost.';
        $('contextWarning').hidden = false;
    }

    showPlatformStep();
    buildEditors();
    wire();
    render();
    renderSets();
    updateStatus();
}

start();
})();
