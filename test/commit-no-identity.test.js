// With no identity in Node-RED settings and none in any git config scope, we
// must still run the commit and let git resolve the author itself (what
// Node-RED's own projects feature does) instead of refusing up front.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createScratch } = require('./helpers');

// Isolate from the developer's ~/.gitconfig and /etc/gitconfig, then hand git
// an identity through the environment - the same channel it auto-detects from.
// GIT_AUTHOR_* outranks `-c user.name`, so only the no-identity case sets it.
const ENV = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Env Author',
    GIT_AUTHOR_EMAIL: 'env@example.com',
    GIT_COMMITTER_NAME: 'Env Author',
    GIT_COMMITTER_EMAIL: 'env@example.com'
};

async function withEnv(fn) {
    const saved = {};
    for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
    try { return await fn(); }
    finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
}

test('commit succeeds with no configured identity, using git\'s own', async () => {
    await withEnv(async () => {
        const ctx = createScratch({ settings: { getUserSettings: async () => ({}) } });
        try {
            ctx.git('config', '--unset', 'user.name');
            ctx.git('config', '--unset', 'user.email');
            ctx.writeFlows([{ id: 't1', type: 'tab', label: 'Main' }]);

            const res = await ctx.svc.commit({ repoPath: ctx.repo, message: 'no identity', stageAll: true });
            assert.equal(res.success, true);
            assert.equal(ctx.git('log', '-1', '--format=%an <%ae>').trim(), 'Env Author <env@example.com>');
        } finally {
            ctx.cleanup();
        }
    });
});

test('a configured identity still wins over git\'s own', async () => {
    const ctx = createScratch();  // helpers wire Node-RED settings to Tester
    try {
        ctx.writeFlows([{ id: 't1', type: 'tab', label: 'Main' }]);
        await ctx.svc.commit({ repoPath: ctx.repo, message: 'settings identity', stageAll: true });
        assert.equal(ctx.git('log', '-1', '--format=%an <%ae>').trim(), 'Tester <tester@example.com>');
    } finally {
        ctx.cleanup();
    }
});
