// Integration tests for the git-control backend ops against a scratch repo.
// Each step builds on the previous one, so they run in order.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { createScratch } = require('./helpers');

let ctx;
let cur; // the initial branch name (main/master, environment-dependent)

const sampleFlows = [
    { id: 't1', type: 'tab', label: 'Main' },
    { id: 'n1', type: 'inject', z: 't1', name: 'tick' },
    { id: 'n2', type: 'mqtt out', z: 't1', name: 'pub', broker: 'c1' },
    { id: 'n4', type: 'subflow:s1', z: 't1' },
    { id: 's1', type: 'subflow', name: 'MySub' },
    { id: 'n3', type: 'function', z: 's1', func: 'return msg;' },
    { id: 'c1', type: 'mqtt-broker', name: 'broker' }
];

before(async () => {
    ctx = createScratch();
    ctx.writeFlows(sampleFlows);
    ctx.git('add', '-A');
    ctx.git('commit', '-q', '-m', 'init');
    cur = (await ctx.svc.getStatus({ repoPath: ctx.repo })).status.current;
});

after(() => ctx && ctx.cleanup());

test('flow-units returns flow / subflow / config units', async () => {
    const units = await ctx.svc.getFlowUnits({ repoPath: ctx.repo, ref: 'HEAD' });
    assert.equal(units.units.length, 3);
    assert.equal(units.units.map(u => u.kind).join(), 'flow,subflow,config');
});

test('flow-diff marks only the modified flow', async () => {
    const modified = JSON.parse(JSON.stringify(sampleFlows));
    modified.find(n => n.id === 'n2').name = 'pub-CHANGED';
    ctx.writeFlows(modified);

    const diff = await ctx.svc.diffFlows({ repoPath: ctx.repo, base: 'HEAD' });
    const flowT1 = diff.units.find(u => u.id === 't1');
    assert.ok(flowT1 && flowT1.status === 'modified');
    assert.equal(flowT1.modified[0].id, 'n2');
    assert.equal(diff.changed, 1);
});

test('flow-diff detail mode carries full node bodies', async () => {
    const diffDetail = await ctx.svc.diffFlows({ repoPath: ctx.repo, base: 'HEAD', detail: true });
    const dT1 = diffDetail.units.find(u => u.id === 't1');
    assert.equal(dT1.modified[0].head.name, 'pub-CHANGED');
});

test('revert-flow-unit restores the flow and reports dependencies', async () => {
    const rev = await ctx.svc.revertFlowUnit({ repoPath: ctx.repo, unitId: 't1', ref: 'HEAD' });
    const afterRevert = ctx.readFlows();
    assert.equal(afterRevert.find(n => n.id === 'n2').name, 'pub');
    assert.ok(rev.dependencies.config.some(c => c.id === 'c1'));
    assert.ok(rev.dependencies.subflows.some(s => s.id === 's1'));
});

test('revert-flow-nodes resets only the named node', async () => {
    const twoMod = JSON.parse(JSON.stringify(sampleFlows));
    twoMod.find(n => n.id === 'n1').name = 'n1-changed';
    twoMod.find(n => n.id === 'n2').name = 'n2-changed';
    ctx.writeFlows(twoMod);

    await ctx.svc.revertFlowNodes({ repoPath: ctx.repo, nodeIds: ['n1'], ref: 'HEAD' });
    const afterNode = ctx.readFlows();
    assert.equal(afterNode.find(n => n.id === 'n1').name, 'tick');
    assert.equal(afterNode.find(n => n.id === 'n2').name, 'n2-changed');

    await ctx.svc.discardAll({ repoPath: ctx.repo });
});

