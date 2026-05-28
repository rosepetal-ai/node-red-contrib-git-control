// Pure tests for mergeFlowsThreeWay. No git, no fs.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fm = require('../lib/flow-model');

const clone = (v) => JSON.parse(JSON.stringify(v));
const tab = (id, label) => ({ id, type: 'tab', label });
const n = (id, z, extra = {}) => ({ id, type: 'function', z, func: 'return msg;', ...extra });

function ids(arr) { return arr.map(x => x.id); }
function byId(arr, id) { return arr.find(x => x.id === id); }

test('both sides add different tabs: both kept, no conflict', () => {
    const base = [tab('t0', 'base')];
    const ours = [...clone(base), tab('tA', 'mine'), n('a1', 'tA')];
    const theirs = [...clone(base), tab('tB', 'theirs'), n('b1', 'tB')];

    const r = fm.mergeFlowsThreeWay(base, ours, theirs);
    assert.deepStrictEqual(r.conflicts, []);
    assert.ok(byId(r.merged, 'tA'), 'tA present');
    assert.ok(byId(r.merged, 'tB'), 'tB present');
});

test('both sides add the same tab with identical content: kept once, no conflict', () => {
    const base = [];
    const sameTab = tab('t1', 'shared');
    const sameNode = n('n1', 't1');
    const ours = [clone(sameTab), clone(sameNode)];
    const theirs = [clone(sameTab), clone(sameNode)];

    const r = fm.mergeFlowsThreeWay(base, ours, theirs);
    assert.deepStrictEqual(r.conflicts, []);
    assert.deepStrictEqual(ids(r.merged), ['t1', 'n1']);
});

test('each side modifies a different tab: both applied, no conflict', () => {
    const base = [tab('tA', 'A'), n('a1', 'tA'), tab('tB', 'B'), n('b1', 'tB')];
    const ours = clone(base); ours[1].name = 'changed-on-ours';
    const theirs = clone(base); theirs[3].name = 'changed-on-theirs';

    const r = fm.mergeFlowsThreeWay(base, ours, theirs);
    assert.deepStrictEqual(r.conflicts, []);
    assert.strictEqual(byId(r.merged, 'a1').name, 'changed-on-ours');
    assert.strictEqual(byId(r.merged, 'b1').name, 'changed-on-theirs');
});

test('both sides modify the same node identically: auto-merged, no conflict', () => {
    const base = [tab('t1', 'A'), n('n1', 't1', { name: 'before' })];
    const ours = clone(base); ours[1].name = 'after';
    const theirs = clone(base); theirs[1].name = 'after';

    const r = fm.mergeFlowsThreeWay(base, ours, theirs);
    assert.deepStrictEqual(r.conflicts, []);
    assert.strictEqual(byId(r.merged, 'n1').name, 'after');
});

test('both sides modify the same node differently: one per-node conflict', () => {
    const base = [tab('t1', 'A'), n('n1', 't1', { name: 'before' })];
    const ours = clone(base); ours[1].name = 'ours';
    const theirs = clone(base); theirs[1].name = 'theirs';

    const r = fm.mergeFlowsThreeWay(base, ours, theirs);
    assert.strictEqual(r.conflicts.length, 1);
    const c = r.conflicts[0];
    assert.strictEqual(c.unitId, 't1');
    assert.strictEqual(c.perNode.length, 1);
    assert.strictEqual(c.perNode[0].id, 'n1');
    assert.strictEqual(c.perNode[0].ours.name, 'ours');
    assert.strictEqual(c.perNode[0].theirs.name, 'theirs');
});

test('one side modifies, the other deletes: modify-vs-delete per-node conflict', () => {
    const base = [tab('t1', 'A'), n('n1', 't1', { name: 'before' })];
    const ours = clone(base); ours[1].name = 'after';
    const theirs = [tab('t1', 'A')]; // n1 deleted

    const r = fm.mergeFlowsThreeWay(base, ours, theirs);
    assert.strictEqual(r.conflicts.length, 1);
    const cn = r.conflicts[0].perNode[0];
    assert.strictEqual(cn.id, 'n1');
    assert.ok(cn.ours, 'ours has the modified node');
    assert.strictEqual(cn.theirs, null, 'theirs side is null (deleted)');
});

