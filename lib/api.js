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

    const repoBranchMemory = new Map();

    function getBranchNameFromStatus(status) {
        if (!status || !status.current) {
            return null;
        }
        const name = (typeof status.current === 'string') ? status.current.trim() : '';
        if (!name || name === 'HEAD') {
            return null;
        }
        return name;
    }

    // Helper to resolve repo path consistently (used for memoization)
    function resolveRepoPath(inputPath) {
        if (inputPath && typeof inputPath === 'string' && inputPath.trim() !== '') {
            return path.resolve(inputPath);
        }
        return getActiveProjectPath() || process.cwd();
    }

    function rememberBranch(repoPath, branchName) {
        if (repoPath && branchName) {
            repoBranchMemory.set(repoPath, branchName);
        }
    }

    function getRememberedBranch(repoPath) {
        if (!repoPath) {
            return null;
        }
        return repoBranchMemory.get(repoPath) || null;
    }

    function sanitizeCommitHash(hash) {
        if (!hash) {
            return null;
        }
        const trimmed = hash.trim();
        if (/^[0-9a-f]{7,}$/i.test(trimmed)) {
            return trimmed;
        }
        const extracted = trimmed.replace(/[^0-9a-f]/gi, '');
        return extracted.length >= 7 ? extracted : null;
    }

    async function createBranchFromDetachedCommit(git, commitHash) {
        const cleanHash = sanitizeCommitHash(commitHash);
        const shortHash = cleanHash ? cleanHash.substring(0, 7) : 'detached';
        const baseName = `from-${shortHash}`;
        const existing = new Set();

        try {
            const branchInfo = await git.branchLocal();
            (branchInfo.all || []).forEach(name => existing.add(name));
        } catch (err) {
            // If we can't list branches, log and continue - checkoutLocalBranch will throw if duplicate
            RED.log.warn(`Git Control: failed to list local branches: ${err.message}`);
        }

        let candidate = baseName;
        let suffix = 1;
        const MAX_SUFFIX = 100;
        while (existing.has(candidate) && suffix <= MAX_SUFFIX) {
            candidate = `${baseName}-${suffix}`;
            suffix++;
        }

        if (existing.has(candidate)) {
            throw new Error('Unable to determine unique branch name for detached commit');
        }

        await git.checkoutLocalBranch(candidate);
        return candidate;
    }

    // Helper function to get git instance with SSH key configuration
    function getGit(repoPath) {
        const targetPath = resolveRepoPath(repoPath);
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

    // Helper function to provide user-friendly error messages
    function formatGitError(error, operation) {
        const errorMessage = error.message || error.toString();

        // Common Git error patterns with user-friendly messages
        const errorPatterns = [
            {
                pattern: /merge conflict|CONFLICT/i,
                message: `Merge conflict detected during ${operation}`,
                suggestion: 'Your local changes conflict with changes from the remote. You need to:\n1. Pull the changes\n2. Resolve conflicts manually\n3. Commit the resolved changes'
            },
            {
                pattern: /uncommitted changes|would be overwritten/i,
                message: `Cannot ${operation}: You have uncommitted changes`,
                suggestion: 'Please commit or discard your changes before proceeding:\n1. Commit your changes using the commit panel\n2. Or use hard reset to discard changes (⚠️ Warning: data loss)'
            },
            {
                pattern: /branch.*already exists/i,
                message: 'A branch with this name already exists',
                suggestion: 'Please choose a different branch name or delete the existing branch first'
            },
            {
                pattern: /does not have.*commit/i,
                message: 'Invalid commit reference',
                suggestion: 'Please check the commit hash or reference. Use commit history to find valid commits.'
            },
            {
                pattern: /! \[rejected\].*\(non-fast-forward\)/i,
                message: 'Push rejected: Your branch has diverged from remote',
                suggestion: 'The remote branch has commits you don\'t have locally:\n1. Pull first to merge remote changes\n2. Then push again\n3. Or use "git push --force" if you\'re sure (⚠️ Warning: overwrites remote)'
            },
            {
                pattern: /! \[rejected\].*\(fetch first\)/i,
                message: 'Push rejected: Remote has newer commits',
                suggestion: 'Pull the remote changes first, then push:\n1. Click the Pull button\n2. Resolve any merge conflicts\n3. Click Push again'
            },
            {
                pattern: /authentication failed|Permission denied/i,
                message: 'Authentication failed',
                suggestion: 'Git authentication error:\n1. Check Node-RED SSH keys are configured\n2. Verify repository permissions\n3. Check remote URL is correct'
            },
            {
                pattern: /Network.*unreachable|Could not resolve host/i,
                message: 'Network error: Cannot reach remote repository',
                suggestion: 'Check your internet connection and verify the remote repository URL is accessible'
            },
            {
                pattern: /not a git repository/i,
                message: 'Not a git repository',
                suggestion: 'The current directory is not a git repository. Initialize git first or check the project path.'
            }
        ];

        // Find matching error pattern
        for (const {pattern, message, suggestion} of errorPatterns) {
            if (pattern.test(errorMessage)) {
                return {
                    error: message,
                    details: errorMessage,
                    suggestion: suggestion
                };
            }
        }

        // Default error format if no pattern matches
        return {
            error: `Git ${operation} failed`,
            details: errorMessage,
            suggestion: 'Check the error details above. If the issue persists, try running the operation from the command line for more information.'
        };
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
                const currentBranch = getBranchNameFromStatus(status);
                const remotes = await git.getRemotes(true);
                const userConfig = await git.raw(['config', 'user.name']).catch(() => '');
                const emailConfig = await git.raw(['config', 'user.email']).catch(() => '');
                rememberBranch(projectPath, currentBranch);
                const rememberedBranch = getRememberedBranch(projectPath);

                const projectInfo = {
                    success: true,
                    projectName: path.basename(projectPath),
                    projectPath: projectPath,
                    currentBranch: currentBranch,
                    lastKnownBranch: rememberedBranch || null,
                    remotes: remotes,
                    user: {
                        name: userConfig.trim(),
                        email: emailConfig.trim()
                    },
                    sshKeyConfigured: getSSHKeyPath() !== null,
                    tracking: status.tracking,
                    ahead: status.ahead || 0,
                    behind: status.behind || 0,
                    isDetachedHead: !currentBranch,  // Detached HEAD when no current branch
                    hasTracking: !!status.tracking
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
                const resolvedRepoPath = resolveRepoPath(repoPath);
                const git = getGit(resolvedRepoPath);
                await validateRepo(git);

                const logOptions = {
                    maxCount: parseInt(maxCount),
                    format: {
                        hash: '%H',
                        parents: '%P',  // Add parent commit hashes (space-separated)
                        date: '%ai',
                        message: '%s',
                        author: '%an',
                        email: '%ae'
                    }
                };

                if (from) logOptions.from = from;
                if (to) logOptions.to = to;

                // Enhance commits with graph data
                const status = await git.status();
                const currentBranch = getBranchNameFromStatus(status);
                rememberBranch(resolvedRepoPath, currentBranch);
                const headHash = await git.revparse(['HEAD']).catch(() => null);

                // Detect if in detached HEAD and find the parent branch
                const isDetachedHead = !currentBranch;
                let effectiveBranch = currentBranch || getRememberedBranch(resolvedRepoPath); // reuse last known branch when detached

                // Get all branches with their commit hashes (needed for branch detection)
                const branchList = await git.branch(['-v', '--no-abbrev']);

                // If in detached HEAD, find which branch contains the current HEAD commit
                if (isDetachedHead && headHash && !effectiveBranch) {
                    const commitToBranchesTemp = {};
                    Object.entries(branchList.branches).forEach(([name, info]) => {
                        // Skip remote branches for parent detection
                        if (!name.startsWith('remotes/')) {
                            const hash = info.commit;
                            if (!commitToBranchesTemp[hash]) {
                                commitToBranchesTemp[hash] = [];
                            }
                            commitToBranchesTemp[hash].push(name);
                        }
                    });

                    // Check if HEAD commit is on any branch
                    if (commitToBranchesTemp[headHash] && commitToBranchesTemp[headHash].length > 0) {
                        const branches = commitToBranchesTemp[headHash];
                        // Prefer main/master, otherwise use first branch alphabetically
                        effectiveBranch = branches.find(b => b === 'main' || b === 'master') || branches[0];
                    } else {
                        // HEAD commit not on any branch tip - find branch that contains this commit
                        // Use git branch --contains to find branches containing this commit
                        try {
                            const branchOutput = await git.raw(['branch', '--contains', headHash]);
                            const branches = branchOutput
                                .split('\n')
                                .map(line => line.trim().replace(/^\*\s*/, '')) // Remove * prefix and whitespace
                                .filter(line => line && !line.startsWith('(') && !line.includes('detached'));

                            if (branches.length > 0) {
                                effectiveBranch = branches.find(b => b === 'main' || b === 'master') || branches[0];
                            }
                        } catch (err) {
                            // If this fails, we'll use the default behavior (log from HEAD)
                        }
                    }
                }

                if (effectiveBranch) {
                    rememberBranch(resolvedRepoPath, effectiveBranch);
                }

                // Fetch commit history - use effective branch in detached HEAD to show full history
                // In detached HEAD, query the parent branch to get full history (not just up to HEAD)

                let result;
                if (isDetachedHead && effectiveBranch) {

                    // Build git log command manually for detached HEAD to include branch ref
                    const formatStr = Object.values(logOptions.format).join('%n');
                    const args = [
                        'log',
                        effectiveBranch,
                        `--max-count=${logOptions.maxCount}`,
                        `--format=${formatStr}`
                    ];
                    if (logOptions.from) args.push(`${logOptions.from}..`);
                    if (logOptions.to) args.push(`..${logOptions.to}`);


                    const rawOutput = await git.raw(args);

                    // Parse the output into commit objects (same format as git.log)
                    const commits = [];
                    const lines = rawOutput.trim().split('\n');
                    const formatKeys = Object.keys(logOptions.format);

                    for (let i = 0; i < lines.length; i += formatKeys.length) {
                        if (i + formatKeys.length <= lines.length) {
                            const commit = {};
                            formatKeys.forEach((key, idx) => {
                                commit[key] = lines[i + idx] || '';
                            });
                            commits.push(commit);
                        }
                    }

                    result = { all: commits, total: commits.length };
                } else {
                    // Normal branch - use default behavior
                    result = await git.log(logOptions);
                }

                // Get remote tracking branch commits (for pushed status detection)
                let remoteBranchCommits = new Set();
                try {
                    // Try tracking branch first
                    let remoteBranch = status.tracking;

                    // Fallback: if no tracking branch (detached HEAD), try origin/{effective-branch}
                    if (!remoteBranch && effectiveBranch) {
                        remoteBranch = `origin/${effectiveBranch}`;
                    }


                    if (remoteBranch) {
                        const remoteLog = await git.log([remoteBranch]);
                        remoteBranchCommits = new Set(remoteLog.all.map(c => c.hash));
                    }
                } catch (error) {
                    // Remote branch might not exist, that's okay
                }
                const commitToBranches = {};
                Object.entries(branchList.branches).forEach(([name, info]) => {
                    const hash = info.commit;
                    if (!commitToBranches[hash]) {
                        commitToBranches[hash] = [];
                    }
                    commitToBranches[hash].push(name);
                });

                // Enhance each commit with graph metadata
                const enhancedCommits = result.all.map(commit => {
                    return {
                        ...commit,
                        // Convert space-separated parent hashes to array
                        parents: commit.parents ? commit.parents.trim().split(/\s+/).filter(p => p) : [],
                        // Check if commit exists in remote tracking branch
                        pushed: remoteBranchCommits.has(commit.hash),
                        // Check if this is the current HEAD
                        isHead: commit.hash === headHash,
                        // Get branches pointing to this commit
                        branches: commitToBranches[commit.hash] || []
                    };
                });

                res.json({
                    success: true,
                    operation: 'log',
                    total: result.total,
                    commits: enhancedCommits
                });
            } catch (error) {
                const errorInfo = formatGitError(error, 'view history');
                res.status(500).json({
                    success: false,
                    ...errorInfo
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
                const errorInfo = formatGitError(error, 'reset');
                res.status(500).json({
                    success: false,
                    ...errorInfo
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
                const errorInfo = formatGitError(error, 'checkout');
                res.status(500).json({
                    success: false,
                    ...errorInfo
                });
            }
        }
    );

    // POST /rosepetal-git/discard - Discard changes to specific files
    RED.httpAdmin.post("/rosepetal-git/discard",
        RED.auth.needsPermission('git-control.write'),
        async function(req, res) {
            try {
                const { repoPath, files } = req.body;

                if (!files || !Array.isArray(files) || files.length === 0) {
                    throw new Error('File list is required');
                }

                const git = getGit(repoPath);
                await validateRepo(git);

                // Use git checkout -- <file> to discard changes
                const result = await git.checkout(['--', ...files]);

                res.json({
                    success: true,
                    operation: 'discard',
                    files: files,
                    result: result
                });
            } catch (error) {
                const errorInfo = formatGitError(error, 'discard changes');
                res.status(500).json({
                    success: false,
                    ...errorInfo
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
                const resolvedRepoPath = resolveRepoPath(repoPath);
                const git = getGit(resolvedRepoPath);
                await validateRepo(git);

                const result = await git.status();
                const currentBranch = getBranchNameFromStatus(result);
                rememberBranch(resolvedRepoPath, currentBranch);
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

    // POST /rosepetal-git/validate-checkout - Validate if checkout is safe
    RED.httpAdmin.post("/rosepetal-git/validate-checkout",
        RED.auth.needsPermission('git-control.read'),
        async function(req, res) {
            try {
                const { repoPath, targetRef } = req.body;
                const resolvedRepoPath = resolveRepoPath(repoPath);
                const git = getGit(resolvedRepoPath);
                await validateRepo(git);

                // Get current status
                const status = await git.status();
                const currentBranch = getBranchNameFromStatus(status);
                rememberBranch(resolvedRepoPath, currentBranch);

                // Get current HEAD ref
                const currentRef = await git.revparse(['HEAD']);

                // Check if detached HEAD
                const isDetachedHead = !currentBranch;

                // Check for uncommitted changes
                const hasUncommittedChanges = status.files && status.files.length > 0;
                const uncommittedCount = status.files ? status.files.length : 0;

                // Check for unpushed commits
                const hasUnpushedCommits = status.ahead > 0;
                const unpushedCount = status.ahead || 0;

                // Determine blockers
                const blockers = [];
                if (hasUncommittedChanges) blockers.push('uncommitted_changes');
                if (hasUnpushedCommits) blockers.push('unpushed_commits');

                // Can checkout only if no blockers
                const canCheckout = blockers.length === 0;

                res.json({
                    success: true,
                    canCheckout: canCheckout,
                    blockers: blockers,
                    uncommittedCount: uncommittedCount,
                    unpushedCount: unpushedCount,
                    isDetachedHead: isDetachedHead,
                    currentRef: currentRef,
                    targetRef: targetRef,
                    currentBranch: currentBranch || 'detached HEAD'
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

                // Get local branches
                const localBranches = result.all.filter(branch => !branch.startsWith('remotes/'));

                // Get remote branches (without remotes/ prefix)
                const remoteBranches = result.all
                    .filter(branch => branch.startsWith('remotes/origin/'))
                    .map(branch => branch.replace('remotes/origin/', ''));

                // Show remote branches that don't have a local branch yet
                const uniqueRemoteBranches = remoteBranches.filter(remote => {
                    return !localBranches.includes(remote);
                });

                // Combine: local branches + unique remote branches
                const allBranches = [...localBranches, ...uniqueRemoteBranches];

                res.json({
                    success: true,
                    operation: 'branches',
                    current: result.current,
                    all: allBranches,
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
                const errorInfo = formatGitError(error, 'fetch');
                res.status(500).json({
                    success: false,
                    ...errorInfo
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
                const errorInfo = formatGitError(error, 'pull');
                res.status(500).json({
                    success: false,
                    ...errorInfo
                });
            }
        }
    );

    // POST /rosepetal-git/push - Push to remote (auto sets upstream for new branches)
    RED.httpAdmin.post("/rosepetal-git/push",
        RED.auth.needsPermission('git-control.write'),
        async function(req, res) {
            try {
                const { repoPath } = req.body;
                const resolvedRepoPath = resolveRepoPath(repoPath);
                const git = getGit(resolvedRepoPath);
                await validateRepo(git);

                const status = await git.status();
                const currentBranch = getBranchNameFromStatus(status);

                if (!currentBranch) {
                    throw new Error('Cannot push while in detached HEAD state');
                }

                rememberBranch(resolvedRepoPath, currentBranch);

                let result;
                let setUpstream = false;

                if (status.tracking && status.tracking.includes('/')) {
                    // Branch already tracks a remote - normal push
                    result = await git.push();
                } else {
                    // No upstream tracking - set upstream automatically
                    const remotes = await git.getRemotes(true);
                    if (!remotes || remotes.length === 0) {
                        throw new Error('No Git remotes configured for this repository');
                    }

                    const defaultRemote = remotes.find(r => r.name === 'origin') || remotes[0];
                    const remoteName = defaultRemote.name;

                    result = await git.push(['-u', remoteName, currentBranch]);
                    setUpstream = true;
                }

                res.json({
                    success: true,
                    operation: 'push',
                    result: result,
                    branch: currentBranch,
                    setUpstream: setUpstream
                });
            } catch (error) {
                const errorInfo = formatGitError(error, 'push');
                res.status(500).json({
                    success: false,
                    ...errorInfo
                });
            }
        }
    );

    // POST /rosepetal-git/force-push - Force push to remote (DANGEROUS)
    RED.httpAdmin.post("/rosepetal-git/force-push",
        RED.auth.needsPermission('git-control.write'),
        async function(req, res) {
            try {
                const { repoPath, confirmed = false } = req.body;

                // Safety check: require explicit confirmation
                if (!confirmed) {
                    return res.status(400).json({
                        success: false,
                        error: 'Force push requires explicit confirmation',
                        requiresConfirmation: true
                    });
                }

                const git = getGit(repoPath);
                await validateRepo(git);

                // Use --force-with-lease for safer force push
                // It will fail if remote has commits we don't know about
                const result = await git.push(['--force-with-lease']);

                res.json({
                    success: true,
                    operation: 'force-push',
                    result: result,
                    warning: 'Force push completed - Git history has been rewritten'
                });
            } catch (error) {
                const errorInfo = formatGitError(error, 'force push');
                res.status(500).json({
                    success: false,
                    ...errorInfo
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

    // POST /rosepetal-git/unstage - Unstage files from the staging area
    RED.httpAdmin.post("/rosepetal-git/unstage",
        RED.auth.needsPermission('git-control.write'),
        async function(req, res) {
            try {
                const { repoPath, files, unstageAll = false } = req.body;
                const git = getGit(repoPath);
                await validateRepo(git);

                let result;
                if (unstageAll) {
                    // Unstage all files
                    result = await git.reset(['HEAD']);
                } else if (files && Array.isArray(files) && files.length > 0) {
                    // Unstage specific files
                    result = await git.reset(['HEAD', '--', ...files]);
                } else {
                    throw new Error('Either unstageAll or files array is required');
                }

                res.json({
                    success: true,
                    operation: 'unstage',
                    result: result
                });
            } catch (error) {
                const errorInfo = formatGitError(error, 'unstage');
                res.status(500).json({
                    success: false,
                    ...errorInfo
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

                const resolvedRepoPath = resolveRepoPath(repoPath);
                const git = getGit(resolvedRepoPath);
                await validateRepo(git);

                // Check if in detached HEAD before committing
                const statusBefore = await git.status();
                const currentBranch = getBranchNameFromStatus(statusBefore);
                rememberBranch(resolvedRepoPath, currentBranch);
                const isDetachedHead = !currentBranch;

                // Create the commit
                const result = await git.commit(message.trim());
                const headHashAfterCommit = await git.revparse(['HEAD']).catch(() => result.commit);

                // If was in detached HEAD, create and checkout a new branch
                if (isDetachedHead) {
                    const newCommitHash = headHashAfterCommit || result.commit;
                    let branchName = null;
                    let branchWarning = null;

                    try {
                        branchName = await createBranchFromDetachedCommit(git, newCommitHash);
                        rememberBranch(resolvedRepoPath, branchName);
                    } catch (branchError) {
                        branchWarning = `Commit created, but failed to create new branch automatically: ${branchError.message}`;
                        RED.log.warn(`[Git Control] ${branchWarning}`);
                    }

                    res.json({
                        success: true,
                        operation: 'commit',
                        commit: result.commit,
                        summary: result.summary,
                        branch: branchName,
                        createdBranch: !!branchName,
                        warning: branchWarning || null,
                        message: branchName
                            ? `Created commit and new branch '${branchName}'`
                            : 'Commit created while remaining in detached HEAD'
                    });
                } else {
                    rememberBranch(resolvedRepoPath, currentBranch);
                    res.json({
                        success: true,
                        operation: 'commit',
                        commit: result.commit,
                        summary: result.summary,
                        branch: result.branch,
                        createdBranch: false
                    });
                }
            } catch (error) {
                const errorInfo = formatGitError(error, 'commit');
                res.status(500).json({
                    success: false,
                    ...errorInfo
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