test('create / rename / delete branch', async () => {
    await ctx.svc.createBranch({ repoPath: ctx.repo, name: 'feature/x', checkout: true });
    assert.equal((await ctx.svc.getStatus({ repoPath: ctx.repo })).status.current, 'feature/x');

    await ctx.svc.renameBranch({ repoPath: ctx.repo, to: 'feature/y' });
    assert.equal((await ctx.svc.getStatus({ repoPath: ctx.repo })).status.current, 'feature/y');

    await ctx.svc.checkout({ repoPath: ctx.repo, commitRef: cur });
    await ctx.svc.deleteBranch({ repoPath: ctx.repo, name: 'feature/y', force: true });
    const branches = await ctx.svc.getBranches({ repoPath: ctx.repo });
    assert.ok(!branches.all.includes('feature/y'));
});

test('orphan branch has no prior history (getLog returns empty, not an error)', async () => {
    await ctx.svc.createOrphanBranch({ repoPath: ctx.repo, name: 'orphan', keepContent: true });
    const orphanLog = await ctx.svc.getLog({ repoPath: ctx.repo, maxCount: 50 });
    assert.equal(orphanLog.commits.length, 0);
    await ctx.svc.checkout({ repoPath: ctx.repo, commitRef: cur });
});

test('commit then revert that commit', async () => {
    const wt = ctx.readFlows();
    wt.push({ id: 't2', type: 'tab', label: 'Second' });
    ctx.writeFlows(wt);
    await ctx.svc.add({ repoPath: ctx.repo, stageAll: true });

    const committed = await ctx.svc.commit({ repoPath: ctx.repo, message: 'add second flow', user: { username: 'tester' } });
    assert.ok(committed.success && committed.commit);

    const cd = await ctx.svc.getCommitDiff({ repoPath: ctx.repo, commitRef: 'HEAD' });
    assert.ok(cd.files.some(f => f.path === 'flows.json'));

    const reverted = await ctx.svc.revertCommit({ repoPath: ctx.repo, commitRef: 'HEAD', user: { username: 'tester' } });
    assert.ok(reverted.success);
    assert.ok(!ctx.readFlows().find(n => n.id === 't2'));
});

test('file-diff returns a unified diff', async () => {
    const fd = await ctx.svc.getFileDiff({ repoPath: ctx.repo, file: 'flows.json', base: 'HEAD~1', head: 'HEAD' });
    assert.ok(typeof fd.diff === 'string' && fd.diff.includes('flows.json') && fd.diff.includes('Second'));
});

test('leading-dash ref is rejected (arg-injection guard)', async () => {
    await assert.rejects(
        () => ctx.svc.checkout({ repoPath: ctx.repo, commitRef: '--upload-pack=evil' }),
        /Invalid git reference/
    );
});

test('delete-branch refuses an unmerged branch, then force-deletes it', async () => {
    const start = (await ctx.svc.getStatus({ repoPath: ctx.repo })).status.current;
    await ctx.svc.createBranch({ repoPath: ctx.repo, name: 'unmerged', checkout: true });
    const wt = ctx.readFlows();
    wt.push({ id: 'tmp', type: 'tab', label: 'tmp' });
    ctx.writeFlows(wt);
    await ctx.svc.add({ repoPath: ctx.repo, stageAll: true });
    await ctx.svc.commit({ repoPath: ctx.repo, message: 'unmerged work', user: { username: 'tester' } });
    await ctx.svc.checkout({ repoPath: ctx.repo, commitRef: start });

    // A plain delete must refuse (the UI keys its force-delete offer off this).
    await assert.rejects(
        () => ctx.svc.deleteBranch({ repoPath: ctx.repo, name: 'unmerged' }),
        /not fully merged|not yet merged/i
    );

    await ctx.svc.deleteBranch({ repoPath: ctx.repo, name: 'unmerged', force: true });
    const branches = await ctx.svc.getBranches({ repoPath: ctx.repo });
    assert.ok(!branches.all.includes('unmerged'));
});

test('formatGitError maps an unmerged-branch delete to a clear, detectable message', () => {
    const info = ctx.core.formatGitError(new Error("error: The branch 'x' is not fully merged."), 'delete branch');
    assert.equal(info.error, 'Branch is not fully merged');
    // The branch-menu force-delete offer matches on this message.
    assert.match(info.error, /not fully merged/i);
});
