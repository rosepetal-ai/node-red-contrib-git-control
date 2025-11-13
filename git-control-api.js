/**
 * Node-RED Git Control API
 * Backend API endpoints for git operations
 * Integrated with Node-RED Projects for seamless git workflow
 */

module.exports = function(RED) {
    const simpleGit = require('simple-git');
    const path = require('path');
    const fs = require('fs');

    // Helper function to get active Node-RED project path
    function getActiveProjectPath() {
        try {
            // Try to get the active project from Node-RED settings
            const settings = RED.settings;
            const projectsDir = path.resolve(path.join(settings.userDir, "projects"));

            // Read the active project from settings
            const projectsSettings = settings.get('projects');
            if (projectsSettings && projectsSettings.activeProject) {
                return path.join(projectsDir, projectsSettings.activeProject);
            }

            // Fallback: try to detect from flow file location
            if (settings.flowFile) {
                const flowDir = path.dirname(path.resolve(settings.flowFile));
                if (flowDir.includes('/projects/')) {
                    return flowDir;
                }
            }

            return null;
        } catch (error) {
            RED.log.warn("Could not determine active project: " + error.message);
            return null;
        }
    }

    // Helper function to get SSH key path for Node-RED projects
    function getSSHKeyPath() {
        try {
            const settings = RED.settings;
            const sshKeysDir = path.resolve(path.join(settings.userDir, "projects", ".sshkeys"));
            const defaultKeyPath = path.join(sshKeysDir, "__default_NodeRedTest");

            // Check if the default key exists
            if (fs.existsSync(defaultKeyPath)) {
                return defaultKeyPath;
            }

            return null;
        } catch (error) {
            RED.log.warn("Could not determine SSH key path: " + error.message);
            return null;
        }
    }

    // Helper function to get git instance with SSH key configuration
    function getGit(repoPath) {
        const targetPath = repoPath || getActiveProjectPath() || process.cwd();
        const sshKeyPath = getSSHKeyPath();

        // Configure git with SSH key if available
        const gitOptions = {
            baseDir: targetPath,
            binary: 'git',
            maxConcurrentProcesses: 6
        };

        // Set GIT_SSH_COMMAND to use Node-RED's SSH key
        if (sshKeyPath) {
            gitOptions.config = [
                `core.sshCommand=ssh -i "${sshKeyPath}" -F /dev/null`
            ];
        }

        return simpleGit(gitOptions);
    }

    // Helper function to check if path is a repo
    async function validateRepo(git) {
        const isRepo = await git.checkIsRepo();
        if (!isRepo) {
            throw new Error('Path is not a git repository');
        }
    }

    // GET /rosepetal-git/project-info - Get current Node-RED project info
    RED.httpAdmin.get("/rosepetal-git/project-info",
        RED.auth.needsPermission('git-control.read'),
        async function(req, res) {
            try {
                const projectPath = getActiveProjectPath();

                if (!projectPath) {
                    return res.json({
                        success: false,
                        error: 'No active Node-RED project found'
                    });
                }

                const git = getGit(projectPath);
                const isRepo = await git.checkIsRepo();

                if (!isRepo) {
                    return res.json({
                        success: false,
                        error: 'Active project is not a git repository'
                    });
                }

                // Get git configuration
                const status = await git.status();
                const remotes = await git.getRemotes(true);
                const userConfig = await git.raw(['config', 'user.name']).catch(() => '');
                const emailConfig = await git.raw(['config', 'user.email']).catch(() => '');

                const projectInfo = {
                    success: true,
                    projectName: path.basename(projectPath),
                    projectPath: projectPath,
                    currentBranch: status.current,
                    remotes: remotes,
                    user: {
                        name: userConfig.trim(),
                        email: emailConfig.trim()
                    },
                    sshKeyConfigured: getSSHKeyPath() !== null,
                    tracking: status.tracking,
                    ahead: status.ahead || 0,
                    behind: status.behind || 0
                };

                res.json(projectInfo);
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        }
    );

    // POST /rosepetal-git/log - Get commit history
    RED.httpAdmin.post("/rosepetal-git/log",
        RED.auth.needsPermission('git-control.write'),
        async function(req, res) {
            try {
                const { repoPath, maxCount = 20, from, to } = req.body;
                const git = getGit(repoPath);
                await validateRepo(git);

                const logOptions = {
                    maxCount: parseInt(maxCount),
                    format: {
                        hash: '%H',
                        date: '%ai',
                        message: '%s',
                        author: '%an',
                        email: '%ae'
                    }
                };

                if (from) logOptions.from = from;
                if (to) logOptions.to = to;

                const result = await git.log(logOptions);
                res.json({
                    success: true,
                    operation: 'log',
                    total: result.total,
                    commits: result.all
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        }
    );

    // POST /rosepetal-git/reset - Reset to commit
    RED.httpAdmin.post("/rosepetal-git/reset",
        RED.auth.needsPermission('git-control.write'),
        async function(req, res) {
            try {
                const { repoPath, commitRef, resetMode = 'mixed', safeMode = true } = req.body;

                if (!commitRef) {
                    throw new Error('Commit reference is required');
                }

                if (resetMode === 'hard' && safeMode) {
                    throw new Error('Hard reset is disabled in safe mode');
                }

                const git = getGit(repoPath);
                await validateRepo(git);

                const result = await git.reset([`--${resetMode}`, commitRef]);
                res.json({
                    success: true,
                    operation: 'reset',
                    mode: resetMode,
                    commit: commitRef,
                    result: result
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        }
    );

    // POST /rosepetal-git/checkout - Checkout commit/branch
    RED.httpAdmin.post("/rosepetal-git/checkout",
        RED.auth.needsPermission('git-control.write'),
        async function(req, res) {
            try {
                const { repoPath, commitRef } = req.body;

                if (!commitRef) {
                    throw new Error('Commit reference is required');
                }

                const git = getGit(repoPath);
                await validateRepo(git);

                const result = await git.checkout(commitRef);
                res.json({
                    success: true,
                    operation: 'checkout',
                    ref: commitRef,
                    result: result
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        }
    );

    // POST /rosepetal-git/status - Get status
    RED.httpAdmin.post("/rosepetal-git/status",
        RED.auth.needsPermission('git-control.read'),
        async function(req, res) {
            try {
                const { repoPath } = req.body;
                const git = getGit(repoPath);
                await validateRepo(git);

                const result = await git.status();
                res.json({
                    success: true,
                    operation: 'status',
                    status: result
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        }
    );

    // POST /rosepetal-git/branches - List branches
    RED.httpAdmin.post("/rosepetal-git/branches",
        RED.auth.needsPermission('git-control.read'),
        async function(req, res) {
            try {
                const { repoPath } = req.body;
                const git = getGit(repoPath);
                await validateRepo(git);

                const result = await git.branch();
                res.json({
                    success: true,
                    operation: 'branches',
                    current: result.current,
                    all: result.all,
                    branches: result.branches
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        }
    );

    // POST /rosepetal-git/show - Show commit details
    RED.httpAdmin.post("/rosepetal-git/show",
        RED.auth.needsPermission('git-control.read'),
        async function(req, res) {
            try {
                const { repoPath, commitRef } = req.body;

                if (!commitRef) {
                    throw new Error('Commit reference is required');
                }

                const git = getGit(repoPath);
                await validateRepo(git);

                const result = await git.show(commitRef);
                res.json({
                    success: true,
                    operation: 'show',
                    commit: commitRef,
                    details: result
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        }
    );

    // POST /rosepetal-git/fetch - Fetch from remote
    RED.httpAdmin.post("/rosepetal-git/fetch",
        RED.auth.needsPermission('git-control.write'),
        async function(req, res) {
            try {
                const { repoPath } = req.body;
                const git = getGit(repoPath);
                await validateRepo(git);

                const result = await git.fetch();
                res.json({
                    success: true,
                    operation: 'fetch',
                    result: result
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        }
    );

    // POST /rosepetal-git/pull - Pull from remote
    RED.httpAdmin.post("/rosepetal-git/pull",
        RED.auth.needsPermission('git-control.write'),
        async function(req, res) {
            try {
                const { repoPath } = req.body;
                const git = getGit(repoPath);
                await validateRepo(git);

                const result = await git.pull();
                res.json({
                    success: true,
                    operation: 'pull',
                    result: result
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        }
    );

    // POST /rosepetal-git/push - Push to remote
    RED.httpAdmin.post("/rosepetal-git/push",
        RED.auth.needsPermission('git-control.write'),
        async function(req, res) {
            try {
                const { repoPath } = req.body;
                const git = getGit(repoPath);
                await validateRepo(git);

                const result = await git.push();
                res.json({
                    success: true,
                    operation: 'push',
                    result: result
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        }
    );

    // POST /rosepetal-git/add - Stage files for commit
    RED.httpAdmin.post("/rosepetal-git/add",
        RED.auth.needsPermission('git-control.write'),
        async function(req, res) {
            try {
                const { repoPath, files, stageAll = false } = req.body;
                const git = getGit(repoPath);
                await validateRepo(git);

                let result;
                if (stageAll) {
                    // Stage all changes
                    result = await git.add('.');
                } else if (files && Array.isArray(files)) {
                    // Stage specific files
                    result = await git.add(files);
                } else {
                    throw new Error('Either stageAll or files array is required');
                }

                res.json({
                    success: true,
                    operation: 'add',
                    result: result
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        }
    );

    // POST /rosepetal-git/commit - Create a new commit
    RED.httpAdmin.post("/rosepetal-git/commit",
        RED.auth.needsPermission('git-control.write'),
        async function(req, res) {
            try {
                const { repoPath, message } = req.body;

                if (!message || message.trim() === '') {
                    throw new Error('Commit message is required');
                }

                const git = getGit(repoPath);
                await validateRepo(git);

                const result = await git.commit(message.trim());
                res.json({
                    success: true,
                    operation: 'commit',
                    commit: result.commit,
                    summary: result.summary,
                    branch: result.branch
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        }
    );

    // POST /rosepetal-git/read-flows - Read flows.json from disk
    RED.httpAdmin.post("/rosepetal-git/read-flows",
        RED.auth.needsPermission('git-control.read'),
        async function(req, res) {
            try {
                const projectPath = getActiveProjectPath();

                if (!projectPath) {
                    throw new Error('No active Node-RED project found');
                }

                // Read flows.json directly from disk
                const flowsPath = path.join(projectPath, 'flows.json');

                if (!fs.existsSync(flowsPath)) {
                    throw new Error('flows.json not found in project');
                }

                const flowsContent = fs.readFileSync(flowsPath, 'utf8');
                const flows = JSON.parse(flowsContent);

                res.json({
                    success: true,
                    flows: flows
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        }
    );

    RED.log.info("Git Control API endpoints registered");
};
