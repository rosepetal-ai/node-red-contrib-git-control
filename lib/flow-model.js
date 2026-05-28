/**
 * Git Control - flow model (pure)
 *
 * Node-RED keeps all flows in a single flows.json: a flat array of node
 * objects, each carrying a `z` = the id of the tab/subflow it lives on. This
 * module groups that flat array into logical UNITS - one per flow tab, one per
 * subflow, and a single "config" unit for global config nodes - and provides
 * diffing and single-unit revert (splice) on top of that grouping.
 *
 * Pure: no git, no fs, no Node-RED. Works only on parsed arrays so it can be
 * unit-tested in isolation. Serialization and disk I/O live in the caller.
 */

const CONFIG_UNIT_ID = '__config__';

// Keys that describe a node's identity/placement rather than its configuration;
// skipped when scanning a node for references to config nodes.
const STRUCTURAL_KEYS = new Set(['id', 'type', 'z', 'g', 'x', 'y', 'wires']);

function parseFlows(text) {
    if (typeof text !== 'string' || text.trim() === '') {
        return { nodes: [], error: null };
    }
    try {
        const data = JSON.parse(text);
        if (!Array.isArray(data)) {
            return { nodes: null, error: 'Flow file is not a JSON array' };
        }
        return { nodes: data, error: null };
    } catch (err) {
        return { nodes: null, error: `Invalid JSON: ${err.message}` };
    }
}

function containerKind(node) {
    return node && node.type === 'subflow' ? 'subflow' : 'flow';
}

function unitLabel(kind, id, anchor) {
    if (kind === 'config') return 'Configuration';
    if (anchor) {
        const name = kind === 'subflow' ? anchor.name : anchor.label;
        if (name && String(name).trim()) return String(name).trim();
    }
    const shortId = typeof id === 'string' ? id.slice(0, 8) : String(id);
    return `${kind === 'subflow' ? 'Subflow' : 'Flow'} ${shortId}`;
}

// Group a flat node array into logical units, in a stable order: flows (by
// first appearance), then subflows, then the single config unit.
function groupByUnit(nodes) {
    const list = Array.isArray(nodes) ? nodes : [];

    // Pass 1: index containers so a node's `z` resolves to a kind even when the
    // node appears before its tab/subflow in the array.
    const containers = new Map();
    for (const node of list) {
        if (node && (node.type === 'tab' || node.type === 'subflow')) {
            containers.set(node.id, node);
        }
    }

    const units = new Map();
    const ensure = (id, kind, anchor) => {
        if (!units.has(id)) {
            units.set(id, { kind, id, label: unitLabel(kind, id, anchor), nodes: [] });
        }
        return units.get(id);
    };

    // Pass 2: assign each node to its unit.
    for (const node of list) {
        if (!node || typeof node !== 'object') continue;
        if (node.type === 'tab') {
            ensure(node.id, 'flow', node).nodes.push(node);
        } else if (node.type === 'subflow') {
            ensure(node.id, 'subflow', node).nodes.push(node);
        } else if (typeof node.z === 'string' && node.z !== '') {
            const anchor = containers.get(node.z) || null;
            ensure(node.z, containerKind(anchor), anchor).nodes.push(node);
        } else {
            ensure(CONFIG_UNIT_ID, 'config', null).nodes.push(node);
        }
    }

    const order = { flow: 0, subflow: 1, config: 2 };
    return [...units.values()].sort((a, b) => order[a.kind] - order[b.kind]);
}

// Stable stringify (object keys sorted recursively, array order preserved) so
// two nodes that differ only in key order are not reported as changed.
function canonical(value) {
    if (Array.isArray(value)) {
        return '[' + value.map(canonical).join(',') + ']';
    }
    if (value && typeof value === 'object') {
        return '{' + Object.keys(value).sort()
            .map(k => JSON.stringify(k) + ':' + canonical(value[k]))
            .join(',') + '}';
    }
    return JSON.stringify(value);
}