test('node moved between tabs on one side: surfaces as delete-vs-modify in the source tab', () => {
    // Moving a node = changing its `z`. groupByUnit places nodes by `z`, so a
    // move "looks like" delete-from-tA + add-to-tB to the merger. When the
    // other side modified the node in place at tA, the tA unit shows a
    // delete-vs-modify conflict (ours=null, theirs=modified), and tB
    // separately auto-applies ours' added copy. Two arrivals of the same id —
    // the resolver UI shows both rows so the user can pick coherently.
    const base = [tab('tA', 'A'), tab('tB', 'B'), n('n1', 'tA')];
    const ours = clone(base); ours[2].z = 'tB';
    const theirs = clone(base); theirs[2].name = 'tweaked-in-place';

    const r = fm.mergeFlowsThreeWay(base, ours, theirs);
    const inTA = r.conflicts.find(c => c.unitId === 'tA');
    assert.ok(inTA, 'tA has a conflict row');
    const row = inTA.perNode.find(p => p.id === 'n1');
    assert.ok(row, 'tA conflict references n1');
    assert.strictEqual(row.ours, null, 'on the tA side ours has no n1 (it left)');
    assert.strictEqual(row.theirs.name, 'tweaked-in-place');
    // tB doesn't conflict — n1 was added there by ours, auto-merged.
    assert.ok(!r.conflicts.find(c => c.unitId === 'tB'), 'tB has no conflict');
});

test('both modify the subflow definition: per-node conflict on the subflow node', () => {
    const base = [
        { id: 's1', type: 'subflow', name: 'Mine' },
        n('n1', 's1')
    ];
    const ours = clone(base); ours[0].name = 'Renamed-A';
    const theirs = clone(base); theirs[0].name = 'Renamed-B';

    const r = fm.mergeFlowsThreeWay(base, ours, theirs);
    assert.strictEqual(r.conflicts.length, 1);
    assert.strictEqual(r.conflicts[0].unitId, 's1');
    assert.strictEqual(r.conflicts[0].perNode.length, 1);
    assert.strictEqual(r.conflicts[0].perNode[0].id, 's1');
});

test('key-order-only differences between sides do not register as conflicts', () => {
    const base = [tab('t1', 'A'), { id: 'n1', type: 'function', z: 't1', name: 'x', func: 'return msg;' }];
    // ours and theirs reorder keys but the value is the same; canonical() should normalize.
    const ours = [tab('t1', 'A'), { name: 'x', func: 'return msg;', id: 'n1', type: 'function', z: 't1' }];
    const theirs = [tab('t1', 'A'), { z: 't1', func: 'return msg;', name: 'x', type: 'function', id: 'n1' }];

    const r = fm.mergeFlowsThreeWay(base, ours, theirs);
    assert.deepStrictEqual(r.conflicts, []);
});

test('emit order: merged keeps ours order, then appends theirs-only additions', () => {
    const base = [tab('t1', 'A')];
    const ours = [tab('t1', 'A'), n('o1', 't1'), n('o2', 't1')];
    const theirs = [tab('t1', 'A'), n('o1', 't1'), n('x1', 't1'), n('o2', 't1')];

    const r = fm.mergeFlowsThreeWay(base, ours, theirs);
    assert.deepStrictEqual(r.conflicts, []);
    // ours order preserved (o1 then o2), x1 appended after — not interleaved.
    assert.deepStrictEqual(ids(r.merged), ['t1', 'o1', 'o2', 'x1']);
});

test('whole-unit deletion: deleted by both drops the unit; deleted+modified surfaces a structural conflict', () => {
    // deleted by both:
    let base = [tab('t1', 'A'), n('n1', 't1'), tab('t2', 'B'), n('n2', 't2')];
    let ours = [tab('t1', 'A'), n('n1', 't1')];
    let theirs = [tab('t1', 'A'), n('n1', 't1')];

    let r = fm.mergeFlowsThreeWay(base, ours, theirs);
    assert.deepStrictEqual(r.conflicts, []);
    assert.strictEqual(byId(r.merged, 't2'), undefined);

    // deleted by ours, modified by theirs -> structural conflict
    ours = [tab('t1', 'A'), n('n1', 't1')];
    theirs = clone(base); byId(theirs, 't2').label = 'B-renamed';

    r = fm.mergeFlowsThreeWay(base, ours, theirs);
    const struct = r.conflicts.find(c => c.unitId === 't2');
    assert.ok(struct, 'unit-level conflict surfaced for t2');
    assert.strictEqual(struct.unitConflict, 'modify-delete');
});
