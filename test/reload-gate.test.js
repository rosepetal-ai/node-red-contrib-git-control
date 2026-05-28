// The reload gate: ops that move HEAD report flowFileChanged based on whether
// the ON-DISK flow file actually changed, so the UI only restarts Node-RED when
// the editor genuinely needs to resync. The subtle case is a mixed reset, which
// moves HEAD without touching the working tree (so flowFileChanged must be false).
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createScratch } = require('./helpers');

let ctx, c1, c2, mainBranch;
const readme = () => path.join(ctx.repo, 'README.md');

before(() => {
    ctx = createScratch();

    // c1: flows 'one'
    ctx.writeFlows([{ id: 't1', type: 'tab', label: 'one' }]);
    fs.writeFileSync(readme(), 'a\n');
    ctx.git('add', '-A'); ctx.git('commit', '-q', '-m', 'c1');
    c1 = ctx.head();
    mainBranch = ctx.git('rev-parse', '--abbrev-ref', 'HEAD').trim();

    // branch 'docs' off c1: only README changes (flow file stays 'one')
    ctx.git('checkout', '-q', '-b', 'docs');
    fs.writeFileSync(readme(), 'b\n');
    ctx.git('add', '-A'); ctx.git('commit', '-q', '-m', 'docs only');

    // c2 on the main branch: flows 'two'
    ctx.git('checkout', '-q', mainBranch);
    ctx.writeFlows([{ id: 't1', type: 'tab', label: 'two' }]);
    ctx.git('add', '-A'); ctx.git('commit', '-q', '-m', 'c2');
    c2 = ctx.head();
});

after(() => ctx && ctx.cleanup());

test('checkout reports flowFileChanged when the flow file differs', async () => {
    ctx.git('checkout', '-f', c2); // working tree = 'two'
    const r = await ctx.svc.checkout({ repoPath: ctx.repo, commitRef: c1 });
    assert.equal(r.flowFileChanged, true);
});

test('checkout reports no change when only non-flow files differ', async () => {
    ctx.git('checkout', '-f', c1); // working tree = 'one'
    const r = await ctx.svc.checkout({ repoPath: ctx.repo, commitRef: 'docs' });
    assert.equal(r.flowFileChanged, false);
});

test('mixed reset never rewrites the working tree (no restart)', async () => {
    ctx.git('checkout', '-f', c2); // working tree = 'two'
    const r = await ctx.svc.reset({ repoPath: ctx.repo, commitRef: c1, resetMode: 'mixed' });
    assert.equal(r.flowFileChanged, false);
});

test('hard reset reports flowFileChanged when the flow file differs', async () => {
    ctx.git('checkout', '-f', c2); // working tree = 'two'
    const r = await ctx.svc.reset({ repoPath: ctx.repo, commitRef: c1, resetMode: 'hard', safeMode: false });
    assert.equal(r.flowFileChanged, true);
});

test('fast-forward merge that brings a flow change reports flowFileChanged', async () => {
    ctx.git('checkout', '-f', '-B', 'mergebase', c1); // clean tree at c1 = 'one'
    const r = await ctx.svc.merge({ repoPath: ctx.repo, ref: c2 });
    assert.equal(r.conflicted, false);
    assert.equal(r.flowFileChanged, true);
});

test('branch from a past commit (checked out) reports flowFileChanged', async () => {
    ctx.git('checkout', '-f', c2); // working tree = 'two'
    const r = await ctx.svc.createBranch({ repoPath: ctx.repo, name: 'fromc1', startPoint: c1, checkout: true });
    assert.equal(r.flowFileChanged, true);
});