function indexById(nodes) {
    const map = new Map();
    for (const n of nodes) {
        if (n && n.id != null) map.set(n.id, n);
    }
    return map;
}

// Per-unit diff between two flow states (base -> head). One entry per unit
// present in either side, including unchanged units (caller can filter).
function diffUnits(baseNodes, headNodes) {
    const baseUnits = new Map(groupByUnit(baseNodes).map(u => [u.id, u]));
    const headUnits = new Map(groupByUnit(headNodes).map(u => [u.id, u]));
    const ids = new Set([...baseUnits.keys(), ...headUnits.keys()]);

    const result = [];
    for (const id of ids) {
        const base = baseUnits.get(id);
        const head = headUnits.get(id);
        const baseById = indexById(base ? base.nodes : []);
        const headById = indexById(head ? head.nodes : []);

        const added = [];
        const modified = [];
        for (const [nid, node] of headById) {
            if (!baseById.has(nid)) {
                added.push(node);
            } else if (canonical(baseById.get(nid)) !== canonical(node)) {
                modified.push({ id: nid, base: baseById.get(nid), head: node });
            }
        }
        const removed = [];
        for (const [nid, node] of baseById) {
            if (!headById.has(nid)) removed.push(node);
        }

        let status;
        if (!base) status = 'added';
        else if (!head) status = 'removed';
        else if (added.length || removed.length || modified.length) status = 'modified';
        else status = 'unchanged';

        const ref = head || base;
        result.push({
            id,
            kind: ref.kind,
            label: ref.label,
            status,
            added,
            removed,
            modified,
            counts: { added: added.length, removed: removed.length, modified: modified.length }
        });
    }

    const order = { flow: 0, subflow: 1, config: 2 };
    return result.sort((a, b) => order[a.kind] - order[b.kind]);
}

// Produce a new flow array where unit `unitId` is replaced by its version from
// `targetNodes` (single-unit revert). All other nodes are left untouched and in
// place; the reverted unit keeps its original position, or is appended if it
// didn't exist in `currentNodes` (e.g. reverting a deletion re-adds the flow).
function spliceUnit(currentNodes, targetNodes, unitId) {
    const current = Array.isArray(currentNodes) ? currentNodes : [];
    const targetUnit = groupByUnit(targetNodes).find(u => u.id === unitId);
    const replacement = targetUnit ? targetUnit.nodes : [];

    const currentUnit = groupByUnit(current).find(u => u.id === unitId);
    const currentUnitIds = new Set((currentUnit ? currentUnit.nodes : []).map(n => n.id));

    const firstIndex = current.findIndex(n => n && currentUnitIds.has(n.id));
    const kept = [];
    let insertAt = -1;
    current.forEach((n, i) => {
        if (i === firstIndex) insertAt = kept.length; // splice position within kept
        if (!(n && currentUnitIds.has(n.id))) kept.push(n);
    });

    if (insertAt < 0) {
        return [...kept, ...replacement];
    }
    const out = kept.slice();
    out.splice(insertAt, 0, ...replacement);
    return out;
}

// Restore specific nodes (by id) to their version at `targetNodes`, leaving all
// other nodes untouched: a modified node is reset, a node added in the working
// tree (absent from target) is removed, and a node deleted from the working tree
// (present at target) is re-added.
function revertNodes(currentNodes, targetNodes, nodeIds) {
    const ids = new Set(nodeIds || []);
    const targetById = indexById(Array.isArray(targetNodes) ? targetNodes : []);
    const seen = new Set();
    const out = [];

    for (const node of (Array.isArray(currentNodes) ? currentNodes : [])) {
        if (node && ids.has(node.id)) {
            seen.add(node.id);
            if (targetById.has(node.id)) {
                out.push(targetById.get(node.id)); // reset to committed version
            }
            // else: node was added in the working tree -> drop it
        } else {
            out.push(node);
        }
    }
    // Re-add nodes deleted from the working tree but present at the target ref.
    for (const id of ids) {
        if (!seen.has(id) && targetById.has(id)) {
            out.push(targetById.get(id));
        }
    }
    return out;
}

