// Pull only signals a Node-RED resync (flowFileChanged) when the flow file
// actually changed - never on a no-op "already up to date" pull, and never for
// a pull that only touched non-flow files. Uses a real local bare remote.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { LIB } = require('./helpers');

let work, origin, A, svc;

const g = (repo) => (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
const setIdent = (repo) => {
    g(repo)('config', 'user.email', 'x@e.com');
    g(repo)('config', 'user.name', 'X');
    g(repo)('config', 'commit.gpgsign', 'false');
};
const wf = (repo, nodes) => fs.writeFileSync(path.join(repo, 'flows.json'), JSON.stringify(nodes, null, 4) + '\n');

let B; // collaborator clone

before(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitctl-pull-'));
    origin = path.join(work, 'origin.git');
    A = path.join(work, 'A'); // the "Node-RED" repo
    B = path.join(work, 'B'); // a collaborator

    execFileSync('git', ['init', '-q', '--bare', origin]);
    execFileSync('git', ['clone', '-q', origin, A]); setIdent(A);
    wf(A, [{ id: 't1', type: 'tab', label: 'one' }]);
    g(A)('add', '-A'); g(A)('commit', '-qm', 'init'); g(A)('push', '-q', 'origin', 'HEAD:refs/heads/main');
    g(A)('branch', '-q', '--set-upstream-to=origin/main');
    execFileSync('git', ['clone', '-q', origin, B]); setIdent(B);
    g(B)('checkout', '-q', '-B', 'main', 'origin/main');

    const RED = {
        settings: {
            userDir: work, flowFile: 'flows.json', flowFilePretty: true,
            get: () => undefined, getUserSettings: async () => null
        },
        log: { info() {}, warn() {}, error() {} },
        auth: { needsPermission: () => (q, r, n) => n && n() },
        httpAdmin: { get() {}, post() {} }
    };
    const core = require(path.join(LIB, 'git-core'))(RED);
    svc = require(path.join(LIB, 'git-service'))(RED, core);
});

after(() => work && fs.rmSync(work, { recursive: true, force: true }));

test('no-op pull does not signal a restart', async () => {
    const r = await svc.pull({ repoPath: A });
    assert.equal(r.changed, false);
    assert.equal(r.flowFileChanged, false);
});

test('pulling a flow-file change signals a restart', async () => {
    wf(B, [{ id: 't1', type: 'tab', label: 'one-EDITED' }]);
    g(B)('add', '-A'); g(B)('commit', '-qm', 'edit flow'); g(B)('push', '-q', 'origin', 'main');

    const r = await svc.pull({ repoPath: A });
    assert.equal(r.changed, true);
    assert.equal(r.flowFileChanged, true);
});

test('pulling a non-flow change does not signal a restart', async () => {
    fs.writeFileSync(path.join(B, 'README.md'), '# hello\n');
    g(B)('add', '-A'); g(B)('commit', '-qm', 'docs'); g(B)('push', '-q', 'origin', 'main');

    const r = await svc.pull({ repoPath: A });
    assert.equal(r.changed, true);
    assert.equal(r.flowFileChanged, false);
});

test('pushing a branch with no upstream creates the remote branch and sets upstream', async () => {
    // A brand-new local branch on A; its remote branch does not exist yet.
    g(A)('checkout', '-q', '-b', 'feature/new');
    fs.writeFileSync(path.join(A, 'feature.txt'), 'x\n');
    g(A)('add', '-A'); g(A)('commit', '-qm', 'feature work');

    const r = await svc.push({ repoPath: A });
    assert.equal(r.setUpstream, true);
    assert.equal(r.upstream, 'origin/feature/new');

    // The remote now has the branch.
    const remoteBranches = execFileSync('git', ['-C', origin, 'branch', '--format=%(refname:short)'], { encoding: 'utf8' });
    assert.match(remoteBranches, /feature\/new/);

    // A second push is now a plain push (already tracked, nothing new) — no -u.
    fs.writeFileSync(path.join(A, 'feature.txt'), 'y\n');
    g(A)('add', '-A'); g(A)('commit', '-qm', 'more');
    const r2 = await svc.push({ repoPath: A });
    assert.equal(r2.setUpstream, false);
    assert.equal(r2.upstream, 'origin/feature/new');
});

test('set-upstream points a branch at an existing remote branch', async () => {
    // The advanced upstream button drives this: a local branch gets linked.
    g(A)('checkout', '-q', '-b', 'tracker');
    const r = await svc.setUpstream({ repoPath: A, branch: 'tracker', remote: 'origin', remoteBranch: 'main' });
    assert.equal(r.upstream, 'origin/main');
    assert.equal(g(A)('rev-parse', '--abbrev-ref', 'tracker@{upstream}').trim(), 'origin/main');
});

