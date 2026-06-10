// getFlowFileRelPath must find the real flow file even in Node-RED "projects"
// mode, where RED.settings.flowFile is the project NAME (e.g. "flows"), not the
// flow file. The truth lives in the project's package.json, the same file
// Node-RED reads. Without this, flow-aware ops read a non-existent file and the
// per-flow diff silently comes back empty.
'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createScratch } = require('./helpers');

let ctx;
afterEach(() => { if (ctx) { ctx.cleanup(); ctx = null; } });

const writeManifest = (repo, nodeRed) =>
    fs.writeFileSync(path.join(repo, 'package.json'),
        JSON.stringify({ name: 'flows', 'node-red': nodeRed }, null, 4) + '\n');

test('projects mode: manifest flow file wins over the project-name flowFile setting', () => {
    // Reproduces the deployment bug: launched as `node-red flows`, so
    // RED.settings.flowFile === 'flows' (no .json).
    ctx = createScratch({ settings: { flowFile: 'flows' } });
    writeManifest(ctx.repo, { settings: { flowFile: 'flows.json' } });

    assert.strictEqual(ctx.core.getFlowFileRelPath(ctx.repo), 'flows.json');
});

test('legacy schema: node-red.flowFile (no settings wrapper) is honored', () => {
    ctx = createScratch({ settings: { flowFile: 'flows' } });
    writeManifest(ctx.repo, { flowFile: 'my-flows.json' });

    assert.strictEqual(ctx.core.getFlowFileRelPath(ctx.repo), 'my-flows.json');
});

test('no manifest: falls back to RED.settings.flowFile (classic mode unchanged)', () => {
    ctx = createScratch({ settings: { flowFile: 'flows.json' } });
    // no package.json written

    assert.strictEqual(ctx.core.getFlowFileRelPath(ctx.repo), 'flows.json');
});

test('manifest without a flow file: falls back to RED.settings.flowFile', () => {
    ctx = createScratch({ settings: { flowFile: 'flows.json' } });
    writeManifest(ctx.repo, { settings: { credentialsFile: 'flows_cred.json' } });

    assert.strictEqual(ctx.core.getFlowFileRelPath(ctx.repo), 'flows.json');
});

test('invalid manifest JSON: does not throw, falls back', () => {
    ctx = createScratch({ settings: { flowFile: 'flows.json' } });
    fs.writeFileSync(path.join(ctx.repo, 'package.json'), '{ not valid json');

    assert.strictEqual(ctx.core.getFlowFileRelPath(ctx.repo), 'flows.json');
});