// Find config nodes and subflow definitions referenced by a unit's nodes, so a
// single-unit revert can warn about (or optionally include) what it touches.
// Node-RED references a config node by storing its id as a property value, and
// instantiates a subflow via a node whose type is "subflow:<id>".
function findUnitDependencies(unitNodes, allNodes) {
    const all = groupByUnit(allNodes);
    const configUnit = all.find(u => u.kind === 'config');
    const configById = indexById(configUnit ? configUnit.nodes : []);
    const subflowById = new Map(all.filter(u => u.kind === 'subflow').map(u => [u.id, u]));

    const configHits = new Map();
    const subflowHits = new Map();

    const scanValue = (value) => {
        if (typeof value === 'string') {
            if (configById.has(value)) {
                configHits.set(value, { id: value, type: configById.get(value).type });
            }
        } else if (Array.isArray(value)) {
            value.forEach(scanValue);
        }
    };

    for (const node of (Array.isArray(unitNodes) ? unitNodes : [])) {
        if (!node || typeof node !== 'object') continue;
        if (typeof node.type === 'string' && node.type.startsWith('subflow:')) {
            const sid = node.type.slice('subflow:'.length);
            if (subflowById.has(sid)) {
                subflowHits.set(sid, { id: sid, label: subflowById.get(sid).label });
            }
        }
        for (const [key, value] of Object.entries(node)) {
            if (STRUCTURAL_KEYS.has(key)) continue;
            scanValue(value);
        }
    }

    return { config: [...configHits.values()], subflows: [...subflowHits.values()] };
}

