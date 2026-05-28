// Shared setup for the integration tests: a throwaway git repo plus a minimal
// mock of the RED runtime, wired to the real git-core / git-service modules.
// This file defines no tests; the test runner loads it as an empty test file.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LIB = path.join(__dirname, '..', 'lib');

// Build a scratch repo + mock RED + wired core/service. Pass `settings` to
// override RED.settings fields (e.g. a null getUserSettings). The returned
// object bundles the git runner, flow-file read/write helpers, and a cleanup().
function createScratch(opts = {}) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gitctl-test-'));
    const repo = path.join(work, 'repo');
    const userDir = path.join(work, 'userDir');
    fs.mkdirSync(repo);
    fs.mkdirSync(userDir);

    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'setup@example.com');
    git('config', 'user.name', 'Setup');
    git('config', 'commit.gpgsign', 'false');

    const flowPath = path.join(repo, 'flows.json');
    const writeFlows = (nodes) => fs.writeFileSync(flowPath, JSON.stringify(nodes, null, 4) + '\n');
    const readFlows = () => JSON.parse(fs.readFileSync(flowPath, 'utf8'));
    const head = () => git('rev-parse', 'HEAD').trim();

    const RED = {
        settings: Object.assign({
            userDir,
            flowFile: 'flows.json',
            flowFilePretty: true,
            get: () => undefined,
            getUserSettings: async () => ({ git: { user: { name: 'Tester', email: 'tester@example.com' } } })
        }, opts.settings || {}),
        log: { info() {}, warn() {}, error() {} },
        auth: { needsPermission: () => (req, res, next) => next && next() },
        httpAdmin: { get() {}, post() {} }
    };

    const core = require(path.join(LIB, 'git-core'))(RED);
    const svc = require(path.join(LIB, 'git-service'))(RED, core);

    const cleanup = () => fs.rmSync(work, { recursive: true, force: true });
    return { work, repo, userDir, git, flowPath, writeFlows, readFlows, head, RED, core, svc, cleanup };
}

module.exports = { createScratch, LIB };
