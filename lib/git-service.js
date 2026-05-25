/**
 * Git Control - operations service
 *
 * One function per git operation, built on the core execution layer. Functions
 * take a plain params object and RETURN the response body, or THROW on failure.
 * They know nothing about HTTP - the routes in api.js translate to/from req/res
 * and pick the error formatter. Thrown errors may carry:
 *   - statusCode:   HTTP status the route should use (default 500)
 *   - responseBody: a complete JSON body to send as-is (for 4xx policy errors)
 */
module.exports = function(RED, core) {
    const path = require('path');

    // Build an error that the route should send verbatim with a given status.
    function httpError(statusCode, body) {
        const err = new Error(body.error || 'Request failed');
        err.statusCode = statusCode;
        err.responseBody = body;
        return err;
    }

    async function getProjectInfo({ user } = {}) {
        const projectPath = core.getActiveProjectPath();
        if (!projectPath) {
            return { success: false, error: 'No active Node-RED project found' };
        }

        const git = core.getGit(projectPath);
        const isRepo = await git.checkIsRepo();
        if (!isRepo) {
            return { success: false, error: 'Active project is not a git repository' };
        }

        const status = await git.status();
        const currentBranch = core.getBranchNameFromStatus(status);
        const remotes = await git.getRemotes(true);

        const nodeRedGitSettings = await core.getGitUserSettings(user);
        let userName, userEmail;
        if (nodeRedGitSettings) {
            userName = nodeRedGitSettings.name;
            userEmail = nodeRedGitSettings.email;
        } else {
            userName = (await git.raw(['config', 'user.name']).catch(() => '')).trim();
            userEmail = (await git.raw(['config', 'user.email']).catch(() => '')).trim();
        }

        core.rememberBranch(projectPath, currentBranch);
        const rememberedBranch = core.getRememberedBranch(projectPath);

        return {
            success: true,
            projectName: path.basename(projectPath),
            projectPath: projectPath,
            currentBranch: currentBranch,
            lastKnownBranch: rememberedBranch || null,
            remotes: remotes,
            user: { name: userName, email: userEmail },
            sshKeyConfigured: core.getSSHKeyPath() !== null,
            tracking: status.tracking,
            ahead: status.ahead || 0,
            behind: status.behind || 0,
            isDetachedHead: !currentBranch,
            hasTracking: !!status.tracking
        };
    }

    async function getLog({ repoPath, maxCount = 20, from, to } = {}) {
        const resolvedRepoPath = core.resolveRepoPath(repoPath);
        const git = core.getGit(resolvedRepoPath);
        await core.validateRepo(git);

        const logOptions = {
            maxCount: parseInt(maxCount),
            format: {
                hash: '%H',
                parents: '%P',
                date: '%ai',
                message: '%s',
                author: '%an',
                email: '%ae'
            }
        };

        if (from) logOptions.from = from;
        if (to) logOptions.to = to;

        const status = await git.status();
        const currentBranch = core.getBranchNameFromStatus(status);
        core.rememberBranch(resolvedRepoPath, currentBranch);
        const headHash = await git.revparse(['HEAD']).catch(() => null);

        const isDetachedHead = !currentBranch;
        let effectiveBranch = currentBranch || core.getRememberedBranch(resolvedRepoPath);

        const branchList = await git.branch(['-v', '--no-abbrev']);

        if (isDetachedHead && headHash && !effectiveBranch) {
            const commitToBranchesTemp = {};
            Object.entries(branchList.branches).forEach(([name, info]) => {
                if (!name.startsWith('remotes/')) {
                    const hash = info.commit;
                    if (!commitToBranchesTemp[hash]) {
                        commitToBranchesTemp[hash] = [];
                    }
                    commitToBranchesTemp[hash].push(name);
                }
            });

            if (commitToBranchesTemp[headHash] && commitToBranchesTemp[headHash].length > 0) {
                const branches = commitToBranchesTemp[headHash];
                effectiveBranch = branches.find(b => b === 'main' || b === 'master') || branches[0];
            } else {
                try {
                    const branchOutput = await git.raw(['branch', '--contains', headHash]);
                    const branches = branchOutput
                        .split('\n')
                        .map(line => line.trim().replace(/^\*\s*/, ''))
                        .filter(line => line && !line.startsWith('(') && !line.includes('detached'));

                    if (branches.length > 0) {
                        effectiveBranch = branches.find(b => b === 'main' || b === 'master') || branches[0];
                    }
                } catch (err) {
                    // Fall back to default behavior (log from HEAD)
                }
            }
        }

        if (effectiveBranch) {
            core.rememberBranch(resolvedRepoPath, effectiveBranch);
        }

        let result;
        if (isDetachedHead && effectiveBranch) {
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
            result = await git.log(logOptions);
        }

        let remoteBranchCommits = new Set();
        try {
            let remoteBranch = status.tracking;
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

        // Branch labels: drop the verbose "remotes/" prefix (remotes/origin/x
        // -> origin/x) and de-duplicate so labels stay readable.
        const cleanBranchName = name => name.replace(/^remotes\//, '');

        const enhancedCommits = result.all.map(commit => {
            return {
                ...commit,
                parents: commit.parents ? commit.parents.trim().split(/\s+/).filter(p => p) : [],
                pushed: remoteBranchCommits.has(commit.hash),
                isHead: commit.hash === headHash,
                branches: [...new Set((commitToBranches[commit.hash] || []).map(cleanBranchName))]
            };
        });

        return {
            success: true,
            operation: 'log',
            total: result.total,
            commits: enhancedCommits
        };
    }

    async function reset({ repoPath, commitRef, resetMode = 'mixed', safeMode = true } = {}) {
        if (!commitRef) {
            throw new Error('Commit reference is required');
        }
        if (resetMode === 'hard' && safeMode) {
            throw new Error('Hard reset is disabled in safe mode');
        }

        const git = core.getGit(repoPath);
        await core.validateRepo(git);

        const result = await git.reset([`--${resetMode}`, commitRef]);
        return {
            success: true,
            operation: 'reset',
            mode: resetMode,
            commit: commitRef,
            result: result
        };
    }

    async function checkout({ repoPath, commitRef } = {}) {
        if (!commitRef) {
            throw new Error('Commit reference is required');
        }

        const git = core.getGit(repoPath);
        await core.validateRepo(git);

        const result = await git.checkout(commitRef);
        return {
            success: true,
            operation: 'checkout',
            ref: commitRef,
            result: result
        };
    }

    async function discard({ repoPath, files } = {}) {
        if (!files || !Array.isArray(files) || files.length === 0) {
            throw new Error('File list is required');
        }

        const git = core.getGit(repoPath);
        await core.validateRepo(git);

        // Tracked files are restored from HEAD/index (git checkout --), but that
        // is a no-op for untracked files, which must instead be removed (git
        // clean -fd). Partition by what git reports as untracked.
        const status = await git.status();
        const untrackedSet = new Set(status.not_added || []);
        const tracked = files.filter(f => !untrackedSet.has(f));
        const untracked = files.filter(f => untrackedSet.has(f));

        if (tracked.length) {
            await git.checkout(['--', ...tracked]);
        }
        if (untracked.length) {
            // Respects .gitignore (no -x), so ignored files are never touched.
            await git.raw(['clean', '-fd', '--', ...untracked]);
        }

        return {
            success: true,
            operation: 'discard',
            files: files,
            restored: tracked,
            removed: untracked
        };
    }

    async function getStatus({ repoPath } = {}) {
        const resolvedRepoPath = core.resolveRepoPath(repoPath);
        const git = core.getGit(resolvedRepoPath);
        await core.validateRepo(git);

        const result = await git.status();
        const currentBranch = core.getBranchNameFromStatus(result);
        core.rememberBranch(resolvedRepoPath, currentBranch);
        return {
            success: true,
            operation: 'status',
            status: result
        };
    }

    async function validateCheckout({ repoPath, targetRef } = {}) {
        const resolvedRepoPath = core.resolveRepoPath(repoPath);
        const git = core.getGit(resolvedRepoPath);
        await core.validateRepo(git);

        const status = await git.status();
        const currentBranch = core.getBranchNameFromStatus(status);
        core.rememberBranch(resolvedRepoPath, currentBranch);

        const currentRef = await git.revparse(['HEAD']);
        const isDetachedHead = !currentBranch;

        const hasUncommittedChanges = status.files && status.files.length > 0;
        const uncommittedCount = status.files ? status.files.length : 0;

        const hasUnpushedCommits = status.ahead > 0;
        const unpushedCount = status.ahead || 0;

        const blockers = [];
        if (hasUncommittedChanges) blockers.push('uncommitted_changes');
        if (hasUnpushedCommits) blockers.push('unpushed_commits');

        const canCheckout = blockers.length === 0;

        return {
            success: true,
            canCheckout: canCheckout,
            blockers: blockers,
            uncommittedCount: uncommittedCount,
            unpushedCount: unpushedCount,
            isDetachedHead: isDetachedHead,
            currentRef: currentRef,
            targetRef: targetRef,
            currentBranch: currentBranch || 'detached HEAD'
        };
    }

    async function getBranches({ repoPath } = {}) {
        const git = core.getGit(repoPath);
        await core.validateRepo(git);

        const result = await git.branch();

        const localBranches = result.all.filter(branch => !branch.startsWith('remotes/'));
        const remoteBranches = result.all
            .filter(branch => branch.startsWith('remotes/origin/'))
            .map(branch => branch.replace('remotes/origin/', ''));
        const uniqueRemoteBranches = remoteBranches.filter(remote => !localBranches.includes(remote));
        const allBranches = [...localBranches, ...uniqueRemoteBranches];

        return {
            success: true,
            operation: 'branches',
            current: result.current,
            all: allBranches,
            branches: result.branches
        };
    }

    async function show({ repoPath, commitRef } = {}) {
        if (!commitRef) {
            throw new Error('Commit reference is required');
        }

        const git = core.getGit(repoPath);
        await core.validateRepo(git);

        const result = await git.show(commitRef);
        return {
            success: true,
            operation: 'show',
            commit: commitRef,
            details: result
        };
    }

    async function fetch({ repoPath } = {}) {
        const resolvedRepoPath = core.resolveRepoPath(repoPath);
        const git = core.getGit(resolvedRepoPath);
        await core.validateRepo(git);

        const remote = core.getRemoteGit(resolvedRepoPath, core.resolveRemoteAuth(resolvedRepoPath));
        await remote.raw(['fetch', '--prune']);
        return {
            success: true,
            operation: 'fetch'
        };
    }

    async function pull({ repoPath } = {}) {
        const resolvedRepoPath = core.resolveRepoPath(repoPath);
        const git = core.getGit(resolvedRepoPath);
        await core.validateRepo(git);

        const remote = core.getRemoteGit(resolvedRepoPath, core.resolveRemoteAuth(resolvedRepoPath));
        const output = await remote.raw(['pull', '--no-rebase']);
        return {
            success: true,
            operation: 'pull',
            result: (output || '').trim()
        };
    }

    async function push({ repoPath } = {}) {
        const resolvedRepoPath = core.resolveRepoPath(repoPath);
        const git = core.getGit(resolvedRepoPath);
        await core.validateRepo(git);

        const status = await git.status();
        const currentBranch = core.getBranchNameFromStatus(status);

        if (!currentBranch) {
            throw new Error('Cannot push while in detached HEAD state');
        }

        core.rememberBranch(resolvedRepoPath, currentBranch);

        const remote = core.getRemoteGit(resolvedRepoPath, core.resolveRemoteAuth(resolvedRepoPath));
        let setUpstream = false;

        if (status.tracking && status.tracking.includes('/')) {
            await remote.raw(['push']);
        } else {
            const remotes = await git.getRemotes(true);
            if (!remotes || remotes.length === 0) {
                throw new Error('No Git remotes configured for this repository');
            }

            const defaultRemote = remotes.find(r => r.name === 'origin') || remotes[0];
            const remoteName = defaultRemote.name;

            await remote.raw(['push', '-u', remoteName, currentBranch]);
            setUpstream = true;
        }

        return {
            success: true,
            operation: 'push',
            branch: currentBranch,
            setUpstream: setUpstream
        };
    }

    async function forcePush({ repoPath } = {}) {
        const resolvedRepoPath = core.resolveRepoPath(repoPath);
        const git = core.getGit(resolvedRepoPath);
        await core.validateRepo(git);

        // --force-with-lease fails if the remote has commits we don't know about
        const remote = core.getRemoteGit(resolvedRepoPath, core.resolveRemoteAuth(resolvedRepoPath));
        await remote.raw(['push', '--force-with-lease']);

        return {
            success: true,
            operation: 'force-push',
            warning: 'Force push completed - Git history has been rewritten'
        };
    }

    function getSshKeyInfo({ repoPath } = {}) {
        const resolved = core.resolveRepoPath(repoPath);
        const effective = core.getSSHKeyPath(resolved);
        return {
            success: true,
            keys: core.listSshKeys().map(k => k.name),
            selected: core.getSelectedKeyName(resolved),
            effective: effective ? path.basename(effective) : null
        };
    }

    function selectSshKey({ repoPath, keyName } = {}) {
        if (keyName && !core.listSshKeys().some(k => k.name === keyName)) {
            throw httpError(400, { success: false, error: `Unknown SSH key: ${keyName}` });
        }
        core.setSelectedKeyName(repoPath, keyName || null);
        return { success: true, selected: keyName || null };
    }

    async function add({ repoPath, files, stageAll = false } = {}) {
        const git = core.getGit(repoPath);
        await core.validateRepo(git);

        let result;
        if (stageAll) {
            result = await git.add('.');
        } else if (files && Array.isArray(files)) {
            result = await git.add(files);
        } else {
            throw new Error('Either stageAll or files array is required');
        }

        return {
            success: true,
            operation: 'add',
            result: result
        };
    }

    async function unstage({ repoPath, files, unstageAll = false } = {}) {
        const git = core.getGit(repoPath);
        await core.validateRepo(git);

        let result;
        if (unstageAll) {
            result = await git.reset(['HEAD']);
        } else if (files && Array.isArray(files) && files.length > 0) {
            result = await git.reset(['HEAD', '--', ...files]);
        } else {
            throw new Error('Either unstageAll or files array is required');
        }

        return {
            success: true,
            operation: 'unstage',
            result: result
        };
    }

    async function commit({ repoPath, message, user } = {}) {
        if (!message || message.trim() === '') {
            throw new Error('Commit message is required');
        }

        const resolvedRepoPath = core.resolveRepoPath(repoPath);
        let git = core.getGit(resolvedRepoPath);
        await core.validateRepo(git);

        // git can't auto-detect an identity when user.name/user.email aren't set
        // in any config scope, so inject it explicitly from Node-RED settings
        // (or git config) instead of relying on git's own resolution.
        const identity = await core.resolveGitIdentity(user, git);
        if (!identity.name || !identity.email) {
            throw httpError(400, {
                success: false,
                error: 'Git identity not configured',
                details: 'No author name/email found in Node-RED settings or git config.',
                suggestion: 'Set your Git identity in Node-RED user settings, or run:\n  git config --global user.name "Your Name"\n  git config --global user.email "you@example.com"'
            });
        }
        // Rebuild the git instance with the resolved identity passed as -c flags
        // so the commit uses it regardless of git config state.
        git = core.getGit(resolvedRepoPath, [
            `user.name=${identity.name}`,
            `user.email=${identity.email}`
        ]);

        const statusBefore = await git.status();
        const currentBranch = core.getBranchNameFromStatus(statusBefore);
        core.rememberBranch(resolvedRepoPath, currentBranch);
        const isDetachedHead = !currentBranch;

        const result = await git.commit(message.trim());
        const headHashAfterCommit = await git.revparse(['HEAD']).catch(() => result.commit);

        if (isDetachedHead) {
            const newCommitHash = headHashAfterCommit || result.commit;
            let branchName = null;
            let branchWarning = null;

            try {
                branchName = await core.createBranchFromDetachedCommit(git, newCommitHash);
                core.rememberBranch(resolvedRepoPath, branchName);
            } catch (branchError) {
                branchWarning = `Commit created, but failed to create new branch automatically: ${branchError.message}`;
                RED.log.warn(`[Git Control] ${branchWarning}`);
            }

            return {
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
            };
        }

        core.rememberBranch(resolvedRepoPath, currentBranch);
        return {
            success: true,
            operation: 'commit',
            commit: result.commit,
            summary: result.summary,
            branch: result.branch,
            createdBranch: false
        };
    }

    return {
        getProjectInfo,
        getLog,
        reset,
        checkout,
        discard,
        getStatus,
        validateCheckout,
        getBranches,
        show,
        fetch,
        pull,
        push,
        forcePush,
        getSshKeyInfo,
        selectSshKey,
        add,
        unstage,
        commit
    };
};
