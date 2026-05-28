// A pull that cannot auto-merge (local and remote changed the same line) must
// NOT throw and must NOT leave the editor redeploying a flows.json full of
// conflict markers. Instead pull reports the conflict, leaves the merge
// in-progress for the banner, and Abort returns to a clean state.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { LIB } = require('./helpers');

let work, A, core, svc;

const g = (repo) => (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
const setIdent = (repo) => {
    g(repo)('config', 'user.email', 'x@e.com');
    g(repo)('config', 'user.name', 'X');
    g(repo)('config', 'commit.gpgsign', 'false');
};
const wf = (repo, label) => fs.writeFileSync(path.join(repo, 'flows.json'),
    JSON.stringify([{ id: 't1', type: 'tab', label }], null, 4) + '\n');

before(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitctl-pull-conflict-'));
    const origin = path.join(work, 'origin.git');
    A = path.join(work, 'A');
    const B = path.join(work, 'B');

    execFileSync('git', ['init', '-q', '--bare', origin]);
    execFileSync('git', ['clone', '-q', origin, A]); setIdent(A);
    wf(A, 'base'); g(A)('add', '-A'); g(A)('commit', '-qm', 'init');
    g(A)('push', '-q', 'origin', 'HEAD:refs/heads/main');
    g(A)('branch', '-q', '--set-upstream-to=origin/main');

    execFileSync('git', ['clone', '-q', origin, B]); setIdent(B);
    g(B)('checkout', '-q', '-B', 'main', 'origin/main');

    // Both sides change the SAME line of flows.json in different ways.
    wf(B, 'from-remote'); g(B)('add', '-A'); g(B)('commit', '-qm', 'remote edit'); g(B)('push', '-q', 'origin', 'main');
    wf(A, 'from-local'); g(A)('add', '-A'); g(A)('commit', '-qm', 'local edit');

    const RED = {
        settings: {
            userDir: work, flowFile: 'flows.json', flowFilePretty: true,
            get: () => undefined,
            getUserSettings: async () => ({ git: { user: { name: 'NR', email: 'nr@e.com' } } })
        },
        log: { info() {}, warn() {}, error() {} },
        auth: { needsPermission: () => (q, r, n) => n && n() },
        httpAdmin: { get() {}, post() {} }
    };
    core = require(path.join(LIB, 'git-core'))(RED);
    svc = require(path.join(LIB, 'git-service'))(RED, core);
});

after(() => work && fs.rmSync(work, { recursive: true, force: true }));

test('a diverged pull asks before merging (no auto-merge)', async () => {
    const r = await svc.pull({ repoPath: A, user: { username: 'u' } });
    assert.equal(r.needsMerge, true);
    assert.ok(r.ahead > 0 && r.behind > 0);
    assert.equal(r.conflicted, false);
    // Nothing was merged yet — no merge in progress, HEAD is still the local commit.
    assert.equal(core.getMergeState(A).inProgress, false);
});

test('a non-mergeable pull (confirmed) reports a conflict instead of throwing', async () => {
    const r = await svc.pull({ repoPath: A, user: { username: 'u' }, allowMerge: true });
    assert.equal(r.conflicted, true);
    assert.ok((r.conflictedFiles || []).includes('flows.json'));
    // Merge is left in progress so the UI shows the banner + Abort.
    assert.equal(core.getMergeState(A).inProgress, true);
});

test('abort clears the conflicted pull', async () => {
    const ab = await svc.abortOperation({ repoPath: A });
    assert.equal(ab.kind, 'merge');
    assert.equal(core.getMergeState(A).inProgress, false);
    const status = await svc.getStatus({ repoPath: A });
    assert.equal((status.status.conflicted || []).length, 0);
});
