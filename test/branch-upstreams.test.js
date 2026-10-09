// GET/POST /branches reports, per local branch, its upstream and how far
// ahead/behind it is (as of the last fetch), and the remotes configured.
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

before(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitctl-upstreams-'));
    origin = path.join(work, 'origin.git');
    A = path.join(work, 'A');
    execFileSync('git', ['init', '-q', '--bare', origin]);
    execFileSync('git', ['clone', '-q', origin, A]); setIdent(A);
    fs.writeFileSync(path.join(A, 'flows.json'), '[]\n');
    g(A)('add', '-A'); g(A)('commit', '-qm', 'init'); g(A)('branch', '-M', 'main'); g(A)('push', '-q', 'origin', 'HEAD:refs/heads/main');
    g(A)('branch', '-q', '--set-upstream-to=origin/main');
    // main: 1 commit ahead of origin/main
    fs.writeFileSync(path.join(A, 'flows.json'), '[{"id":"a"}]\n');
    g(A)('commit', '-qam', 'local');
    // dev: tracks origin/dev, which then gets a commit this clone fetches
    g(A)('checkout', '-q', '-b', 'dev'); g(A)('push', '-q', '-u', 'origin', 'dev');
    const B = path.join(work, 'B');
    execFileSync('git', ['clone', '-q', '-b', 'dev', origin, B]); setIdent(B);
    fs.writeFileSync(path.join(B, 'x.txt'), 'x\n'); g(B)('add', '-A'); g(B)('commit', '-qm', 'remote'); g(B)('push', '-q');
    g(A)('fetch', '-q');
    // local-only: no upstream
    g(A)('checkout', '-q', '-b', 'local-only');
    // gone: its upstream branch is deleted on the remote
    g(A)('checkout', '-q', '-b', 'old'); g(A)('push', '-q', '-u', 'origin', 'old');
    g(A)('push', '-q', 'origin', '--delete', 'old'); g(A)('fetch', '-q', '--prune');

    const RED = {
        settings: { userDir: work, flowFile: 'flows.json', flowFilePretty: true, get: () => undefined, getUserSettings: async () => null },
        log: { info() {}, warn() {}, error() {} },
        auth: { needsPermission: () => (q, r, n) => n && n() },
        httpAdmin: { get() {}, post() {} }
    };
    const core = require(path.join(LIB, 'git-core'))(RED);
    svc = require(path.join(LIB, 'git-service'))(RED, core);
});

after(() => work && fs.rmSync(work, { recursive: true, force: true }));

test('branches reports remotes and per-branch upstream, ahead, behind, gone', async () => {
    const r = await svc.getBranches({ repoPath: A });
    assert.deepStrictEqual(r.remotes, ['origin']);
    assert.deepStrictEqual(r.upstreams.main, { upstream: 'origin/main', ahead: 1, behind: 0, gone: false });
    assert.deepStrictEqual(r.upstreams.dev, { upstream: 'origin/dev', ahead: 0, behind: 1, gone: false });
    assert.deepStrictEqual(r.upstreams['local-only'], { upstream: null, ahead: 0, behind: 0, gone: false });
    assert.strictEqual(r.upstreams.old.gone, true);
});
