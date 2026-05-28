// End-to-end tests for the flow-aware merge resolver: a real merge conflict is
// produced, previewed, and finalized via service ops only — no UI involved.
'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createScratch } = require('./helpers');

const tab = (id, label) => ({ id, type: 'tab', label });
const fn = (id, z, extra = {}) => ({ id, type: 'function', z, func: 'return msg;', ...extra });

// Sets up a repo where main and branch B both modified the same function node
// differently. Calling .merge() leaves the repo conflicted on flows.json.
async function conflictedRepo(setup) {
    const ctx = createScratch();
    setup(ctx);
    return ctx;
}

let ctx;
afterEach(() => { if (ctx) { ctx.cleanup(); ctx = null; } });

function commitAll(ctx, msg) { ctx.git('add', '-A'); ctx.git('commit', '-q', '-m', msg); }

// Produce two-node conflict on a single tab: ours sets nameA, theirs sets nameB.
async function setupTwoNodeConflict() {
    ctx = await conflictedRepo((c) => {
        c.writeFlows([tab('t1', 'main'), fn('n1', 't1', { name: 'before' }), fn('n2', 't1', { name: 'before2' })]);
        commitAll(c, 'base');
        c.git('checkout', '-q', '-b', 'feature');
        c.writeFlows([tab('t1', 'main'), fn('n1', 't1', { name: 'feature-1' }), fn('n2', 't1', { name: 'feature-2' })]);
        commitAll(c, 'feature work');
        c.git('checkout', '-q', '-');
        c.writeFlows([tab('t1', 'main'), fn('n1', 't1', { name: 'master-1' }), fn('n2', 't1', { name: 'master-2' })]);
        commitAll(c, 'master work');
    });
    const r = await ctx.svc.merge({ repoPath: ctx.repo, ref: 'feature' });
    assert.equal(r.conflicted, true, 'precondition: merge produced a conflict');
}

test('preview reports the conflict shape and lists no other files', async () => {
    await setupTwoNodeConflict();
    const p = await ctx.svc.previewMergeResolution({ repoPath: ctx.repo });
    assert.equal(p.flowFileMergeable, true);
    assert.equal(p.kind, 'merge');
    assert.deepEqual(p.otherFiles, []);
    assert.equal(p.conflicts.length, 1, 'one unit conflict');
    assert.equal(p.conflicts[0].unitId, 't1');
    assert.equal(p.conflicts[0].perNode.length, 2);
});

test('preview carries branch + commit context for the resolver UI', async () => {
    await setupTwoNodeConflict();
    const p = await ctx.svc.previewMergeResolution({ repoPath: ctx.repo });
    // git's default main branch name may be 'main' or 'master' depending on env; both are acceptable.
    assert.ok(p.oursRef && /^[\w./-]+$/.test(p.oursRef), 'oursRef populated');
    assert.equal(p.theirsRef, 'feature', "theirsRef recovered from .git/MERGE_MSG");
    assert.ok(p.oursCommit && p.oursCommit.hash, 'ours commit metadata present');
    assert.ok(p.theirsCommit && p.theirsCommit.hash, 'theirs commit metadata present');
    assert.equal(p.theirsCommit.message, 'feature work');
    assert.equal(p.oursCommit.message, 'master work');
    assert.ok(p.mergeBase && p.mergeBase.hash, 'merge-base resolved');
    assert.ok(p.mergeMessage && /Merge branch 'feature'/.test(p.mergeMessage), "mergeMessage pre-filled from git");
});

test('fallback ours resolves and commits; flows reflect ours', async () => {
    await setupTwoNodeConflict();
    const r = await ctx.svc.resolveConflict({ repoPath: ctx.repo, fallback: 'ours' });
    assert.equal(r.success, true);
    assert.ok(r.commit, 'a merge commit was created');
    assert.equal(fs.existsSync(path.join(ctx.repo, '.git', 'MERGE_HEAD')), false);
    const flows = ctx.readFlows();
    const n1 = flows.find(n => n.id === 'n1');
    assert.equal(n1.name, 'master-1');
});

test('fallback theirs resolves and commits; flows reflect theirs', async () => {
    await setupTwoNodeConflict();
    const r = await ctx.svc.resolveConflict({ repoPath: ctx.repo, fallback: 'theirs' });
    assert.equal(r.success, true);
    const flows = ctx.readFlows();
    assert.equal(flows.find(n => n.id === 'n1').name, 'feature-1');
    assert.equal(flows.find(n => n.id === 'n2').name, 'feature-2');
});

test('byUnit takes the whole flow from one side in one click', async () => {
    await setupTwoNodeConflict();
    const r = await ctx.svc.resolveConflict({
        repoPath: ctx.repo,
        choices: { byUnit: { t1: 'theirs' } }
    });
    assert.equal(r.success, true);
    const flows = ctx.readFlows();
    assert.equal(flows.find(n => n.id === 'n1').name, 'feature-1');
    assert.equal(flows.find(n => n.id === 'n2').name, 'feature-2');
});

test('fallback overrides byUnit and byNode (global wins)', async () => {
    await setupTwoNodeConflict();
    const r = await ctx.svc.resolveConflict({
        repoPath: ctx.repo,
        choices: {
            byUnit: { t1: 'ours' },
            byNode: { n1: 'ours', n2: 'ours' }
        },
        fallback: 'theirs'  // global takes precedence
    });
    assert.equal(r.success, true);
    const flows = ctx.readFlows();
    assert.equal(flows.find(n => n.id === 'n1').name, 'feature-1');
    assert.equal(flows.find(n => n.id === 'n2').name, 'feature-2');
});

