const test = require('node:test');
const assert = require('node:assert');
const fm = require('../lib/flow-model');

// A representative flows.json: one flow (with an inject, a function that
// references an mqtt-broker config, and a subflow instance), one subflow
// definition, and two global config nodes.
function sampleFlows() {
    return [
        { id: 't1', type: 'tab', label: 'Main' },
        { id: 'n1', type: 'inject', z: 't1', name: 'tick' },
        { id: 'n2', type: 'mqtt out', z: 't1', broker: 'c1' },
        { id: 'n4', type: 'subflow:s1', z: 't1' },
        { id: 's1', type: 'subflow', name: 'MySub' },
        { id: 'n3', type: 'function', z: 's1', func: 'return msg;' },
        { id: 'c1', type: 'mqtt-broker', name: 'broker' },
        { id: 'global-config', type: 'global-config', env: [] }
    ];
}

const clone = (v) => JSON.parse(JSON.stringify(v));

test('parseFlows handles empty, invalid, and non-array input', () => {
    assert.deepStrictEqual(fm.parseFlows(''), { nodes: [], error: null });
    assert.strictEqual(fm.parseFlows('{not json').nodes, null);
    assert.match(fm.parseFlows('{not json').error, /Invalid JSON/);
    assert.strictEqual(fm.parseFlows('{"a":1}').nodes, null);
    assert.match(fm.parseFlows('{"a":1}').error, /not a JSON array/);
});

test('groupByUnit splits into flow, subflow, and one config unit', () => {
    const units = fm.groupByUnit(sampleFlows());
    assert.strictEqual(units.length, 3);

    const flow = units.find(u => u.id === 't1');
    assert.strictEqual(flow.kind, 'flow');
    assert.strictEqual(flow.label, 'Main');
    assert.deepStrictEqual(flow.nodes.map(n => n.id).sort(), ['n1', 'n2', 'n4', 't1']);

    const sub = units.find(u => u.id === 's1');
    assert.strictEqual(sub.kind, 'subflow');
    assert.strictEqual(sub.label, 'MySub');
    assert.deepStrictEqual(sub.nodes.map(n => n.id).sort(), ['n3', 's1']);

    const cfg = units.find(u => u.kind === 'config');
    assert.strictEqual(cfg.id, fm.CONFIG_UNIT_ID);
    assert.strictEqual(cfg.label, 'Configuration');
    assert.deepStrictEqual(cfg.nodes.map(n => n.id).sort(), ['c1', 'global-config']);
});

test('groupByUnit order is flows, then subflows, then config', () => {
    const kinds = fm.groupByUnit(sampleFlows()).map(u => u.kind);
    assert.deepStrictEqual(kinds, ['flow', 'subflow', 'config']);
});

test('groupByUnit resolves z even when node precedes its tab', () => {
    const units = fm.groupByUnit([
        { id: 'a', type: 'inject', z: 't1' },
        { id: 't1', type: 'tab', label: 'Late' }
    ]);
    const flow = units.find(u => u.id === 't1');
    assert.strictEqual(flow.kind, 'flow');
    assert.deepStrictEqual(flow.nodes.map(n => n.id).sort(), ['a', 't1']);
});

test('diffUnits flags a modified node in its unit only', () => {
    const base = sampleFlows();
    const head = clone(base);
    head.find(n => n.id === 'n2').broker = 'c2'; // change a field

    const diff = fm.diffUnits(base, head);
    const flow = diff.find(u => u.id === 't1');
    assert.strictEqual(flow.status, 'modified');
    assert.strictEqual(flow.counts.modified, 1);
    assert.strictEqual(flow.modified[0].id, 'n2');

    assert.strictEqual(diff.find(u => u.id === 's1').status, 'unchanged');
    assert.strictEqual(diff.find(u => u.kind === 'config').status, 'unchanged');
});

test('diffUnits ignores key reordering (canonical compare)', () => {
    const base = [{ id: 't1', type: 'tab', label: 'Main' },
                  { id: 'n1', type: 'inject', z: 't1', a: 1, b: 2 }];
    const head = [{ id: 't1', type: 'tab', label: 'Main' },
                  { id: 'n1', type: 'inject', z: 't1', b: 2, a: 1 }];
    assert.strictEqual(fm.diffUnits(base, head).find(u => u.id === 't1').status, 'unchanged');
});

