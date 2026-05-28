// Integration tests for the backend call patterns the commit-history UI uses:
// diff a commit vs its parent, root-commit vs the empty tree, and restore a
// flow unit / branch from a PAST commit.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createScratch } = require('./helpers');

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

let ctx, c1, c2;

before(() => {
    ctx = createScratch();

    // commit 1 (root): one flow with one node
    ctx.writeFlows([
        { id: 't1', type: 'tab', label: 'Main' },
        { id: 'n1', type: 'inject', z: 't1', name: 'tick' }
    ]);
    ctx.git('add', '-A'); ctx.git('commit', '-q', '-m', 'root');
    c1 = ctx.head();

    // commit 2: modify n1, add a second flow
    ctx.writeFlows([
        { id: 't1', type: 'tab', label: 'Main' },
        { id: 'n1', type: 'inject', z: 't1', name: 'tick-CHANGED' },
        { id: 't2', type: 'tab', label: 'Second' },
        { id: 'n2', type: 'debug', z: 't2', name: 'out' }
    ]);
    ctx.git('add', '-A'); ctx.git('commit', '-q', '-m', 'edit n1 + add second flow');
    c2 = ctx.head();
});

after(() => ctx && ctx.cleanup());

test('diff a commit against its parent', async () => {
    const d = await ctx.svc.diffFlows({ repoPath: ctx.repo, base: c1, head: c2 });
    const t1 = d.units.find(u => u.id === 't1');
    const t2 = d.units.find(u => u.id === 't2');
    assert.equal(t1 && t1.status, 'modified');
    assert.equal(t2 && t2.status, 'added');
    assert.equal(d.changed, 2);
});

test('detail mode carries the changed node body', async () => {
    const dd = await ctx.svc.diffFlows({ repoPath: ctx.repo, base: c1, head: c2, detail: true });
    const dt1 = dd.units.find(u => u.id === 't1');
    assert.equal(dt1.modified[0].head.name, 'tick-CHANGED');
});

test('root commit vs empty tree shows everything as added', async () => {
    const root = await ctx.svc.diffFlows({ repoPath: ctx.repo, base: EMPTY_TREE, head: c1 });
    const rootT1 = root.units.find(u => u.id === 't1');
    assert.equal(rootT1 && rootT1.status, 'added');
});

test('restore one flow unit from a past commit', async () => {
    const rev = await ctx.svc.revertFlowUnit({ repoPath: ctx.repo, unitId: 't1', ref: c1 });
    const after = ctx.readFlows();
    assert.equal(after.find(n => n.id === 'n1').name, 'tick');
    assert.ok(after.find(n => n.id === 't2')); // other flow untouched
    assert.equal(rev.ref, c1);
    await ctx.svc.discardAll({ repoPath: ctx.repo }); // back to clean c2
});

test('branch from a past commit', async () => {
    await ctx.svc.createBranch({ repoPath: ctx.repo, name: 'from-root', startPoint: c1, checkout: false });
    const branches = await ctx.svc.getBranches({ repoPath: ctx.repo });
    assert.ok(branches.all.includes('from-root'));
    assert.equal(ctx.git('rev-parse', 'from-root').trim(), c1);
});

test('file-diff and commit-diff between commits', async () => {
    const fd = await ctx.svc.getFileDiff({ repoPath: ctx.repo, file: 'flows.json', base: c1, head: c2 });
    assert.ok(/Second/.test(fd.diff) && /tick-CHANGED/.test(fd.diff));

    const cd = await ctx.svc.getCommitDiff({ repoPath: ctx.repo, commitRef: c2 });
    assert.ok(cd.files.some(f => f.path === 'flows.json' && f.status === 'M'));
});

test('commit-branches lists the branches that contain a commit', async () => {
    // from-root was created at c1 (checkout:false), so HEAD is still the main branch.
    const main = ctx.git('rev-parse', '--abbrev-ref', 'HEAD').trim();

    // c2 lives only on main (from-root sits at c1, behind it).
    const atC2 = await ctx.svc.getCommitBranches({ repoPath: ctx.repo, commitRef: c2 });
    assert.deepEqual(atC2.branches.slice().sort(), [main]);
    assert.equal(atC2.current, main);

    // c1 is contained by both main and from-root.
    const atC1 = await ctx.svc.getCommitBranches({ repoPath: ctx.repo, commitRef: c1 });
    assert.ok(atC1.branches.includes(main));
    assert.ok(atC1.branches.includes('from-root'));
});