test('byNode overrides byUnit for a single node', async () => {
    await setupTwoNodeConflict();
    const r = await ctx.svc.resolveConflict({
        repoPath: ctx.repo,
        choices: {
            byUnit: { t1: 'theirs' },
            byNode: { n1: 'ours' }
        }
    });
    assert.equal(r.success, true);
    const flows = ctx.readFlows();
    assert.equal(flows.find(n => n.id === 'n1').name, 'master-1', 'n1 follows byNode override');
    assert.equal(flows.find(n => n.id === 'n2').name, 'feature-2', 'n2 follows byUnit');
});

test('refuses when conflicts remain and fallback is auto', async () => {
    await setupTwoNodeConflict();
    await assert.rejects(
        () => ctx.svc.resolveConflict({ repoPath: ctx.repo }),
        (e) => e.statusCode === 409 && /Unresolved/.test(e.responseBody.error)
    );
});

test('refuses when another file is also conflicted', async () => {
    ctx = await conflictedRepo((c) => {
        c.writeFlows([tab('t1', 'main'), fn('n1', 't1', { name: 'before' })]);
        fs.writeFileSync(path.join(c.repo, 'notes.txt'), 'base\n');
        commitAll(c, 'base');
        c.git('checkout', '-q', '-b', 'feature');
        c.writeFlows([tab('t1', 'main'), fn('n1', 't1', { name: 'feature' })]);
        fs.writeFileSync(path.join(c.repo, 'notes.txt'), 'feature\n');
        commitAll(c, 'feature');
        c.git('checkout', '-q', '-');
        c.writeFlows([tab('t1', 'main'), fn('n1', 't1', { name: 'master' })]);
        fs.writeFileSync(path.join(c.repo, 'notes.txt'), 'master\n');
        commitAll(c, 'master');
    });
    const m = await ctx.svc.merge({ repoPath: ctx.repo, ref: 'feature' });
    assert.equal(m.conflicted, true);

    await assert.rejects(
        () => ctx.svc.resolveConflict({ repoPath: ctx.repo, fallback: 'ours' }),
        (e) => e.statusCode === 409 && /Other files/.test(e.responseBody.error)
    );
});

test('modify-vs-delete on a whole unit: byUnit chooses keep or drop', async () => {
    ctx = await conflictedRepo((c) => {
        c.writeFlows([tab('t1', 'main'), fn('n1', 't1'), tab('t2', 'two'), fn('n2', 't2', { name: 'base' })]);
        commitAll(c, 'base');
        c.git('checkout', '-q', '-b', 'feature');
        // theirs deletes the whole t2 unit
        c.writeFlows([tab('t1', 'main'), fn('n1', 't1')]);
        commitAll(c, 'drop t2');
        c.git('checkout', '-q', '-');
        // ours keeps t2 but modifies it
        c.writeFlows([tab('t1', 'main'), fn('n1', 't1'), tab('t2', 'two'), fn('n2', 't2', { name: 'master-edit' })]);
        commitAll(c, 'edit t2');
    });
    const m = await ctx.svc.merge({ repoPath: ctx.repo, ref: 'feature' });
    assert.equal(m.conflicted, true);

    const p = await ctx.svc.previewMergeResolution({ repoPath: ctx.repo });
    const t2 = p.conflicts.find(c => c.unitId === 't2');
    assert.ok(t2, 't2 surfaces as a unit conflict');
    assert.equal(t2.unitConflict, 'modify-delete');

    const r = await ctx.svc.resolveConflict({
        repoPath: ctx.repo,
        choices: { byUnit: { t2: 'theirs' } }   // accept the deletion
    });
    assert.equal(r.success, true);
    const flows = ctx.readFlows();
    assert.equal(flows.find(n => n.id === 't2'), undefined);
    assert.equal(flows.find(n => n.id === 'n2'), undefined);
});

test('add-add identical: auto-merges with no user choice required', async () => {
    ctx = await conflictedRepo((c) => {
        c.writeFlows([tab('t1', 'main')]);
        commitAll(c, 'base');
        c.git('checkout', '-q', '-b', 'feature');
        c.writeFlows([tab('t1', 'main'), tab('tNew', 'new'), fn('nNew', 'tNew', { name: 'identical' })]);
        commitAll(c, 'add tNew on feature');
        c.git('checkout', '-q', '-');
        // Master adds the SAME tab+node, identical content. Without flows.json
        // they're already identical (no conflict at all); force a conflict by
        // also editing master's existing t1 tab differently from feature.
        c.writeFlows([tab('t1', 'main-edit'), tab('tNew', 'new'), fn('nNew', 'tNew', { name: 'identical' })]);
        commitAll(c, 'add tNew on master');
    });
    // Both sides added tNew identically AND master changed t1. To get a real
    // conflict, also change t1 on the other side:
    ctx.git('checkout', '-q', 'feature');
    ctx.writeFlows([tab('t1', 'main-feature'), tab('tNew', 'new'), fn('nNew', 'tNew', { name: 'identical' })]);
    commitAll(ctx, 'feature edits t1');
    ctx.git('checkout', '-q', '-');

    const m = await ctx.svc.merge({ repoPath: ctx.repo, ref: 'feature' });
    assert.equal(m.conflicted, true);

    const p = await ctx.svc.previewMergeResolution({ repoPath: ctx.repo });
    // The only conflicts should concern t1 — tNew's add/add is identical and auto-merges.
    assert.ok(!p.conflicts.find(c => c.unitId === 'tNew'),
        'identical add/add does not produce a conflict row');
});
