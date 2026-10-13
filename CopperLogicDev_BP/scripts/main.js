import {
    CommandPermissionLevel,
    CustomCommandStatus,
    system,
    world,
} from "@minecraft/server";

const INPUT_CELL = "copperlogic:input_cell";
const OUTPUT_BLOCK = "copperlogic:output_block";
const COPPER_WIRE = "copperlogic:copper_wire";
const DECODER_BLOCK = "copperlogic:decoder_block";
const FACING_STATE = "minecraft:cardinal_direction";
const POWERED_STATE = "copperlogic:powered";
const ACTIVE_STATE = "copperlogic:active";
const EMIT_STATE = "copperlogic:emit"; // which face an Output Block emits redstone from
const GLOW_STATE = "copperlogic:glow"; // Input Cell look: "none", "redstone" or "copper"
const MAX_WIDTH = 8;
const MAX_DECODER = 32; // decoder lines are chunked into groups of 16 (a 4-bit decoder)
const MAX_LINE = 64; // safety cap on how far we scan a continuous line
const MAX_NETWORK = 4096; // safety cap on how many wires one network walk visits

// Which faces of an Input Cell an Output Block may attach to.
// v1: front only. Later: add "up", "down", "left", "right" (never "back").
const ATTACH_FACES = new Set(["front"]);

const FACINGS = ["north", "south", "east", "west"];

// Directions relative to a cell, as seen standing behind it looking where
// its arrow points. "Left" and "back" are the negatives of these.
const FORWARD_OF = {
    north: { x: 0, y: 0, z: -1 },
    south: { x: 0, y: 0, z: 1 },
    east: { x: 1, y: 0, z: 0 },
    west: { x: -1, y: 0, z: 0 },
};
const RIGHT_OF = {
    north: { x: 1, y: 0, z: 0 },
    south: { x: -1, y: 0, z: 0 },
    east: { x: 0, y: 0, z: 1 },
    west: { x: 0, y: 0, z: -1 },
};

const NEIGHBOR_OFFSETS = [
    { x: 1, y: 0, z: 0 },
    { x: -1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: -1, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: -1 },
];

// Compass offsets for the wire's four connection states.
const WIRE_SIDES = {
    n: { x: 0, y: 0, z: -1 },
    e: { x: 1, y: 0, z: 0 },
    s: { x: 0, y: 0, z: 1 },
    w: { x: -1, y: 0, z: 0 },
};


const UP = { x: 0, y: 1, z: 0 };
const DOWN = { x: 0, y: -1, z: 0 };


const WIRE_AREA = [UP, DOWN];
for (const side of Object.values(WIRE_SIDES)) {
    for (const dy of [-1, 0, 1]) WIRE_AREA.push({ x: side.x, y: dy, z: side.z });
}

const SEE_THROUGH = /glass|leaves|slab|stairs|fence|wall|pane|carpet|torch|lantern|redstone_wire|repeater|comparator|lever|button|pressure_plate|rail|ladder|vine|sign|flower|sapling|tall_grass|short_grass|snow_layer|copperlogic:copper_wire/;

// ---------------------------------------------------------------- helpers

function fmt(loc) {
    return `${loc.x}, ${loc.y}, ${loc.z}`;
}

function sameSpot(a, b) {
    return a.location.x === b.location.x && a.location.y === b.location.y && a.location.z === b.location.z;
}

/** Sends a message to one player's chat (used by the inspect command). */
function report(player, msg) {
    player.sendMessage(`§6[CopperLogic]§r ${msg}`);
}

/** The block at `offset` from `block`, or undefined if unloaded. */
function neighbor(block, offset) {
    try {
        return block.offset(offset);
    } catch {
        return undefined;
    }
}

function negate(o) {
    return { x: -o.x, y: -o.y, z: -o.z };
}

