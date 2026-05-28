// A pull that can't fast-forward must create a merge commit. That commit has to
// use the resolved (Node-RED) identity injected via -c, NOT git's auto-detected
// one — otherwise it fails with "committer identity unknown". This reproduces
// the bug and asserts the injected identity is what lands on the merge commit
// (the -c override makes this true regardless of any global git config).
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { LIB } = require('./helpers');

const ID = { name: 'NR User', email: 'nr-user@example.com' };
let work, A, svc;

// git with an EPHEMERAL identity (-c only), so the repo's stored config never
// gains user.name/email — exactly the state that broke pull.
const gx = (repo) => (...a) => execFileSync('git',
    ['-C', repo, '-c', 'user.name=Setup', '-c', 'user.email=setup@example.com', '-c', 'commit.gpgsign=false', ...a],
    { encoding: 'utf8' });
const g = (repo) => (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });

before(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitctl-pull-id-'));
    const origin = path.join(work, 'origin.git');
    A = path.join(work, 'A');
    const B = path.join(work, 'B');

    execFileSync('git', ['init', '-q', '--bare', origin]);
    execFileSync('git', ['clone', '-q', origin, A]); // NOTE: no user.name/email set on A
    fs.writeFileSync(path.join(A, 'flows.json'), '[]\n');
    gx(A)('add', '-A'); gx(A)('commit', '-qm', 'init');
    gx(A)('push', '-q', 'origin', 'HEAD:refs/heads/main');
    g(A)('branch', '-q', '--set-upstream-to=origin/main');

    execFileSync('git', ['clone', '-q', origin, B]);
    g(B)('checkout', '-q', '-B', 'main', 'origin/main');

    // Diverge on different files so the merge is clean (no conflict) but real.
    fs.writeFileSync(path.join(B, 'readme.txt'), 'b\n');
    gx(B)('add', '-A'); gx(B)('commit', '-qm', 'remote change'); gx(B)('push', '-q', 'origin', 'main');
    fs.writeFileSync(path.join(A, 'local.txt'), 'a\n');
    gx(A)('add', '-A'); gx(A)('commit', '-qm', 'local change');

    const RED = {
        settings: {
            userDir: work, flowFile: 'flows.json', flowFilePretty: true,
            get: () => undefined,
            getUserSettings: async () => ({ git: { user: ID } })
        },
        log: { info() {}, warn() {}, error() {} },
        auth: { needsPermission: () => (q, r, n) => n && n() },
        httpAdmin: { get() {}, post() {} }
    };
    const core = require(path.join(LIB, 'git-core'))(RED);
    svc = require(path.join(LIB, 'git-service'))(RED, core);
});

after(() => work && fs.rmSync(work, { recursive: true, force: true }));

test('pull creates a merge commit using the injected identity (no git-config user)', async () => {
    // Diverged, so a merge commit is required — confirm it with allowMerge.
    const r = await svc.pull({ repoPath: A, user: { username: 'someone' }, allowMerge: true });
    assert.equal(r.conflicted, false);
    assert.equal(r.merged, true);

    // HEAD is a merge commit (two parents)...
    const parents = g(A)('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(/\s+/);
    assert.equal(parents.length, 3, 'HEAD should be a merge commit with two parents');

    // ...authored AND committed with the injected Node-RED identity.
    assert.equal(g(A)('log', '-1', '--format=%ae').trim(), ID.email);
    assert.equal(g(A)('log', '-1', '--format=%ce').trim(), ID.email);
});
