// End-to-end check of EditorSession against a simulated Piano M running the editor program: taking over a running
// program without uploading, previews that write only the preview block, revert, upload with save and verification,
// a ping timeout that must not resend memory, a preview left on the keyboard, another program, another build of the
// editor program, and a lost report message. Also checks the value, file and patching helpers.
// usage: node test_editor.js
'use strict';

const Blocks = require ('../blocks.js');
const Core = require ('../editor_core.js');
const PROGRAM = require ('../editor_program.js');

let failed = 0, passed = 0;

function check (name, ok, detail)
{
    if (ok) { ++passed; console.log (`ok   ${name}`); }
    else    { ++failed; console.log (`FAIL ${name}${detail ? ': ' + detail : ''}`); }
}

const MSG = Core.MSG;
const PROGRAM_SIZE = PROGRAM.bytes.length;
const BLOCK_START = PROGRAM_SIZE;
const BLOCK_END = PROGRAM_SIZE + Core.HEAP_BLOCK_SIZE;
const LIVE_START = BLOCK_END;           // the program's own arrays follow the preview block
const LIVE_SIZE = 64;

const readInt32 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
const sameBytes = (a, b) => a.length === b.length && a.every ((x, i) => x === b[i]);

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

//==============================================================================
// Answers the editor's messages the way editor_program.littlefoot does, reading its memory like the program
class FakeKeyboard
{
    constructor ({ program = 'editor', baked = null, buildId = PROGRAM.buildId, previewValues = null } = {})
    {
        this.memory = new Uint8Array (Blocks.PROGRAM_AND_HEAP_SIZE);
        this.apiMode = false;
        this.answering = true;
        this.lastPacketIndex = 37;
        this.toHost = [];
        this.problems = [];
        this.saved = null;
        this.time = 1000;
        this.writes = [];               // [start, end) of every range a data change set
        this.programEvents = [];
        this.commands = [];
        this.dropReportMessage = -1;    // report message to lose, once
        this.runningBuild = null;       // build id of the editor program running, null for any other program
        this.values = null;
        this.heapValues = false;
        this.lights = false;

        if (program === 'editor')
        {
            this.memory.set (Core.patchProgram (PROGRAM, baked));
            this.startProgram (buildId);
            this.memory.fill (0xAB, LIVE_START, LIVE_START + LIVE_SIZE);

            if (previewValues)
            {
                this.memory.set (Core.heapBlock (previewValues), BLOCK_START);
                this.values = Int32Array.from (previewValues);
                this.heapValues = true;
                this.lights = true;
            }
        }
    }

    startProgram (buildId)
    {
        this.runningBuild = buildId;
        this.values = this.clamped (PROGRAM.valueSlots.map (s => readInt32 (this.memory, s)));
        this.heapValues = false;
        this.lights = false;
    }

    clamped (list)
    {
        return Core.stateToValues (Core.valuesToState (Int32Array.from (list)));
    }

    packet (write)
    {
        const b = new Blocks.Packed7BitArrayBuilder (200);
        b.writeHeaderSysexBytes (0x40);
        b.writeBits (this.time, 32);
        write (b);
        b.writePacketSysexFooter();
        this.toHost.push (b.getBytes());
    }

    ack()
    {
        this.packet (b => { b.writeBits (Blocks.MessageFromDevice.packetACK, 7); b.writeBits (this.lastPacketIndex, 10); });
    }

    send (values)
    {
        this.packet (b =>
        {
            b.writeBits (Blocks.MessageFromDevice.programEventMessage, 7);

            for (const v of values)
                b.writeBits (v >>> 0, 32);
        });
    }

    receive (bytes)
    {
        if (! this.answering)
            return;

        const start = 6, size = bytes.length - 1 - start;

        if (Blocks.calculatePacketChecksum (bytes, start, start + size - 1) !== bytes[start + size - 1])
        {
            this.problems.push ('bad checksum from host');
            return;
        }

        const r = new Blocks.Packed7BitArrayReader (bytes, start, size - 1);
        const type = r.readBits (7);

        if (type === Blocks.MessageFromHost.deviceCommandMessage)       this.command (r.readBits (9));
        else if (type === Blocks.MessageFromHost.sharedDataChange)      this.dataChange (r, r.readBits (16));
        else if (type === Blocks.MessageFromHost.programEventMessage)   this.programEvent ([r.readBits (32) | 0, r.readBits (32) | 0, r.readBits (32) | 0]);
        else this.problems.push ('unexpected host message ' + type);
    }

