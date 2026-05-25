/**
 * Node-RED Git Control API
 * HTTP admin routes for git operations, integrated with Node-RED Projects.
 *
 * This file is intentionally thin: it registers routes, validates the request,
 * delegates the work to git-service, and shapes the JSON response. All git
 * logic lives in git-service.js (operations) and git-core.js (execution layer).
 */
module.exports = function(RED) {
    const core = require('./git-core')(RED);
    const svc = require('./git-service')(RED, core);

    const read = RED.auth.needsPermission('git-control.read');
    const write = RED.auth.needsPermission('git-control.write');

    // Send an error response, reproducing each endpoint's chosen error style:
    //   - a service error carrying responseBody is sent verbatim (4xx policy)
    //   - mode 'remote'/'git' runs the matching formatter (with suggestions)
    //   - mode 'plain' sends just the raw message
    function fail(res, error, label, mode) {
        if (error.responseBody) {
            return res.status(error.statusCode || 400).json(error.responseBody);
        }
        let info;
        if (mode === 'remote') {
            info = core.formatRemoteError(error, label);
        } else if (mode === 'git') {
            info = core.formatGitError(error, label);
        } else {
            info = { error: error.message };
        }
        res.status(error.statusCode || 500).json({ success: false, ...info });
    }

    // GET /rosepetal-git/project-info - Active project + git state
    RED.httpAdmin.get("/rosepetal-git/project-info", read, async function(req, res) {
        try {
            res.json(await svc.getProjectInfo({ user: req.user }));
        } catch (error) {
            fail(res, error, 'project info', 'plain');
        }
    });

    // POST /rosepetal-git/log - Commit history (with graph metadata)
    RED.httpAdmin.post("/rosepetal-git/log", write, async function(req, res) {
        try {
            res.json(await svc.getLog(req.body || {}));
        } catch (error) {
            fail(res, error, 'view history', 'git');
        }
    });

    // POST /rosepetal-git/reset - Reset to commit (soft/mixed/hard)
    RED.httpAdmin.post("/rosepetal-git/reset", write, async function(req, res) {
        try {
            res.json(await svc.reset(req.body || {}));
        } catch (error) {
            fail(res, error, 'reset', 'git');
        }
    });

    // POST /rosepetal-git/checkout - Checkout commit/branch
    RED.httpAdmin.post("/rosepetal-git/checkout", write, async function(req, res) {
        try {
            res.json(await svc.checkout(req.body || {}));
        } catch (error) {
            fail(res, error, 'checkout', 'git');
        }
    });

    // POST /rosepetal-git/discard - Discard changes to specific files
    RED.httpAdmin.post("/rosepetal-git/discard", write, async function(req, res) {
        try {
            res.json(await svc.discard(req.body || {}));
        } catch (error) {
            fail(res, error, 'discard changes', 'git');
        }
    });

    // POST /rosepetal-git/status - Working tree status
    RED.httpAdmin.post("/rosepetal-git/status", read, async function(req, res) {
        try {
            res.json(await svc.getStatus(req.body || {}));
        } catch (error) {
            fail(res, error, 'status', 'plain');
        }
    });

    // POST /rosepetal-git/validate-checkout - Is a checkout safe?
    RED.httpAdmin.post("/rosepetal-git/validate-checkout", read, async function(req, res) {
        try {
            res.json(await svc.validateCheckout(req.body || {}));
        } catch (error) {
            fail(res, error, 'validate checkout', 'plain');
        }
    });

    // POST /rosepetal-git/branches - List branches
    RED.httpAdmin.post("/rosepetal-git/branches", read, async function(req, res) {
        try {
            res.json(await svc.getBranches(req.body || {}));
        } catch (error) {
            fail(res, error, 'branches', 'plain');
        }
    });

    // POST /rosepetal-git/show - Show commit details
    RED.httpAdmin.post("/rosepetal-git/show", read, async function(req, res) {
        try {
            res.json(await svc.show(req.body || {}));
        } catch (error) {
            fail(res, error, 'show', 'plain');
        }
    });

    // POST /rosepetal-git/fetch - Fetch from remote
    RED.httpAdmin.post("/rosepetal-git/fetch", write, async function(req, res) {
        try {
            res.json(await svc.fetch(req.body || {}));
        } catch (error) {
            fail(res, error, 'fetch', 'remote');
        }
    });

    // POST /rosepetal-git/pull - Pull from remote
    RED.httpAdmin.post("/rosepetal-git/pull", write, async function(req, res) {
        try {
            res.json(await svc.pull(req.body || {}));
        } catch (error) {
            fail(res, error, 'pull', 'remote');
        }
    });

    // POST /rosepetal-git/push - Push to remote (auto sets upstream for new branches)
    RED.httpAdmin.post("/rosepetal-git/push", write, async function(req, res) {
        try {
            res.json(await svc.push(req.body || {}));
        } catch (error) {
            fail(res, error, 'push', 'remote');
        }
    });

    // POST /rosepetal-git/force-push - Force push with --force-with-lease (DANGEROUS)
    RED.httpAdmin.post("/rosepetal-git/force-push", write, async function(req, res) {
        const { confirmed = false } = req.body || {};
        if (!confirmed) {
            return res.status(400).json({
                success: false,
                error: 'Force push requires explicit confirmation',
                requiresConfirmation: true
            });
        }
        try {
            res.json(await svc.forcePush(req.body || {}));
        } catch (error) {
            fail(res, error, 'force push', 'remote');
        }
    });

    // GET /rosepetal-git/ssh-keys - List SSH keys + current selection
    RED.httpAdmin.get("/rosepetal-git/ssh-keys", read, function(req, res) {
        try {
            res.json(svc.getSshKeyInfo({}));
        } catch (error) {
            fail(res, error, 'ssh keys', 'plain');
        }
    });

    // POST /rosepetal-git/ssh-key - Select the SSH key for the active project
    RED.httpAdmin.post("/rosepetal-git/ssh-key", write, function(req, res) {
        try {
            res.json(svc.selectSshKey(req.body || {}));
        } catch (error) {
            fail(res, error, 'ssh key', 'plain');
        }
    });

    // POST /rosepetal-git/add - Stage files for commit
    RED.httpAdmin.post("/rosepetal-git/add", write, async function(req, res) {
        try {
            res.json(await svc.add(req.body || {}));
        } catch (error) {
            fail(res, error, 'add', 'plain');
        }
    });

    // POST /rosepetal-git/unstage - Unstage files from the staging area
    RED.httpAdmin.post("/rosepetal-git/unstage", write, async function(req, res) {
        try {
            res.json(await svc.unstage(req.body || {}));
        } catch (error) {
            fail(res, error, 'unstage', 'git');
        }
    });

    // POST /rosepetal-git/commit - Create a new commit
    RED.httpAdmin.post("/rosepetal-git/commit", write, async function(req, res) {
        try {
            res.json(await svc.commit({ ...(req.body || {}), user: req.user }));
        } catch (error) {
            fail(res, error, 'commit', 'git');
        }
    });

    RED.log.info("Git Control API endpoints registered");
};