// Three-way merge of flows.json by node id, grouped by unit so the caller can
// surface conflicts per flow/subflow. Inputs are the three sides of a git
// conflict: the common ancestor (base, may be null for add/add), and the two
// branches (ours, theirs). Returns the auto-merged node array and the set of
// nodes/units the caller must resolve by choosing a side.
//
// options.choices applies user resolutions during the merge:
//   { byNode: { [nodeId]: 'ours'|'theirs' }, byUnit: { [unitId]: 'ours'|'theirs' } }
// options.fallback ('ours'|'theirs') resolves any remaining conflict.
// Precedence: fallback > byNode > byUnit. The global "take ours/theirs for all"
// dominates everything as a true one-click escape hatch; below that, finer-
// grained per-node picks override coarser per-unit picks.
function mergeFlowsThreeWay(baseNodes, oursNodes, theirsNodes, options = {}) {
    const base = Array.isArray(baseNodes) ? baseNodes : [];
    const ours = Array.isArray(oursNodes) ? oursNodes : [];
    const theirs = Array.isArray(theirsNodes) ? theirsNodes : [];
    const byNode = (options.choices && options.choices.byNode) || {};
    const byUnit = (options.choices && options.choices.byUnit) || {};
    const fallback = options.fallback === 'ours' || options.fallback === 'theirs' ? options.fallback : null;

    const decide = (unitId, nodeId) => {
        if (fallback) return fallback;
        if (nodeId && (byNode[nodeId] === 'ours' || byNode[nodeId] === 'theirs')) return byNode[nodeId];
        if (byUnit[unitId] === 'ours' || byUnit[unitId] === 'theirs') return byUnit[unitId];
        return null;
    };

    const baseUnits = new Map(groupByUnit(base).map(u => [u.id, u]));
    const oursUnits = new Map(groupByUnit(ours).map(u => [u.id, u]));
    const theirsUnits = new Map(groupByUnit(theirs).map(u => [u.id, u]));

    const unitIds = new Set([...baseUnits.keys(), ...oursUnits.keys(), ...theirsUnits.keys()]);

    const mergedByUnit = new Map();   // unitId -> node[]
    const conflicts = [];
    let autoMerged = 0;

    for (const unitId of unitIds) {
        const bU = baseUnits.get(unitId);
        const oU = oursUnits.get(unitId);
        const tU = theirsUnits.get(unitId);

        // Unit-level structural cases first (one side removed the whole unit).
        if (!bU && oU && !tU) { mergedByUnit.set(unitId, oU.nodes); continue; }
        if (!bU && !oU && tU) { mergedByUnit.set(unitId, tU.nodes); continue; }
        if (bU && !oU && !tU) { continue; } // deleted by both
        if (bU && oU && !tU) {
            if (unitCanonical(oU) === unitCanonical(bU)) continue; // theirs deleted, ours unchanged
            const choice = decide(unitId, null);
            if (choice === 'theirs') continue; // drop unit
            if (choice !== 'ours') {
                conflicts.push(structuralConflict(unitId, oU, tU, 'modify-delete', 'theirs'));
            }
            mergedByUnit.set(unitId, oU.nodes);
            continue;
        }
        if (bU && !oU && tU) {
            if (unitCanonical(tU) === unitCanonical(bU)) continue; // ours deleted, theirs unchanged
            const choice = decide(unitId, null);
            if (choice === 'ours') continue; // drop unit
            if (choice !== 'theirs') {
                conflicts.push(structuralConflict(unitId, oU, tU, 'modify-delete', 'ours'));
            }
            mergedByUnit.set(unitId, tU.nodes);
            continue;
        }
        if (!bU && oU && tU) {
            if (unitCanonical(oU) === unitCanonical(tU)) {
                mergedByUnit.set(unitId, oU.nodes);
                continue;
            }
            const choice = decide(unitId, null);
            if (choice === 'theirs') { mergedByUnit.set(unitId, tU.nodes); continue; }
            if (choice !== 'ours') {
                conflicts.push(structuralConflict(unitId, oU, tU, 'add-add-different', null));
            }
            mergedByUnit.set(unitId, oU.nodes);
            continue;
        }

        // Present in all three: per-node merge.
        const perUnit = mergeUnitNodes(bU, oU, tU, decide);
        mergedByUnit.set(unitId, perUnit.nodes);
        autoMerged += perUnit.autoMerged;
        if (perUnit.perNode.length) {
            conflicts.push({
                unitId,
                kind: oU.kind,
                label: oU.label,
                unitConflict: null,
                perNode: perUnit.perNode
            });
        }
    }

    // Emit order: walk ours' unit order, then any theirs-only / base-only units
    // not already emitted (rare; preserves a stable order without flapping).
    const emittedOrder = [];
    const seen = new Set();
    for (const u of groupByUnit(ours)) {
        if (mergedByUnit.has(u.id)) { emittedOrder.push(u.id); seen.add(u.id); }
    }
    for (const u of groupByUnit(theirs)) {
        if (mergedByUnit.has(u.id) && !seen.has(u.id)) { emittedOrder.push(u.id); seen.add(u.id); }
    }
    for (const id of mergedByUnit.keys()) {
        if (!seen.has(id)) { emittedOrder.push(id); seen.add(id); }
    }

    const merged = [];
    for (const id of emittedOrder) {
        for (const n of mergedByUnit.get(id)) merged.push(n);
    }

    return { merged, autoMerged, conflicts };
}

function unitCanonical(unit) {
    return canonical(unit.nodes.slice().sort((a, b) => String(a.id).localeCompare(String(b.id))));
}

function structuralConflict(unitId, oursUnit, theirsUnit, kind, deletedSide) {
    const ref = oursUnit || theirsUnit;
    return {
        unitId,
        kind: ref ? ref.kind : 'flow',
        label: ref ? ref.label : unitId,
        unitConflict: kind,
        deletedSide,
        perNode: []
    };
}