    command (cmd)
    {
        const C = Blocks.DeviceCommand;
        this.commands.push (cmd);

        if (cmd === C.requestTopologyMessage)
        {
            this.packet (b =>
            {
                b.writeBits (Blocks.MessageFromDevice.deviceTopology, 7);
                b.writeBits (1, 8);
                b.writeBits (1, 7);
                b.writeBits (0, 8);

                for (const ch of 'LKB0123456789ABC')
                    b.writeBits (ch.charCodeAt (0), 7);

                b.writeBits (0, 7);
                b.writeBits (25, 5);
                b.writeBits (0, 1);
            });
        }
        else if (cmd === C.beginAPIMode)        { this.apiMode = true; this.ack(); }
        else if (cmd === C.endAPIMode)          { this.apiMode = false; }
        else if (cmd === C.ping)                { if (this.apiMode) this.ack(); }
        else if (cmd === C.saveProgramAsDefault) { this.saved = this.memory.slice (0, Blocks.Program.getProgramSize (this.memory, this.memory.length)); }
    }

    dataChange (r, index)
    {
        if (! this.apiMode)
            return;

        if (index !== ((this.lastPacketIndex + 1) & 1023))
        {
            this.problems.push (`packet ${index} out of order after ${this.lastPacketIndex}`);
            this.ack();
            return;
        }

        let pos = 0, last = 0, programTouched = false;

        const fill = (n, value) =>
        {
            this.writes.push ([pos, pos + n]);
            programTouched = programTouched || pos < PROGRAM_SIZE;
            this.memory.fill (value, pos, pos + n);
            pos += n;
        };

        for (;;)
        {
            const cmd = r.readBits (3);

            if (cmd === Blocks.DataChange.endOfPacket || cmd === Blocks.DataChange.endOfChanges)
                break;

            if (cmd === Blocks.DataChange.skipBytesFew)          pos += r.readBits (4);
            else if (cmd === Blocks.DataChange.skipBytesMany)    pos += r.readBits (8);
            else if (cmd === Blocks.DataChange.setSequenceOfBytes)
            {
                const from = pos;

                do
                {
                    last = r.readBits (8);
                    this.memory[pos++] = last;
                }
                while (r.readBits (1));

                this.writes.push ([from, pos]);
                programTouched = programTouched || from < PROGRAM_SIZE;
            }
            else if (cmd === Blocks.DataChange.setFewBytesWithValue)     { const n = r.readBits (4); last = r.readBits (8); fill (n, last); }
            else if (cmd === Blocks.DataChange.setFewBytesWithLastValue) { fill (r.readBits (4), last); }
            else if (cmd === Blocks.DataChange.setManyBytesWithValue)    { const n = r.readBits (8); last = r.readBits (8); fill (n, last); }
        }

        this.lastPacketIndex = index;
        this.ack();

        // A write into the program stops it; it starts again once the checksum matches
        if (programTouched)
        {
            const size = Blocks.Program.getProgramSize (this.memory, this.memory.length);

            if (size > 10 && Blocks.Program.checksumMatches (this.memory, this.memory.length))
                this.startProgram (PROGRAM.buildId);
            else
                this.runningBuild = null;
        }
    }

    programEvent (values)
    {
        this.programEvents.push ({ values, apiMode: this.apiMode });

        if (! this.apiMode || this.runningBuild === null)
            return;

        const [id, p2] = values;
        const sum = () => Core.valueSum (this.values);

        if (id === MSG.info)
        {
            this.send ([MSG.info, this.runningBuild, 0x100 | (this.heapValues ? 1 : 0) | (this.lights ? 2 : 0)]);
        }
        else if (id === MSG.report)
        {
            for (let n = 0, k = 0; n < Core.VALUE_COUNT; n += 2, ++k)
                if (k !== this.dropReportMessage)
                    this.send ([MSG.values + n, this.values[n], n + 1 < Core.VALUE_COUNT ? this.values[n + 1] : 0]);

            this.dropReportMessage = -1;
            this.send ([MSG.report, Core.VALUE_COUNT, sum()]);
        }
        else if (id === MSG.apply)
        {
            this.values = this.clamped (Array.from ({ length: Core.VALUE_COUNT }, (_, n) => readInt32 (this.memory, BLOCK_START + n * 4)));
            this.heapValues = true;
            this.lights = this.lights || p2 === 1;
            this.send ([MSG.apply, sum(), 0]);
        }
        else if (id === MSG.revert)
        {
            this.startProgram (this.runningBuild);
            this.lights = true;
            this.send ([MSG.revert, sum(), 0]);
        }
    }
}