test('push with an explicit target creates that remote branch and tracks it', async () => {
    // The tracking picker's "create origin/<name>" option drives this.
    g(A)('checkout', '-q', '-b', 'publishme'); // new local branch, no upstream
    fs.writeFileSync(path.join(A, 'pub.txt'), 'p\n');
    g(A)('add', '-A'); g(A)('commit', '-qm', 'pub');

    const r = await svc.push({ repoPath: A, targetRemote: 'origin', targetBranch: 'publishme' });
    assert.equal(r.setUpstream, true);
    assert.equal(r.upstream, 'origin/publishme');
    assert.equal(g(A)('rev-parse', '--abbrev-ref', 'publishme@{upstream}').trim(), 'origin/publishme');
    const remoteHead = execFileSync('git', ['-C', origin, 'rev-parse', 'publishme'], { encoding: 'utf8' }).trim();
    assert.equal(remoteHead, g(A)('rev-parse', 'HEAD').trim());
});

test('push to a differently-named upstream branch (push.default=simple safe)', async () => {
    g(A)('config', 'push.default', 'simple'); // the strict default that refuses name mismatches
    g(A)('checkout', '-q', '-b', 'localname'); // off current HEAD
    g(A)('push', '-q', 'origin', 'HEAD:refs/heads/remotename'); // create the differently-named remote branch
    g(A)('branch', '--set-upstream-to=origin/remotename', 'localname');

    fs.writeFileSync(path.join(A, 'mismatch.txt'), 'm\n');
    g(A)('add', '-A'); g(A)('commit', '-qm', 'mismatch work');

    const r = await svc.push({ repoPath: A });
    assert.equal(r.upstream, 'origin/remotename');
    // The remote branch advanced to our commit (a bare `git push` would have refused).
    const remoteHead = execFileSync('git', ['-C', origin, 'rev-parse', 'remotename'], { encoding: 'utf8' }).trim();
    assert.equal(remoteHead, g(A)('rev-parse', 'HEAD').trim());
});

test('rename realigns the upstream: tracks origin/<new> if it exists, else unset (no stale link)', async () => {
    // A new local branch with no published upstream → after rename, upstream must
    // not silently keep tracking the old name. Default `git branch -m` leaves it
    // stale; the service explicitly drops it so the next push creates origin/<new>.
    g(A)('checkout', '-q', 'main');         // be on main so the new branch starts there
    g(A)('checkout', '-q', '-b', 'rn-old');
    fs.writeFileSync(path.join(A, 'rn.txt'), '1\n');
    g(A)('add', '-A'); g(A)('commit', '-qm', 'rn');

    let r = await svc.renameBranch({ repoPath: A, from: 'rn-old', to: 'rn-new' });
    assert.equal(r.upstream, null);
    let hasUp = true;
    try { g(A)('rev-parse', '--abbrev-ref', 'rn-new@{upstream}'); } catch (e) { hasUp = false; }
    assert.equal(hasUp, false, 'renamed branch should have no upstream when origin/<new> does not exist');

    // Publish it under the new name, then rename to a name whose origin/<name>
    // already exists — upstream should switch to that pre-existing remote ref.
    await svc.push({ repoPath: A });
    assert.equal(g(A)('rev-parse', '--abbrev-ref', 'rn-new@{upstream}').trim(), 'origin/rn-new');

    g(B)('checkout', '-q', '-b', 'rn-target', 'main');
    g(B)('push', '-q', 'origin', 'rn-target');
    g(A)('fetch', '-q', 'origin');

    r = await svc.renameBranch({ repoPath: A, from: 'rn-new', to: 'rn-target' });
    assert.equal(r.upstream, 'origin/rn-target');
    assert.equal(g(A)('rev-parse', '--abbrev-ref', 'rn-target@{upstream}').trim(), 'origin/rn-target');
});

test('pull defaults to the same-named remote branch when no upstream is set', async () => {
    // B publishes a branch; A gets a local branch of the same name with NO upstream.
    g(B)('checkout', '-q', '-b', 'shared', 'main');
    fs.writeFileSync(path.join(B, 'shared.txt'), 's\n');
    g(B)('add', '-A'); g(B)('commit', '-qm', 'shared work'); g(B)('push', '-q', 'origin', 'shared');

    g(A)('fetch', '-q', 'origin');
    g(A)('branch', '--no-track', 'shared', 'origin/main'); // local shared, behind origin/shared, no upstream
    g(A)('checkout', '-q', 'shared');
    let hasUpstream = true;
    try { g(A)('rev-parse', '--abbrev-ref', 'shared@{upstream}'); } catch (e) { hasUpstream = false; }
    assert.equal(hasUpstream, false, 'precondition: local shared has no upstream');

    const r = await svc.pull({ repoPath: A, user: { username: 'u' } });
    // It linked the same-named remote automatically and fast-forwarded (no prompt).
    assert.equal(g(A)('rev-parse', '--abbrev-ref', 'shared@{upstream}').trim(), 'origin/shared');
    assert.equal(r.conflicted, false);
    assert.equal(r.needsMerge, undefined);
});