// Per-node merge inside a unit that exists on all three sides. Walks the union
// of node ids and applies the truth table from the plan: a one-sided change
// auto-applies, both-sided identical changes auto-apply, divergent changes or
// modify-vs-delete become per-node conflicts. `decide(unitId, nodeId)` lets the
// caller pre-resolve a conflict (byNode > byUnit > fallback); without a decision
// the conflict is returned and the tentative pick (ours) is applied.
function mergeUnitNodes(baseUnit, oursUnit, theirsUnit, decide) {
    const bById = indexById(baseUnit.nodes);
    const oById = indexById(oursUnit.nodes);
    const tById = indexById(theirsUnit.nodes);

    const ids = new Set([...bById.keys(), ...oById.keys(), ...tById.keys()]);

    const decisions = new Map(); // id -> { node: <node | null = drop> }
    let autoMerged = 0;
    const perNode = [];

    const conflictPick = (id, b, o, t) => {
        const choice = decide ? decide(oursUnit.id, id) : null;
        if (choice === 'ours')   { if (o) decisions.set(id, { node: o }); return; }
        if (choice === 'theirs') { if (t) decisions.set(id, { node: t }); return; }
        // No decision: tentative = whichever side has a node, prefer ours.
        if (o) decisions.set(id, { node: o });
        else if (t) decisions.set(id, { node: t });
        perNode.push({ id, kind: nodeKind(o, t, b), base: b || null, ours: o || null, theirs: t || null });
    };

    for (const id of ids) {
        const b = bById.get(id);
        const o = oById.get(id);
        const t = tById.get(id);

        const oc = o ? canonical(o) : null;
        const tc = t ? canonical(t) : null;
        const bc = b ? canonical(b) : null;

        if (b && o && t) {
            if (oc === bc && tc === bc)          { decisions.set(id, { node: o }); }
            else if (oc === bc)                  { decisions.set(id, { node: t }); autoMerged++; }
            else if (tc === bc)                  { decisions.set(id, { node: o }); autoMerged++; }
            else if (oc === tc)                  { decisions.set(id, { node: o }); autoMerged++; }
            else                                   conflictPick(id, b, o, t);
        } else if (b && o && !t) {
            if (oc === bc) { /* deleted by theirs, ours unchanged -> drop */ }
            else            conflictPick(id, b, o, null);
        } else if (b && !o && t) {
            if (tc === bc) { /* deleted by ours, theirs unchanged -> drop */ }
            else            conflictPick(id, b, null, t);
        } else if (b && !o && !t) {
            /* deleted by both -> drop */
        } else if (!b && o && !t) {
            decisions.set(id, { node: o }); autoMerged++;
        } else if (!b && !o && t) {
            decisions.set(id, { node: t }); autoMerged++;
        } else if (!b && o && t) {
            if (oc === tc) { decisions.set(id, { node: o }); autoMerged++; }
            else            conflictPick(id, null, o, t);
        }
    }

    // Emit ours order first, then theirs-only additions in their order. Skip ids
    // the decision map dropped.
    const out = [];
    const emitted = new Set();
    for (const n of oursUnit.nodes) {
        if (!decisions.has(n.id)) continue;
        out.push(decisions.get(n.id).node);
        emitted.add(n.id);
    }
    for (const n of theirsUnit.nodes) {
        if (emitted.has(n.id)) continue;
        if (!decisions.has(n.id)) continue;
        out.push(decisions.get(n.id).node);
        emitted.add(n.id);
    }

    return { nodes: out, autoMerged, perNode };
}

function nodeKind(o, t, b) {
    const ref = o || t || b;
    return ref && typeof ref.type === 'string' ? ref.type : 'unknown';
}

module.exports = {
    CONFIG_UNIT_ID,
    parseFlows,
    groupByUnit,
    diffUnits,
    spliceUnit,
    revertNodes,
    findUnitDependencies,
    canonical,
    mergeFlowsThreeWay
};