function harness (keyboard)
{
    const h = { keyboard, clock: 50000, events: [] };

    h.session = new Core.EditorSession ({
        program: PROGRAM,
        send: bytes => keyboard.receive (bytes),
        now: () => h.clock,
        onEvent: ev => h.events.push (ev)
    });

    h.run = (ms, until) =>
    {
        for (let t = 0; t < ms; t += 20)
        {
            h.clock += 20;
            keyboard.time += 20;

            for (const bytes of keyboard.toHost.splice (0))
                h.session.handleMidiMessage (bytes);

            h.session.tick();

            if (until && until())
                return t + 20;
        }

        return -1;
    };

    h.all = type => h.events.filter (e => e.type === type);
    h.last = type => h.all (type).pop();
    h.session.start();
    return h;
}

const onlyPreviewBlock = writes => writes.length > 0 && writes.every (([s, e]) => s >= BLOCK_START && e <= BLOCK_END);
const describe = writes => JSON.stringify (writes.slice (0, 6));

//==============================================================================
// Helpers
{
    check ('6 hex digits are an opaque color', Core.parseColor ('#12ab34') === 0xFF12AB34 && Core.parseColor ('12AB34') === 0xFF12AB34);
    check ('8 hex digits are the full value', Core.parseColor ('0x8012AB34') === 0x8012AB34 && Core.parseColor ('00000000') === 0);
    check ('other text is not a color', [ '12345', '0x1234567', 'red', '', '#12ab34ff00' ].every (t => Core.parseColor (t) === null));
    check ('colors format as 8 digits', Core.formatColor (0x0000FF10) === '0000FF10' && Core.formatColor (-1) === 'FFFFFFFF');

    const state = Core.valuesToState (makeValues (61, { midiChan: 9, mpeUpperZone: true, fixedVel: 7, pitchBendRange: 1, strikeSensitivity: 64, brightness: 50 }));
    const back = Core.stateFromFile (JSON.parse (JSON.stringify (Core.stateToFile (state, 'Test'))));
    check ('file round trip', back.problems.length === 0 && back.name === 'Test' && Core.sameValues (Core.stateToValues (back.state), Core.stateToValues (state)),
           back.problems.join (' '));

    const partial = Core.stateFromFile ({ format: Core.FILE_FORMAT, version: 1, onColors: ['zz', '#102030'], settings: { midiChan: 40, mpeMode: 'yes' } });
    check ('a partial file keeps defaults and lists problems',
           partial.state.on[0] === Core.DEFAULT_COLOR && partial.state.on[1] === 0xFF102030 && partial.state.settings.midiChan === 16
           && partial.state.settings.mpeMode === false && partial.problems.length > 30, partial.problems.length + ' problems');
    check ('another file is refused', Core.stateFromFile ({ format: 'something' }).state === null);

    // The sensitivity curve, as read from Dashboard's drawing code
    const curveRises = value => Array.from ({ length: 100 }, (_, i) => Core.sensitivityCurve ((i + 1) / 100, value))
                                     .every ((y, i, all) => i === 0 || y >= all[i - 1] - 1e-12);
    check ('sensitivity 127 draws a straight line', [0, 0.25, 0.5, 0.75, 1].every (t => Math.abs (Core.sensitivityCurve (t, 127) - t) < 1e-9));
    check ('sensitivity 64 reaches full output at about half the input',
           Core.sensitivityCurve (0.45, 64) < 0.999 && Core.sensitivityCurve (0.52, 64) > 0.9999,
           `${Core.sensitivityCurve (0.45, 64).toFixed (4)} at 0.45, ${Core.sensitivityCurve (0.52, 64).toFixed (4)} at 0.52`);
    check ('sensitivity 64 matches Dashboard a quarter of the way in', Math.abs (Core.sensitivityCurve (0.25, 64) - 0.746) < 0.005,
           Core.sensitivityCurve (0.25, 64).toFixed (4));
    check ('sensitivity 100 is still curved', Core.sensitivityCurve (0.5, 100) > 0.8 && Core.sensitivityCurve (0.5, 100) < 0.9,
           Core.sensitivityCurve (0.5, 100).toFixed (4));
    check ('the curve never falls', [1, 16, 64, 100, 120, 127].every (curveRises));
    check ('the drawing at 0 follows Dashboard', Core.SENSITIVITY.map (s => `${s.name}:${s.zero}`).join (' ')
           === 'strikeSensitivity:top pressureSensitivity:none liftSensitivity:bottom');

    const values = makeValues (62, {});
    const patched = Core.patchProgram (PROGRAM, values);
    check ('patched program checksum matches', Blocks.Program.checksumMatches (patched, patched.length));
    check ('patched program holds every value', PROGRAM.valueSlots.every ((s, n) => readInt32 (patched, s) === values[n]));
    check ('patching leaves the template alone', PROGRAM.valueSlots.every ((s, n) => readInt32 (PROGRAM.bytes, s) === 0x5A5A0000 + n));

    const block = Core.heapBlock (values);
    check ('preview block holds value n at offset n * 4', block.length === Core.HEAP_BLOCK_SIZE && values.every ((v, n) => readInt32 (block, n * 4) === v));
    check ('a report of all values is complete', (() =>
    {
        const r = new Core.ReportCollector();

        for (let n = 0; n < Core.VALUE_COUNT; n += 2)
            r.handle ([MSG.values + n, values[n], n + 1 < Core.VALUE_COUNT ? values[n + 1] : 0]);

        r.handle ([MSG.report, Core.VALUE_COUNT, Core.valueSum (values)]);
        return r.isComplete() && Core.sameValues (r.values, values);
    })());
}