test('diffUnits reports added and removed units', () => {
    const base = sampleFlows();
    const head = clone(base).concat([{ id: 't2', type: 'tab', label: 'New' }]);
    const added = fm.diffUnits(base, head).find(u => u.id === 't2');
    assert.strictEqual(added.status, 'added');

    const removed = fm.diffUnits(head, base).find(u => u.id === 't2');
    assert.strictEqual(removed.status, 'removed');
});

test('spliceUnit reverts one flow and leaves others untouched', () => {
    const base = sampleFlows();
    const current = clone(base);
    current.find(n => n.id === 'n2').broker = 'c2';     // change inside flow t1
    current.find(n => n.id === 'n3').func = 'changed';  // change inside subflow s1

    const reverted = fm.spliceUnit(current, base, 't1');

    // flow t1 is back to base
    assert.strictEqual(reverted.find(n => n.id === 'n2').broker, 'c1');
    // subflow change is preserved (not part of unit t1)
    assert.strictEqual(reverted.find(n => n.id === 'n3').func, 'changed');
    // nothing lost
    assert.strictEqual(reverted.length, current.length);
});

test('spliceUnit reverting to a state without the unit deletes it', () => {
    const base = sampleFlows();
    const current = clone(base).concat([
        { id: 't2', type: 'tab', label: 'Extra' },
        { id: 'x1', type: 'inject', z: 't2' }
    ]);
    const reverted = fm.spliceUnit(current, base, 't2');
    assert.strictEqual(reverted.find(n => n.id === 't2'), undefined);
    assert.strictEqual(reverted.find(n => n.id === 'x1'), undefined);
    assert.strictEqual(reverted.length, base.length);
});

test('spliceUnit reverting a deleted unit re-adds it', () => {
    const base = sampleFlows();
    const current = base.filter(n => n.z !== 't1' && n.id !== 't1'); // drop flow t1
    const reverted = fm.spliceUnit(current, base, 't1');
    assert.ok(reverted.find(n => n.id === 't1'));
    assert.deepStrictEqual(
        fm.groupByUnit(reverted).find(u => u.id === 't1').nodes.map(n => n.id).sort(),
        ['n1', 'n2', 'n4', 't1']
    );
});

test('revertNodes resets only the named modified node', () => {
    const base = sampleFlows();
    const current = clone(base);
    current.find(n => n.id === 'n1').name = 'CHANGED';
    current.find(n => n.id === 'n2').name = 'ALSO-CHANGED';

    const out = fm.revertNodes(current, base, ['n1']);
    assert.strictEqual(out.find(n => n.id === 'n1').name, 'tick');        // reset
    assert.strictEqual(out.find(n => n.id === 'n2').name, 'ALSO-CHANGED'); // untouched
    assert.strictEqual(out.length, current.length);
});

test('revertNodes removes a node added in the working tree', () => {
    const base = sampleFlows();
    const current = clone(base).concat([{ id: 'nx', type: 'debug', z: 't1' }]);
    const out = fm.revertNodes(current, base, ['nx']);
    assert.strictEqual(out.find(n => n.id === 'nx'), undefined);
    assert.strictEqual(out.length, base.length);
});

test('revertNodes re-adds a node deleted from the working tree', () => {
    const base = sampleFlows();
    const current = clone(base).filter(n => n.id !== 'n1');
    const out = fm.revertNodes(current, base, ['n1']);
    assert.ok(out.find(n => n.id === 'n1'));
});

test('findUnitDependencies detects config and subflow references', () => {
    const flows = sampleFlows();
    const flowNodes = fm.groupByUnit(flows).find(u => u.id === 't1').nodes;
    const deps = fm.findUnitDependencies(flowNodes, flows);

    assert.deepStrictEqual(deps.config.map(c => c.id), ['c1']);
    assert.strictEqual(deps.config[0].type, 'mqtt-broker');
    assert.deepStrictEqual(deps.subflows.map(s => s.id), ['s1']);
    assert.strictEqual(deps.subflows[0].label, 'MySub');
});