function add(a, b) {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

/**
 * Which face of a cell facing `facing` the given offset points out of:
 * "front", "back", "left", "right", "up" or "down".
 */
function faceOf(facing, offset) {
    if (offset.y === 1) return "up";
    if (offset.y === -1) return "down";
    const f = FORWARD_OF[facing];
    const r = RIGHT_OF[facing];
    if (offset.x === f.x && offset.z === f.z) return "front";
    if (offset.x === -f.x && offset.z === -f.z) return "back";
    if (offset.x === r.x && offset.z === r.z) return "right";
    return "left";
}

function facingOf(block) {
    return block.permutation.getState(FACING_STATE);
}

function toBinary(value, width) {
    return value.toString(2).padStart(width, "0");
}

// ---------------------------------------------------------------- lines and rows
// Shared by Input Cell rows (combiners) and Output Block rows (splitters).

/**
 * Walks a continuous line through `start` along the left/right axis of
 * `facing`, keeping blocks that pass `belongs`. Ordered left to right.
 */
function walkLine(start, facing, belongs) {
    const r = RIGHT_OF[facing];
    const left = negate(r);

    let leftmost = start;
    for (let i = 0; i < MAX_LINE; i++) {
        const next = neighbor(leftmost, left);
        if (!next || !belongs(next)) break;
        leftmost = next;
    }

    const line = [leftmost];
    while (line.length < MAX_LINE) {
        const next = neighbor(line[line.length - 1], r);
        if (!next || !belongs(next)) break;
        line.push(next);
    }
    return line;
}

/**
 * Chunks a line into rows of `width` counted from the RIGHT end, and
 * returns the row holding line[index]: { rowNumber, bit, row }.
 * Row 1 is rightmost; bit 0 is the rightmost block of each row. (For a
 * decoder, "bit" is the block's index: the value that lights it.)
 */
function rowAt(line, index, width = MAX_WIDTH) {
    const fromRight = line.length - 1 - index;
    const rowNumber = Math.floor(fromRight / width) + 1;
    const bit = fromRight % width;

    const rowRightEnd = line.length - 1 - (rowNumber - 1) * width;
    const rowLeftEnd = Math.max(0, rowRightEnd - width + 1);
    return { rowNumber, bit, row: line.slice(rowLeftEnd, rowRightEnd + 1) };
}

function describeRow(row) {
    return `${row.length}-bit row, MSB at ${fmt(row[0].location)}`;
}

// ---------------------------------------------------------------- input cells

/** A cell with copper wire at its back is a copper input (a splitter port). */
function isCopperInput(cell) {
    if (cell?.typeId !== INPUT_CELL) return false;
    const back = neighbor(cell, negate(FORWARD_OF[facingOf(cell)]));
    return back?.typeId === COPPER_WIRE;
}

/** A bit cell facing `facing`: an Input Cell that is not a copper input. */
function isBitCellFacing(block, facing) {
    return block?.typeId === INPUT_CELL && facingOf(block) === facing && !isCopperInput(block);
}

/**
 * Everything about a cell's place in its line. Copper inputs stand alone,
 * so their "line" is just themselves.
 */
function cellInfo(cell) {
    const facing = facingOf(cell);
    const line = isCopperInput(cell) ? [cell] : walkLine(cell, facing, (b) => isBitCellFacing(b, facing));
    const index = line.findIndex((b) => sameSpot(b, cell));
    return { facing, line, index, ...rowAt(line, index) };
}

/** Packs a row of bit cells into an integer. Row is ordered MSB first. */
function rowValue(row) {
    let value = 0;
    row.forEach((cell, i) => {
        if (cell.permutation.getState(POWERED_STATE)) {
            value |= 1 << (row.length - 1 - i);
        }
    });
    return value;
}

/** The value arriving at a copper-input cell from the wire at its back. */
function copperInputValue(cell) {
    const back = neighbor(cell, negate(FORWARD_OF[facingOf(cell)]));
    if (back?.typeId !== COPPER_WIRE) return 0;
    return networkValue(findNetwork(back));
}

/**
 * Sets an Input Cell's glow: yellow while a copper input is receiving a
 * nonzero value, red while a bit cell is powered by redstone, else none.
 */
function updateCellGlow(cell) {
    if (cell?.typeId !== INPUT_CELL) return;
    let glow = "none";
    if (isCopperInput(cell)) {
        if (copperInputValue(cell) > 0) glow = "copper";
    } else if (cell.permutation.getState(POWERED_STATE)) {
        glow = "redstone";
    }
    if (cell.permutation.getState(GLOW_STATE) !== glow) {
        cell.setPermutation(cell.permutation.withState(GLOW_STATE, glow));
    }
}

// ---------------------------------------------------------------- output blocks

/**
 * Is this block part of a line fed by copper? Used for splitter lines
 * (Output Blocks) and decoder lines (Decoder Blocks). Tries each facing:
 * walks the line of same-type blocks through it along that facing's
 * left/right axis, and looks for ones with a copper-input cell (facing the
 * same way) directly behind.
 *
 * Returns null when no copper feeds the line, otherwise
 *   { status: "conflict" }                       copper cells disagree on direction
 *   { status: "ok" | "unfed", facing, line, rowNumber, bit, row, feeders }
 * where feeders are the copper cells feeding this block's row.
 */
function copperFedLine(block, width) {
    const type = block.typeId;
    const candidates = [];
    for (const facing of FACINGS) {
        const line = walkLine(block, facing, (b) => b.typeId === type);
        const back = negate(FORWARD_OF[facing]);
        const anchors = [];
        for (const out of line) {
            const cell = neighbor(out, back);
            if (cell?.typeId === INPUT_CELL && facingOf(cell) === facing && isCopperInput(cell)) {
                anchors.push({ out, cell });
            }
        }
        if (anchors.length > 0) candidates.push({ facing, line, anchors });
    }

    if (candidates.length === 0) return null;
    if (candidates.length > 1) return { status: "conflict" };

    const { facing, line, anchors } = candidates[0];
    const index = line.findIndex((b) => sameSpot(b, block));
    const { rowNumber, bit, row } = rowAt(line, index, width);
    const feeders = anchors.filter((a) => row.some((b) => sameSpot(b, a.out))).map((a) => a.cell);

    return { status: feeders.length > 0 ? "ok" : "unfed", facing, line, rowNumber, bit, row, feeders };
}

/** Splitter info for an Output Block (null if it is a byte output). */
function splitterInfo(output) {
    return copperFedLine(output, MAX_WIDTH);
}

/** The value arriving from a list of copper-input cells, OR'd together. */
function feedersValue(feeders) {
    let value = 0;
    for (const cell of feeders) value |= copperInputValue(cell);
    return value;
}

/**
 * Reads an output as a combiner (byte) output: finds the bit cells it is
 * attached to through an allowed face, and the single row they belong to.
 *
 * Returns { status: "none" } | { status: "conflict", rows } |
 *         { status: "ok", row, value }
 */
function readByteOutput(output) {
    const rows = new Map(); // row key -> row
    for (const offset of NEIGHBOR_OFFSETS) {
        const cell = neighbor(output, offset);
        if (cell?.typeId !== INPUT_CELL || isCopperInput(cell)) continue;

        // Which face of the cell is the output touching?
        const facing = facingOf(cell);
        if (!ATTACH_FACES.has(faceOf(facing, negate(offset)))) continue;

        const { row } = cellInfo(cell);
        rows.set(`${facing}@${fmt(row[0].location)}`, row);
    }

    if (rows.size === 0) return { status: "none" };
    if (rows.size > 1) return { status: "conflict", rows: [...rows.values()] };

    const row = [...rows.values()][0];
    return { status: "ok", row, value: rowValue(row) };
}

/**
 * The full reading of an Output Block. Splitter wins: if its line has a
 * copper input behind it, it is a bit output; otherwise a byte output.
 * `active` is whether the block should be lit, and `emit` which face (if
 * any) it emits redstone from: a lit splitter bit emits out its front, the
 * way its copper input cell faces. Byte outputs never emit redstone.
 */
function readOutput(output) {
    const split = splitterInfo(output);
    if (split) {
        if (split.status !== "ok") return { mode: "bit", ...split, value: 0, active: false, emit: "none" };
        const value = feedersValue(split.feeders);
        const active = ((value >> split.bit) & 1) === 1;
        return { mode: "bit", ...split, value, active, emit: active ? split.facing : "none" };
    }
    const byte = readByteOutput(output);
    return { mode: "byte", ...byte, active: byte.status === "ok" && byte.value > 0, emit: "none" };
}

function describeOutput(r) {
    if (r.mode === "bit") {
        if (r.status === "conflict") return "SPLITTER CONFLICT: copper inputs from different directions, no output";
        if (r.status === "unfed") return `splitter bit ${r.bit} of row ${r.rowNumber}, but no copper input feeds this row`;
        return `splitter bit ${r.bit} of row ${r.rowNumber} (${describeRow(r.row)}): ${r.active ? "ON" : "off"}, value ${r.value} (${toBinary(r.value, 8)})`;
    }
    switch (r.status) {
        case "none":
            return "byte output, not attached to a row";
        case "conflict":
            return `CONFLICT: touching ${r.rows.length} different rows, no output`;
        case "ok":
            return `byte output, value ${r.value} (${toBinary(r.value, r.row.length)}) from ${describeRow(r.row)}`;
    }
}

// ---------------------------------------------------------------- decoder blocks

/**
 * Reads a Decoder Block. Its line works like a splitter line, but instead of
 * showing one bit of the value, block number N (counting from 0 on the right)
 * lights only when the value equals N. Lit decoders emit redstone forward.
 */
function readDecoder(decoder) {
    const info = copperFedLine(decoder, MAX_DECODER);
    if (!info) return { mode: "decoder", status: "none", value: 0, active: false, emit: "none" };
    if (info.status !== "ok") return { mode: "decoder", ...info, value: 0, active: false, emit: "none" };

    const value = feedersValue(info.feeders);
    const active = value === info.bit;
    return { mode: "decoder", ...info, value, active, emit: active ? info.facing : "none" };
}

function describeDecoder(r) {
    switch (r.status) {
        case "none":
            return "decoder, not fed by a copper input";
        case "conflict":
            return "DECODER CONFLICT: copper inputs from different directions, no output";
        case "unfed":
            return `decoder #${r.bit} of group ${r.rowNumber}, but no copper input feeds this group`;
        case "ok":
            return `decoder #${r.bit} of group ${r.rowNumber} (${r.row.length} wide): ${r.active ? "ON" : "off"}, value ${r.value}`;
    }
}

/** Either kind of emitting block: Output Blocks and Decoder Blocks. */
function isEmitter(block) {
    return block?.typeId === OUTPUT_BLOCK || block?.typeId === DECODER_BLOCK;
}

function readEmitter(block) {
    return block.typeId === DECODER_BLOCK ? readDecoder(block) : readOutput(block);
}

function describeEmitter(r) {
    return r.mode === "decoder" ? describeDecoder(r) : describeOutput(r);
}

const lastReading = new Map(); // location -> last reading, to spot real changes

/** Recomputes an Output Block or Decoder Block and updates its states. */
function refreshOutput(output) {
    if (!isEmitter(output)) return;

    const r = readEmitter(output);

    let perm = output.permutation;
    let changed = false;
    if (perm.getState(ACTIVE_STATE) !== r.active) {
        perm = perm.withState(ACTIVE_STATE, r.active);
        changed = true;
    }
    if (perm.getState(EMIT_STATE) !== r.emit) {
        perm = perm.withState(EMIT_STATE, r.emit);
        changed = true;
    }
    if (changed) output.setPermutation(perm);

    // Only when the reading actually changed: push it down the wire.
    const key = fmt(output.location);
    const reading = describeEmitter(r);
    if (lastReading.get(key) !== reading) {
        lastReading.set(key, reading);
        refreshNetworksAround(output);
    }
}

/**
 * Refreshes this output (or decoder) and every block of the same type in a
 * straight line with it along either horizontal axis, since splitter and
 * decoder lines can run either way.
 */
function refreshOutputsNear(output, seen = new Set()) {
    if (!isEmitter(output)) return seen;
    const type = output.typeId;
    for (const axis of [{ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }]) {
        for (const step of [axis, negate(axis)]) {
            let current = output;
            for (let i = 0; i < MAX_LINE && current?.typeId === type; i++) {
                const key = fmt(current.location);
                if (!seen.has(key)) {
                    seen.add(key);
                    refreshOutput(current);
                }
                current = neighbor(current, step);
            }
        }
    }
    return seen;
}

/** Output Blocks attached to this cell through an allowed face. */
function outputsAttachedTo(cell, facing) {
    const outputs = [];
    for (const offset of NEIGHBOR_OFFSETS) {
        if (!ATTACH_FACES.has(faceOf(facing, offset))) continue;
        const block = neighbor(cell, offset);
        if (block?.typeId === OUTPUT_BLOCK) outputs.push(block);
    }
    return outputs;
}

/**
 * Refreshes every output attached anywhere along this cell's line (and the
 * output lines they sit in). Adding or removing a cell can regroup every
 * row in the line, so we refresh them all.
 */
function refreshLine(cell) {
    if (cell?.typeId !== INPUT_CELL) return;
    const { facing, line } = cellInfo(cell);
    const seen = new Set();
    for (const c of line) {
        for (const out of outputsAttachedTo(c, facing)) refreshOutputsNear(out, seen);
    }
}

/**
 * Something about this cell changed (placed, broken, or it switched between
 * bit and copper input). Refresh its own line, the lines on either side of
 * it, and whatever is in front of it.
 */
function refreshCellContext(cell, facing) {
    updateCellGlow(cell);
    refreshLine(cell);
    for (const dir of [RIGHT_OF[facing], negate(RIGHT_OF[facing])]) {
        const side = neighbor(cell, dir);
        if (isBitCellFacing(side, facing)) refreshLine(side);
    }
    refreshOutputsNear(neighbor(cell, FORWARD_OF[facing]));
}

// ---------------------------------------------------------------- wire shape

/** Does a wire visually connect to the block at `offset` from it? */
function wireConnectsTo(wire, offset) {
    const block = neighbor(wire, offset);
    if (block?.typeId === COPPER_WIRE || block?.typeId === OUTPUT_BLOCK) return true;
    // Input Cells only accept copper at their back.
    if (block?.typeId === INPUT_CELL) return faceOf(facingOf(block), negate(offset)) === "back";
    return false;
}

/** Does this block cut a wire climbing past it? (Approximates vanilla's solid-block rule.) */
function cutsWire(block) {
    if (block === undefined || block.isAir || block.isLiquid) return false;
    return !SEE_THROUGH.test(block.typeId);
}

/**
 * Everything a wire links to, like vanilla dust: flat neighbors, wire one
 * block up a wall (unless a solid block sits on top of this wire), and wire
 * one block down a ledge (unless a solid block is beside this wire).
 *
 * Returns { sides, climbs, wires }: per-side arm visibility, per-side climb
 * pieces, and the linked wire blocks (for walking networks).
 */
function wireLinks(wire) {
    const sides = {};
    const climbs = {};
    const wires = [];
    const roofOpen = !cutsWire(neighbor(wire, UP));

    for (const [side, offset] of Object.entries(WIRE_SIDES)) {
        const beside = neighbor(wire, offset);
        if (beside?.typeId === COPPER_WIRE) wires.push(beside);

        const above = neighbor(wire, add(offset, UP));
        const up = roofOpen && above?.typeId === COPPER_WIRE;
        if (up) wires.push(above);

        const below = neighbor(wire, add(offset, DOWN));
        const down = !cutsWire(beside) && below?.typeId === COPPER_WIRE;
        if (down) wires.push(below);

        sides[side] = wireConnectsTo(wire, offset) || up || down;
        climbs[side] = up;
    }
    return { sides, climbs, wires };
}

/** Sets a wire's arm and climb states from its current surroundings. */
function updateWireShape(wire) {
    if (wire?.typeId !== COPPER_WIRE) return;

    const { sides, climbs } = wireLinks(wire);
    let perm = wire.permutation;
    let changed = false;
    for (const side of Object.keys(WIRE_SIDES)) {
        for (const [state, value] of [[`copperlogic:${side}`, sides[side]], [`copperlogic:${side}_up`, climbs[side]]]) {
            if (perm.getState(state) !== value) {
                perm = perm.withState(state, value);
                changed = true;
            }
        }
    }
    if (changed) wire.setPermutation(perm);
}

/** Re-shapes every wire whose shape could depend on this position. */
function updateWiresAround(block) {
    for (const offset of WIRE_AREA) {
        updateWireShape(neighbor(block, offset));
    }
}

/**
 * Any block was placed or broken here: re-shape nearby wires and refresh
 * their networks. Also checks the spot above, since breaking a block can
 * pop off the wire sitting on it.
 */
function wireAreaChanged(block) {
    const above = neighbor(block, UP);
    updateWiresAround(block);
    if (above) updateWiresAround(above);

    const done = new Set();
    refreshNetworksAround(block, done);
    if (above) refreshNetworksAround(above, done);
}

/** Input Cells whose back faces this position (so wire here feeds them). */
function cellsBackedBy(block) {
    const cells = [];
    for (const offset of Object.values(WIRE_SIDES)) {
        const cell = neighbor(block, offset);
        if (cell?.typeId === INPUT_CELL && faceOf(facingOf(cell), negate(offset)) === "back") {
            cells.push(cell);
        }
    }
    return cells;
}

// ---------------------------------------------------------------- wire networks

/**
 * Walks every wire connected to `start` (breadth-first, four-way) and
 * collects what touches it: byte outputs feeding it (sources) and copper
 * input cells it feeds (sinks).
 */
function findNetwork(start) {
    const wires = [];
    const sources = new Map(); // location -> output block
    const sinks = new Map(); // location -> copper input cell
    const seen = new Set([fmt(start.location)]);
    const queue = [start];

    while (queue.length > 0 && wires.length < MAX_NETWORK) {
        const wire = queue.shift();
        wires.push(wire);

        // Outputs and copper inputs only connect on the same level.
        for (const offset of Object.values(WIRE_SIDES)) {
            const next = neighbor(wire, offset);
            if (next === undefined) continue;
            const key = fmt(next.location);

            if (next.typeId === OUTPUT_BLOCK) {
                sources.set(key, next);
            } else if (next.typeId === INPUT_CELL && faceOf(facingOf(next), negate(offset)) === "back") {
                sinks.set(key, next);
            }
        }

        // Wire links flat, up walls and down ledges.
        for (const next of wireLinks(wire).wires) {
            const key = fmt(next.location);
            if (seen.has(key)) continue;
            seen.add(key);
            queue.push(next);
        }
    }
    return {
        wires,
        sources: [...sources.values()],
        sinks: [...sinks.values()],
        truncated: queue.length > 0,
    };
}

/** A network's value: every byte output touching it, OR'd together. */
function networkValue(network) {
    let value = 0;
    for (const source of network.sources) {
        if (splitterInfo(source)) continue; // bit outputs don't drive copper
        const r = readByteOutput(source);
        if (r.status === "ok") value |= r.value;
    }
    return value;
}

/**
 * Recomputes the network containing `start`, lights or darkens its wires,
 * and refreshes any splitters it feeds. Returns the wire locations visited.
 */
function refreshNetwork(start) {
    const network = findNetwork(start);
    const value = networkValue(network);
    const powered = value > 0;

    for (const wire of network.wires) {
        if (wire.permutation.getState(POWERED_STATE) !== powered) {
            wire.setPermutation(wire.permutation.withState(POWERED_STATE, powered));
        }
    }

    for (const cell of network.sinks) {
        updateCellGlow(cell);
        refreshOutputsNear(neighbor(cell, FORWARD_OF[facingOf(cell)]));
    }
    return new Set(network.wires.map((w) => fmt(w.location)));
}

/**
 * Refreshes every distinct network touching this position. Breaking a wire
 * can split one network into up to four, so each neighbor is checked unless
 * an earlier walk already covered it.
 */
function refreshNetworksAround(block, done = new Set()) {
    for (const offset of WIRE_AREA) {
        const next = neighbor(block, offset);
        if (next?.typeId !== COPPER_WIRE || done.has(fmt(next.location))) continue;
        for (const key of refreshNetwork(next)) done.add(key);
    }
}

// ---------------------------------------------------------------- events

world.afterEvents.playerPlaceBlock.subscribe(({ block }) => {
    if (block.typeId === COPPER_WIRE) {
        updateWireShape(block);
        updateWiresAround(block);
        refreshNetwork(block);
        for (const cell of cellsBackedBy(block)) refreshCellContext(cell, facingOf(cell));
        return;
    }

    if (block.typeId === OUTPUT_BLOCK) {
        refreshOutputsNear(block);
        updateWiresAround(block);
        return;
    }

    if (block.typeId === DECODER_BLOCK) {
        refreshOutputsNear(block);
        return;
    }

    if (block.typeId !== INPUT_CELL) return;
    const facing = facingOf(block);
    updateWiresAround(block);
    refreshCellContext(block, facing);
    refreshNetworksAround(block);
});

world.afterEvents.playerBreakBlock.subscribe(({ block, brokenBlockPermutation }) => {
    const brokenType = brokenBlockPermutation.type.id;

    if (brokenType === COPPER_WIRE) {
        updateWiresAround(block);
        refreshNetworksAround(block);
        // Cells that had this wire at their back are now bit cells again.
        for (const cell of cellsBackedBy(block)) refreshCellContext(cell, facingOf(cell));
        return;
    }

    if (brokenType === OUTPUT_BLOCK || brokenType === DECODER_BLOCK) {
        lastReading.delete(fmt(block.location)); // a new output here starts fresh
        updateWiresAround(block);
        refreshNetworksAround(block);
        for (const offset of Object.values(WIRE_SIDES)) refreshOutputsNear(neighbor(block, offset));
        return;
    }

    if (brokenType !== INPUT_CELL) return;

    // `block` is now air, but it still knows its location, so we can look at
    // what used to be its neighbors.
    const facing = brokenBlockPermutation.getState(FACING_STATE);
    updateWiresAround(block);
    refreshCellContext(block, facing);
    refreshNetworksAround(block);
});

// Any block placed or broken (ours or vanilla) can connect, cut or pop off
// a wire. Wait one tick so the game has finished removing popped wires.
function afterAnyBlockChange(block) {
    const { dimension, location } = block;
    system.run(() => {
        const here = dimension.getBlock(location);
        if (here) wireAreaChanged(here);
    });
}
world.afterEvents.playerPlaceBlock.subscribe(({ block }) => afterAnyBlockChange(block));
world.afterEvents.playerBreakBlock.subscribe(({ block }) => afterAnyBlockChange(block));

// ---- Bit input: track whether each cell is receiving redstone ----

const BitInputComponent = {
    onRedstoneUpdate({ block, powerLevel }) {
        const powered = powerLevel > 0;
        if (block.permutation.getState(POWERED_STATE) === powered) return; // no change

        block.setPermutation(block.permutation.withState(POWERED_STATE, powered));
        updateCellGlow(block);
        if (!isCopperInput(block)) refreshLine(block); // copper inputs ignore redstone
    },
};
// ---- Debug inspector: look at a block and run /copperlogic:inspect ----

function inspectCell(block, player) {
    if (isCopperInput(block)) {
        const value = copperInputValue(block);
        report(player, `INSPECT cell ${fmt(block.location)} facing ${facingOf(block)}`);
        report(player, `  copper input (splitter port), receiving ${value} (${toBinary(value, 8)})`);
        return;
    }

    const { facing, line, index, rowNumber, bit, row } = cellInfo(block);

    // Row sizes shown left to right, e.g. [2][8][8] for an 18-cell line.
    // Rows are numbered from the right, so the rightmost bracket is row 1.
    const totalRows = Math.ceil(line.length / MAX_WIDTH);
    const leftRowSize = line.length - (totalRows - 1) * MAX_WIDTH;
    const rowMap = [];
    for (let r = totalRows; r >= 1; r--) {
        const size = r === totalRows ? leftRowSize : MAX_WIDTH;
        rowMap.push(r === rowNumber ? `[${size}*]` : `[${size}]`);
    }

    report(player, `INSPECT cell ${fmt(block.location)} facing ${facing}`);
    report(player, `  line: ${line.length} cells, this is #${line.length - index} from right, rows ${rowMap.join("")}`);
    report(player, `  row ${rowNumber}: ${describeRow(row)}, this cell is bit ${bit}`);
    report(player, `  powered: ${block.permutation.getState(POWERED_STATE)} (power level ${block.getRedstonePower() ?? "n/a"})`);
    report(player, `  row value: ${toBinary(rowValue(row), row.length)} = ${rowValue(row)}`);
}

function inspectWire(block, player) {
    const sides = Object.keys(WIRE_SIDES).filter((side) => block.permutation.getState(`copperlogic:${side}`));
    const network = findNetwork(block);
    const value = networkValue(network);

    report(player, `INSPECT wire ${fmt(block.location)}`);
    report(player, `  connected: ${sides.length ? sides.join(" ") : "none"}`);
    report(player, `  network: ${network.wires.length} wires, ${network.sources.length} source(s), ${network.sinks.length} splitter input(s)${network.truncated ? " (truncated)" : ""}`);
    report(player, `  value: ${value} (${toBinary(value, 8)}), powered: ${block.permutation.getState(POWERED_STATE)}`);
}

function inspectDecoder(block, player) {
    report(player, `INSPECT decoder ${fmt(block.location)}`);
    report(player, `  ${describeDecoder(readDecoder(block))}`);
    report(player, `  active: ${block.permutation.getState(ACTIVE_STATE)}, emitting redstone: ${block.permutation.getState(EMIT_STATE)}`);
}

function inspectOutput(block, player) {
    report(player, `INSPECT output ${fmt(block.location)}`);
    report(player, `  ${describeOutput(readOutput(block))}`);
    report(player, `  active: ${block.permutation.getState(ACTIVE_STATE)}, emitting redstone: ${block.permutation.getState(EMIT_STATE)}`);
}

// ---- Startup: register components and commands ----

/**
 * Registers /copperlogic:<name>. The handler runs next tick (commands run in a
 * restricted context) and receives the player and the block they look at.
 */
function registerDebugCommand(registry, name, description, handler) {
    registry.registerCommand(
        {
            name: `copperlogic:${name}`,
            description,
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const player = origin.sourceEntity;
            if (player?.typeId !== "minecraft:player") {
                return { status: CustomCommandStatus.Failure, message: "Run this as a player." };
            }
            system.run(() => {
                const hit = player.getBlockFromViewDirection({ maxDistance: 10 });
                handler(player, hit?.block);
            });
            return { status: CustomCommandStatus.Success };
        }
    );
}

system.beforeEvents.startup.subscribe(({ blockComponentRegistry, customCommandRegistry }) => {
    blockComponentRegistry.registerCustomComponent("copperlogic:bit_input", BitInputComponent);

    registerDebugCommand(customCommandRegistry, "inspect", "Inspect the Copper Logic block you are looking at", (player, block) => {
        if (block?.typeId === INPUT_CELL) inspectCell(block, player);
        else if (block?.typeId === OUTPUT_BLOCK) inspectOutput(block, player);
        else if (block?.typeId === COPPER_WIRE) inspectWire(block, player);
        else if (block?.typeId === DECODER_BLOCK) inspectDecoder(block, player);
        else report(player, "not looking at a Copper Logic block");
    });
});