// A keyboard running the saved editor program
{
    const V1 = makeValues (11, { onBright: 80 });
    const kb = new FakeKeyboard ({ program: 'editor', baked: V1 });
    const h = harness (kb);

    let took = h.run (5000, () => h.session.ready);
    check ('takes over a running editor program', h.session.ready && h.session.keyboard === 'editor', `after ${took} ms, keyboard ${h.session.keyboard}`);
    check ('ready carries the keyboard\'s values', Core.sameValues (h.last ('ready').values, V1));
    check ('taking over writes no memory', kb.writes.length === 0, describe (kb.writes));

    const programBefore = kb.memory.slice (0, PROGRAM_SIZE);
    const liveBefore = kb.memory.slice (LIVE_START, LIVE_START + LIVE_SIZE);

    const V2 = makeValues (12, { offBright: 30, fadeColors: true });
    check ('preview accepted', h.session.preview (V2, true));
    h.run (2000, () => h.all ('previewed').length > 0);
    check ('preview confirmed', h.all ('previewed').length === 1 && h.last ('previewed').ok);
    check ('keyboard shows the preview with its lights on', Core.sameValues (kb.values, V2) && kb.heapValues && kb.lights);
    check ('preview writes only the preview block', onlyPreviewBlock (kb.writes), describe (kb.writes));

    const writesBefore = kb.writes.length;

    for (let i = 0; i < 10; ++i)
    {
        h.session.preview (makeValues (100 + i, {}), true);
        h.run (20);
    }

    h.run (3000, () => ! h.session.pendingPreview && ! h.session.applySent);
    const applies = kb.programEvents.filter (e => e.values[0] === MSG.apply).length;
    check ('quick edits end on the last values', Core.sameValues (kb.values, makeValues (109, {})));
    check ('every apply confirmed, one reply per apply', h.all ('previewed').every (e => e.ok) && h.all ('previewed').length === applies, `${applies} applies`);
    check ('quick edits write only the preview block', onlyPreviewBlock (kb.writes.slice (writesBefore)));
    check ('the program and its own memory are untouched', sameBytes (kb.memory.slice (0, PROGRAM_SIZE), programBefore) && sameBytes (kb.memory.slice (LIVE_START, LIVE_START + LIVE_SIZE), liveBefore));

    check ('revert accepted', h.session.revert());
    h.run (2000, () => h.all ('reverted').length > 0);
    check ('revert confirmed, keyboard back on its own values', h.last ('reverted').ok && Core.sameValues (kb.values, V1) && ! kb.heapValues);

    const V5 = makeValues (15, { midiChan: 5, mpeMode: true });
    check ('upload with save accepted', h.session.upload (V5, true));
    check ('preview refused during the upload', ! h.session.preview (V2, true));
    took = h.run (20000, () => h.all ('uploaded').length > 0);
    const up = h.last ('uploaded');
    check ('upload saved and verified', up && up.saved && up.verified, `after ${took} ms: ${JSON.stringify (up && { saved: up.saved, verified: up.verified })}`);
    check ('keyboard memory holds the patched program', sameBytes (kb.memory.slice (0, PROGRAM_SIZE), Core.patchProgram (PROGRAM, V5)));
    check ('the saved program is the patched program', kb.saved !== null && sameBytes (kb.saved, Core.patchProgram (PROGRAM, V5)));
    check ('keyboard runs the uploaded values, ready again', Core.sameValues (kb.values, V5) && h.session.ready && h.session.keyboard === 'editor');

    const uploadWrites = kb.writes.length;
    const V6 = makeValues (16, { midiChan: 5, mpeMode: true, onBright: 10 });
    h.session.preview (V6, false);
    h.run (2000, () => h.all ('previewed').length > applies);
    check ('preview after the upload writes only the preview block', h.last ('previewed').ok && onlyPreviewBlock (kb.writes.slice (uploadWrites)));

    kb.answering = false;
    h.run (7000);
    check ('ping timeout drops the keyboard', ! h.session.ready && h.all ('apiDisconnected').length === 1);

    const writesAtLoss = kb.writes.length;
    kb.answering = true;
    took = h.run (8000, () => h.session.ready);
    check ('reconnects and takes over again', h.session.ready, `after ${took} ms, keyboard ${h.session.keyboard}`);
    check ('reconnecting writes no memory', kb.writes.length === writesAtLoss, describe (kb.writes.slice (writesAtLoss)));
    check ('the preview left from before is reverted, values are the saved ones', Core.sameValues (h.last ('ready').values, V5) && ! kb.heapValues);

    h.session.preview (V6, true);
    h.run (2000, () => h.session.previewActive);
    const eventsBefore = kb.programEvents.length;
    h.session.stop();
    check ('stop reverts the preview, then ends API mode',
           kb.programEvents.slice (eventsBefore).some (e => e.values[0] === MSG.revert && e.apiMode) && kb.commands[kb.commands.length - 1] === Blocks.DeviceCommand.endAPIMode);
    check ('no packets out of order', kb.problems.length === 0, kb.problems.join ('; '));
}

