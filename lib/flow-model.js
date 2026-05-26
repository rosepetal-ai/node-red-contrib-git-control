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

module.exports = {
    CONFIG_UNIT_ID,
    parseFlows,
    groupByUnit,
    diffUnits,
    spliceUnit,
    revertNodes,
    findUnitDependencies,
    canonical
};
