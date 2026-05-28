// Safety-net tests: a real merge conflict is reported (not thrown), detected by
// getMergeState, surfaced in status, and cleared by abortOperation.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createScratch } = require('./helpers');

let ctx, base;

before(() => {
    ctx = createScratch();
    const write = (label) => ctx.writeFlows([{ id: 't1', type: 'tab', label }]);

    write('base'); ctx.git('add', '-A'); ctx.git('commit', '-q', '-m', 'base');
    base = (ctx.git('rev-parse', '--abbrev-ref', 'HEAD')).trim();

    // branch A and branch B change the same label different ways
    ctx.git('checkout', '-q', '-b', 'A');
    write('from-A'); ctx.git('add', '-A'); ctx.git('commit', '-q', '-m', 'A');

    ctx.git('checkout', '-q', base);
    ctx.git('checkout', '-q', '-b', 'B');
    write('from-B'); ctx.git('add', '-A'); ctx.git('commit', '-q', '-m', 'B');
});

after(() => ctx && ctx.cleanup());

test('clean repo reports no operation in progress', () => {
    assert.equal(ctx.core.getMergeState(ctx.repo).inProgress, false);
});

test('merge reports the conflict instead of throwing', async () => {
    const mres = await ctx.svc.merge({ repoPath: ctx.repo, ref: 'A' });
    assert.equal(mres.conflicted, true);
    assert.ok((mres.conflictedFiles || []).includes('flows.json'));
});

test('getMergeState and status see the in-progress merge', async () => {
    const st = ctx.core.getMergeState(ctx.repo);
    assert.ok(st.inProgress === true && st.kind === 'merge');

    const status = await ctx.svc.getStatus({ repoPath: ctx.repo });
    assert.ok((status.status.conflicted || []).includes('flows.json'));
});

test('abort returns to a clean state', async () => {
    const ab = await ctx.svc.abortOperation({ repoPath: ctx.repo });
    assert.equal(ab.kind, 'merge');
    assert.equal(ctx.core.getMergeState(ctx.repo).inProgress, false);

    const status = await ctx.svc.getStatus({ repoPath: ctx.repo });
    assert.equal((status.status.conflicted || []).length, 0);
});

test('abort with nothing in progress is rejected cleanly', async () => {
    await assert.rejects(
        () => ctx.svc.abortOperation({ repoPath: ctx.repo }),
        /no merge|in progress/i
    );
});