// A keyboard left showing a preview
{
    const V1 = makeValues (21, {});
    const kb = new FakeKeyboard ({ program: 'editor', baked: V1, previewValues: makeValues (22, {}) });
    const h = harness (kb);
    h.run (5000, () => h.session.ready);
    check ('a preview left on the keyboard is reverted before taking over',
           h.session.ready && Core.sameValues (h.last ('ready').values, V1) && kb.programEvents.some (e => e.values[0] === MSG.revert) && kb.writes.length === 0);
}

// Another program
{
    const kb = new FakeKeyboard ({ program: 'other' });
    const h = harness (kb);
    h.run (6000, () => h.session.keyboard === 'other');
    check ('another program is recognised after three info requests',
           h.session.keyboard === 'other' && kb.programEvents.filter (e => e.values[0] === MSG.info).length === 3);
    check ('no preview or report with another program', ! h.session.preview (makeValues (1, {}), true) && ! h.session.readKeyboard());
    check ('nothing written to another program', kb.writes.length === 0);

    const V = makeValues (31, {});
    check ('upload without save accepted', h.session.upload (V, false));
    h.run (20000, () => h.all ('uploaded').length > 0);
    const up = h.last ('uploaded');
    check ('upload verified, nothing saved', up && up.verified && ! up.saved && kb.saved === null && h.session.ready);
}

// Another build of the editor program
{
    const V = makeValues (41, {});
    const kb = new FakeKeyboard ({ program: 'editor', baked: V, buildId: 0x12345678 });
    const h = harness (kb);
    h.run (5000, () => h.session.keyboard === 'otherBuild');
    check ('another build is recognised and not taken over', h.session.keyboard === 'otherBuild' && ! h.session.ready);
    check ('no preview with another build', ! h.session.preview (V, true));
    check ('another build\'s values can be read', h.session.readKeyboard());
    h.run (4000, () => h.all ('report').length > 0);
    check ('report from another build', h.all ('report').length === 1 && Core.sameValues (h.last ('report').values, V));
    check ('nothing written to another build', kb.writes.length === 0);
}

// A lost report message
{
    const V = makeValues (51, {});
    const kb = new FakeKeyboard ({ program: 'editor', baked: V });
    kb.dropReportMessage = 7;
    const h = harness (kb);
    h.run (8000, () => h.session.ready);
    check ('an incomplete report is asked for again', h.session.ready && kb.programEvents.filter (e => e.values[0] === MSG.report).length === 2
           && Core.sameValues (h.last ('ready').values, V));
}

console.log (`${passed} passed, ${failed} failed`);
process.exit (failed ? 1 : 0);
