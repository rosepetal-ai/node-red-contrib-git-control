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
    const fs = require('fs');
    const crypto = require('crypto');
    const flowModel = require('./flow-model');

    // Sentinel ref meaning "the working tree on disk" rather than a commit.
    const WORKING_TREE = 'WORKING';

    // Build an error that the route should send verbatim with a given status.
    function httpError(statusCode, body) {
        const err = new Error(body.error || 'Request failed');
        err.statusCode = statusCode;
        err.responseBody = body;
        return err;
    }

    const identityError = () => httpError(400, {
        success: false,
        error: 'Git identity not configured',
        details: 'No author name/email found in Node-RED settings or git config.',
        suggestion: 'Set your Git identity in Node-RED user settings, or run:\n  git config --global user.name "Your Name"\n  git config --global user.email "you@example.com"'
    });

    // Resolve a git identity into `-c user.x=...` config args.
    async function resolveIdentityArgs(resolvedRepoPath, user) {
        const git = core.getGit(resolvedRepoPath);
        await core.validateRepo(git);
        const identity = await core.resolveGitIdentity(user, git);
        const args = [];
        if (identity.name) args.push(`user.name=${identity.name}`);
        if (identity.email) args.push(`user.email=${identity.email}`);
        return args;
    }

    // Return a git instance whose commits carry a resolved author identity, so
    // operations that create commits never fail with "author identity unknown".
    async function buildAuthoredGit(resolvedRepoPath, user) {
        const args = await resolveIdentityArgs(resolvedRepoPath, user);
        if (args.length < 2) {
            throw identityError();
        }
        return core.getGit(resolvedRepoPath, args);
    }

    // Read and parse the flow file's node array at a ref (or the working tree).
    function isFlowFilePretty() {
        const v = RED.settings && RED.settings.flowFilePretty;
        return v === undefined ? true : !!v;
    }
    async function readFlowNodes(resolvedRepoPath, ref) {
        const relPath = core.getFlowFileRelPath(resolvedRepoPath);
        let text;
        if (!ref || ref === WORKING_TREE) {
            const abs = path.join(resolvedRepoPath, relPath);
            text = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
        } else {
            text = await core.showFileAtRef(resolvedRepoPath, ref, relPath);
            if (text == null) text = '';
        }
        const parsed = flowModel.parseFlows(text);
        if (parsed.error) {
            throw new Error(`Could not parse flow file at ${ref || 'working tree'}: ${parsed.error}`);
        }
        return { nodes: parsed.nodes, relPath };
    }

    // SHA-1 of the on-disk flow file, or null when absent.
    function flowFileDiskHash(resolvedRepoPath) {
        try {
            const abs = path.join(resolvedRepoPath, core.getFlowFileRelPath(resolvedRepoPath));
            if (!fs.existsSync(abs)) return null;
            return crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex');
        } catch (error) {
            return null;
        }
    }

    // Write a node array back to the flow file, preserving the existing file's
    // formatting (pretty vs compact, trailing newline) to keep the git diff minimal.
    function writeFlowFile(resolvedRepoPath, relPath, nodes) {
        const abs = path.join(resolvedRepoPath, relPath);
        const existing = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
        const pretty = existing ? existing.includes('\n    ') : isFlowFilePretty();
        const serialized = JSON.stringify(nodes, null, pretty ? 4 : undefined);
        fs.writeFileSync(abs, (existing.endsWith('\n') || !existing) ? serialized + '\n' : serialized);
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
            flowFile: core.getFlowFileRelPath(projectPath),
            sshKeyConfigured: core.getSSHKeyPath() !== null,
            tracking: status.tracking,
            ahead: status.ahead || 0,
            behind: status.behind || 0,
            isDetachedHead: !currentBranch,
            hasTracking: !!status.tracking,
            // Conflict / interrupted-operation state for the safety-net banner.
            conflicted: status.conflicted || [],
            diverged: (status.ahead || 0) > 0 && (status.behind || 0) > 0,
            mergeState: core.getMergeState(projectPath)
        };
    }

    // Abort whatever conflicted/interrupted operation is in progress.
    async function abortOperation({ repoPath } = {}) {
        const resolved = core.resolveRepoPath(repoPath);
        const git = core.getGit(resolved);
        await core.validateRepo(git);
        const { kind } = core.getMergeState(resolved);
        if (!kind) {
            throw new Error('No merge, cherry-pick, revert, or rebase is in progress');
        }
        await git.raw([kind, '--abort']);
        return { success: true, operation: 'abort', kind };
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
            // An unborn branch (fresh orphan, no commits yet) makes `git log` exit
            // non-zero; treat that as an empty history rather than a load failure.
            result = await git.log(logOptions).catch(() => ({ all: [], total: 0 }));
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
        const ref = core.assertSafeRef(commitRef);
        if (!['soft', 'mixed', 'hard'].includes(resetMode)) {
            throw new Error(`Invalid reset mode: ${resetMode}`);
        }
        if (resetMode === 'hard' && safeMode) {
            throw new Error('Hard reset is disabled in safe mode');
        }

        const resolved = core.resolveRepoPath(repoPath);
        const git = core.getGit(resolved);
        await core.validateRepo(git);

        const before = flowFileDiskHash(resolved);
        const result = await git.reset([`--${resetMode}`, ref]);
        return {
            success: true,
            operation: 'reset',
            mode: resetMode,
            commit: ref,
            flowFileChanged: flowFileDiskHash(resolved) !== before,
            result: result
        };
    }

    async function checkout({ repoPath, commitRef } = {}) {
        const ref = core.assertSafeRef(commitRef);

        const resolved = core.resolveRepoPath(repoPath);
        const git = core.getGit(resolved);
        await core.validateRepo(git);

        const before = flowFileDiskHash(resolved);
        const result = await git.checkout(ref);
        return {
            success: true,
            operation: 'checkout',
            ref: ref,
            flowFileChanged: flowFileDiskHash(resolved) !== before,
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

        // Unpushed commits are NOT a blocker: switching away never loses commits
        // a branch still points to. Only uncommitted working changes can be lost,
        // so that's the single thing we guard (reported for the caller to confirm).
        const unpushedCount = status.ahead || 0;

        const blockers = [];
        if (hasUncommittedChanges) blockers.push('uncommitted_changes');

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
        const status = await git.status().catch(() => ({}));

        const localBranches = result.all.filter(branch => !branch.startsWith('remotes/'));
        // Full remote refs ("origin/main", "origin/dev") for the upstream picker;
        // origin/HEAD is an alias, drop it so it doesn't show as an option.
        const remoteBranches = result.all
            .filter(branch => branch.startsWith('remotes/') && !/\/HEAD$/.test(branch))
            .map(branch => branch.replace(/^remotes\//, ''));
        // Bare names of remote-only branches (no local counterpart) — picking
        // one in the branch picker DWIMs a local tracking branch on checkout.
        const remoteOnly = remoteBranches
            .filter(r => r.startsWith('origin/'))
            .map(r => r.replace(/^origin\//, ''))
            .filter(n => !localBranches.includes(n));
        const allBranches = [...localBranches, ...remoteOnly];

        return {
            success: true,
            operation: 'branches',
            current: result.current,
            tracking: status.tracking || null,
            all: allBranches,
            local: localBranches,
            remoteOnly,
            remoteBranches,
            branches: result.branches
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

    // Pull = fetch + integrate, but never auto-merge. We fetch first, then:
    //   - nothing behind        -> up to date (no-op)
    //   - behind only           -> fast-forward (no merge commit, no prompt)
    //   - diverged (also ahead) -> a merge commit is required, so we only do it
    //                              when the caller confirmed via allowMerge;
    //                              otherwise we report needsMerge and stop.
    async function pull({ repoPath, user, allowMerge = false } = {}) {
        const resolvedRepoPath = core.resolveRepoPath(repoPath);
        const git = core.getGit(resolvedRepoPath);
        await core.validateRepo(git);

        // Inject the resolved identity so a merge commit doesn't fall back to git's
        // auto-detected identity (best effort; a fast-forward/no-op makes no commit).
        const idArgs = await resolveIdentityArgs(resolvedRepoPath, user);
        const remote = core.getRemoteGit(resolvedRepoPath, core.resolveRemoteAuth(resolvedRepoPath), idArgs);

        // Fetch first so we can choose fast-forward vs merge without merging yet.
        await remote.raw(['fetch', '--prune']);

        let status = await git.status();
        if (!status.tracking) {
            // Default: track the remote branch of the same name. Set it up if that
            // remote branch exists; otherwise the branch just isn't on the remote yet.
            const branch = core.getBranchNameFromStatus(status);
            if (!branch) {
                throw new Error('Cannot pull in detached HEAD state.');
            }
            const sameName = `origin/${branch}`;
            // --quiet makes simple-git resolve with "" on exit 1; judge by stdout
            // rather than promise rejection (an empty SHA means the ref isn't there).
            const sha = await git.raw(['rev-parse', '--verify', sameName]).catch(() => '');
            if (!String(sha).trim()) {
                throw new Error(`'${branch}' is not on the remote yet. Push it to create 'origin/${branch}'.`);
            }
            await git.raw(['branch', `--set-upstream-to=${sameName}`, branch]);
            status = await git.status();
        }

        const behind = status.behind || 0;
        const ahead = status.ahead || 0;

        if (behind === 0) {
            return { success: true, operation: 'pull', upToDate: true, changed: false, flowFileChanged: false, conflicted: false, conflictedFiles: [] };
        }
        if (ahead > 0 && !allowMerge) {
            // Local and remote have diverged - integrating needs a merge commit.
            // Ask the caller before creating it; the fetch above already ran, so the
            // remote commits are available either way.
            return { success: true, operation: 'pull', needsMerge: true, ahead, behind, changed: false, flowFileChanged: false, conflicted: false, conflictedFiles: [] };
        }

        const before = flowFileDiskHash(resolvedRepoPath);
        const headBefore = await git.revparse(['HEAD']).catch(() => null);

        let outcome;
        if (ahead === 0) {
            // Pure fast-forward: advances the branch pointer, no merge commit.
            outcome = await runMergeLike(git, ['merge', '--ff-only', '@{u}']);
        } else {
            // Confirmed merge of the diverged upstream (--no-edit: no editor prompt).
            outcome = await runMergeLike(core.getGit(resolvedRepoPath, idArgs), ['merge', '--no-edit', '@{u}']);
        }

        const headAfter = await git.revparse(['HEAD']).catch(() => null);
        return {
            success: true,
            operation: 'pull',
            merged: ahead > 0,
            conflicted: outcome.conflicted.length > 0,
            conflictedFiles: outcome.conflicted,
            changed: headBefore !== headAfter,
            flowFileChanged: flowFileDiskHash(resolvedRepoPath) !== before,
            result: outcome.result
        };
    }

    async function push({ repoPath, targetRemote, targetBranch } = {}) {
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
        let upstream = status.tracking || null;

        if (targetBranch) {
            // Publish the current branch to an explicit remote branch, creating it
            // if needed and setting it as the upstream (-u). Used by the tracking
            // picker's "create origin/<name>" option; overrides any prior upstream.
            const remoteName = targetRemote || 'origin';
            const safeTarget = core.assertSafeRef(targetBranch);
            await remote.raw(['push', '-u', remoteName, `HEAD:${safeTarget}`]);
            return {
                success: true, operation: 'push', branch: currentBranch,
                setUpstream: true, upstream: `${remoteName}/${safeTarget}`
            };
        }

        if (status.tracking && status.tracking.includes('/')) {
            // Push the current branch to its tracked upstream EXPLICITLY. A bare
            // `git push` relies on push.default (=simple by default), which refuses
            // when the local and upstream branch names differ (e.g. v4 tracking
            // origin/v6). Pushing HEAD:<upstreamBranch> honours the tracking link
            // regardless of name.
            const slash = status.tracking.indexOf('/');
            const remoteName = status.tracking.slice(0, slash);
            const remoteBranch = status.tracking.slice(slash + 1);
            await remote.raw(['push', remoteName, `HEAD:${remoteBranch}`]);
        } else {
            // No upstream yet: the remote branch doesn't exist. push -u creates it
            // on the remote and sets it as this branch's tracking upstream.
            const remotes = await git.getRemotes(true);
            if (!remotes || remotes.length === 0) {
                throw new Error('No Git remotes configured for this repository');
            }

            const defaultRemote = remotes.find(r => r.name === 'origin') || remotes[0];
            const remoteName = defaultRemote.name;

            await remote.raw(['push', '-u', remoteName, currentBranch]);
            setUpstream = true;
            upstream = `${remoteName}/${currentBranch}`;
        }

        return {
            success: true,
            operation: 'push',
            branch: currentBranch,
            setUpstream: setUpstream,
            upstream: upstream
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

    async function commit({ repoPath, message, user, stageAll = false } = {}) {
        if (!message || message.trim() === '') {
            throw new Error('Commit message is required');
        }

        const resolvedRepoPath = core.resolveRepoPath(repoPath);
        // Inject a resolved identity as -c flags so the commit succeeds even when
        // user.name/user.email aren't set in any git config scope.
        const git = await buildAuthoredGit(resolvedRepoPath, user);

        // Stage every change first when asked (the sidebar's one-step commit) -
        // -A also captures untracked files and deletions.
        if (stageAll) {
            await git.raw(['add', '-A']);
        }

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

    // ==================== Branch / ref operations ====================

    async function createBranch({ repoPath, name, startPoint, checkout = true } = {}) {
        const branchName = core.assertSafeRef(name);
        const resolved = core.resolveRepoPath(repoPath);
        const git = core.getGit(resolved);
        await core.validateRepo(git);

        const args = checkout ? ['checkout', '-b', branchName] : ['branch', branchName];
        if (startPoint) args.push(core.assertSafeRef(startPoint));
        const before = flowFileDiskHash(resolved);
        await git.raw(args);

        return {
            success: true,
            operation: 'create-branch',
            branch: branchName,
            checkedOut: checkout,
            startPoint: startPoint || null,
            // Checking out a branch at an earlier start point rewrites the working
            // tree; report whether the flow file actually moved so the UI can skip
            // a needless reload.
            flowFileChanged: checkout && flowFileDiskHash(resolved) !== before
        };
    }

    async function createOrphanBranch({ repoPath, name, keepContent = true } = {}) {
        const branchName = core.assertSafeRef(name);
        const resolved = core.resolveRepoPath(repoPath);
        const git = core.getGit(resolved);
        await core.validateRepo(git);

        // An orphan branch starts with no history. The working tree and index are
        // carried over, so by default the first commit captures current content;
        // clearing the index instead starts the branch empty.
        const before = flowFileDiskHash(resolved);
        await git.raw(['checkout', '--orphan', branchName]);
        if (!keepContent) {
            await git.raw(['rm', '-rf', '--cached', '.']).catch(() => {});
        }
        // Orphan checkout keeps the working tree, so the on-disk flow file is
        // normally untouched (flowFileChanged false) and no editor resync is needed.
        return {
            success: true, operation: 'create-orphan-branch', branch: branchName, keepContent,
            flowFileChanged: flowFileDiskHash(resolved) !== before
        };
    }

    async function deleteBranch({ repoPath, name, force = false } = {}) {
        const branchName = core.assertSafeRef(name);
        const git = core.getGit(repoPath);
        await core.validateRepo(git);
        await git.raw(['branch', force ? '-D' : '-d', branchName]);
        return { success: true, operation: 'delete-branch', branch: branchName, forced: force };
    }

    async function renameBranch({ repoPath, from, to } = {}) {
        const toName = core.assertSafeRef(to);
        const fromName = from ? core.assertSafeRef(from) : null;
        const git = core.getGit(core.resolveRepoPath(repoPath));
        await core.validateRepo(git);

        const args = ['branch', '-m'];
        if (fromName) args.push(fromName);
        args.push(toName);
        await git.raw(args);

        // `git branch -m` keeps the old upstream link (branch.<new>.merge still
        // points to refs/heads/<oldName>), so the renamed branch silently tracks
        // the old name. Realign it: if origin/<newName> exists, track it;
        // otherwise drop the stale link so the next push creates origin/<newName>.
        // Note: --quiet makes simple-git resolve with "" on exit 1, so we judge
        // by whether the SHA was printed instead of by promise rejection.
        const sameName = `origin/${toName}`;
        const sha = await git.raw(['rev-parse', '--verify', sameName]).catch(() => '');
        let upstream = null;
        if (String(sha).trim()) {
            await git.raw(['branch', `--set-upstream-to=${sameName}`, toName]);
            upstream = sameName;
        } else {
            await git.raw(['branch', '--unset-upstream', toName]).catch(() => {});
        }

        return { success: true, operation: 'rename-branch', from: fromName, to: toName, upstream };
    }

    async function setUpstream({ repoPath, branch, remote = 'origin', remoteBranch } = {}) {
        const resolved = core.resolveRepoPath(repoPath);
        const git = core.getGit(resolved);
        await core.validateRepo(git);

        const status = await git.status();
        const localBranch = (branch && branch.trim()) || core.getBranchNameFromStatus(status);
        if (!localBranch) {
            throw new Error('Cannot set upstream in detached HEAD; specify a branch');
        }
        const upstream = `${remote}/${remoteBranch || localBranch}`;
        await git.raw(['branch', `--set-upstream-to=${upstream}`, localBranch]);
        return { success: true, operation: 'set-upstream', branch: localBranch, upstream };
    }

    // Run a merge-like command (merge/pull/cherry-pick/revert) and classify the
    // outcome. simple-git may resolve OR reject when these hit a conflict, so we
    // judge by the resulting working-tree state: leftover conflicted files mean a
    // conflict (reported, not thrown); a throw with no conflicts is a real error.
    async function runMergeLike(git, args) {
        let result = '', rawErr = null;
        try { result = await git.raw(args); }
        catch (err) { rawErr = err; }
        const status = await git.status();
        const conflicted = status.conflicted || [];
        if (conflicted.length === 0 && rawErr) throw rawErr;
        return { conflicted, result: (result || '').trim() };
    }

    async function merge({ repoPath, ref, noFastForward = false, user } = {}) {
        const source = core.assertSafeRef(ref);
        const resolved = core.resolveRepoPath(repoPath);
        // Inject identity so a non-fast-forward merge commit doesn't fail with
        // "committer identity unknown" (best effort; a fast-forward makes no commit).
        const idArgs = await resolveIdentityArgs(resolved, user);
        const git = core.getGit(resolved, idArgs);
        await core.validateRepo(git);
        // --no-edit: a non-fast-forward merge commit must not block on an editor.
        const args = ['merge', '--no-edit'];
        if (noFastForward) args.push('--no-ff');
        args.push(source);
        const before = flowFileDiskHash(resolved);
        const outcome = await runMergeLike(git, args);
        return {
            success: true, operation: 'merge', ref: source,
            conflicted: outcome.conflicted.length > 0, conflictedFiles: outcome.conflicted,
            flowFileChanged: flowFileDiskHash(resolved) !== before,
            result: outcome.result
        };
    }

    // --no-commit leaves the result staged for review; otherwise a new commit is
    // created, which (like any commit) needs a resolved author identity.
    async function gitForNewCommit(resolved, noCommit, user) {
        if (!noCommit) {
            return buildAuthoredGit(resolved, user);
        }
        const git = core.getGit(resolved);
        await core.validateRepo(git);
        return git;
    }

    async function revertCommit({ repoPath, commitRef, noCommit = false, user } = {}) {
        const ref = core.assertSafeRef(commitRef);
        const resolved = core.resolveRepoPath(repoPath);
        const git = await gitForNewCommit(resolved, noCommit, user);

        const args = ['revert', '--no-edit'];
        if (noCommit) args.push('--no-commit');
        args.push(ref);
        const before = flowFileDiskHash(resolved);
        const outcome = await runMergeLike(git, args);
        return {
            success: true, operation: 'revert', commit: ref, noCommit,
            conflicted: outcome.conflicted.length > 0, conflictedFiles: outcome.conflicted,
            flowFileChanged: flowFileDiskHash(resolved) !== before,
            result: outcome.result
        };
    }

    async function cherryPick({ repoPath, commitRef, noCommit = false, user } = {}) {
        const ref = core.assertSafeRef(commitRef);
        const resolved = core.resolveRepoPath(repoPath);
        const git = await gitForNewCommit(resolved, noCommit, user);

        const args = ['cherry-pick'];
        if (noCommit) args.push('--no-commit');
        args.push(ref);
        const outcome = await runMergeLike(git, args);
        return {
            success: true, operation: 'cherry-pick', commit: ref, noCommit,
            conflicted: outcome.conflicted.length > 0, conflictedFiles: outcome.conflicted,
            result: outcome.result
        };
    }

    async function discardAll({ repoPath } = {}) {
        const git = core.getGit(repoPath);
        await core.validateRepo(git);
        // Hard reset drops tracked changes; clean -fd removes untracked files too
        // (respects .gitignore, so ignored files are left alone).
        await git.raw(['reset', '--hard', 'HEAD']);
        await git.raw(['clean', '-fd']);
        return { success: true, operation: 'discard-all' };
    }

    // ==================== Flow-aware conflict resolution ====================

    // Read a stage (:1: base, :2: ours, :3: theirs) of a file from the index.
    // simple-git rejects when the stage doesn't exist (e.g. :1: in an add/add);
    // callers treat null as "side absent".
    async function readStage(git, stage, relPath) {
        try { return await git.raw(['show', `:${stage}:${relPath}`]); }
        catch { return null; }
    }

    // One-line commit metadata for the merge-resolution UI. Returns null when
    // the ref cannot be resolved (e.g. unborn branch).
    async function readCommitMeta(git, ref) {
        try {
            const out = await git.raw(['log', '-1', '--format=%H%n%h%n%s%n%an%n%ai', ref]);
            const [hash, shortHash, message, author, when] = String(out).split('\n');
            if (!hash) return null;
            return { hash, shortHash, message, author, when };
        } catch { return null; }
    }

    // Branch label for the active conflict sides. HEAD uses the symbolic ref
    // when possible (falls back to short SHA on detached HEAD); MERGE_HEAD's
    // branch is recovered from .git/MERGE_MSG ("Merge branch 'X' into Y") and
    // falls back to short SHA when git wrote a non-branch merge message.
    async function readMergeRefs(git, repoPath, mergeMsg, theirsCommit) {
        let oursRef;
        try { oursRef = (await git.raw(['symbolic-ref', '-q', '--short', 'HEAD'])).trim(); }
        catch { oursRef = null; }
        if (!oursRef) {
            try { oursRef = (await git.raw(['rev-parse', '--short', 'HEAD'])).trim(); }
            catch { oursRef = null; }
        }

        let theirsRef = null;
        if (mergeMsg) {
            const m = mergeMsg.match(/^Merge (?:branch|remote-tracking branch|tag|commit) '([^']+)'/m);
            if (m) theirsRef = m[1];
        }
        if (!theirsRef && theirsCommit && theirsCommit.shortHash) theirsRef = theirsCommit.shortHash;
        return { oursRef, theirsRef };
    }

    function readMergeMsg(resolvedRepoPath) {
        try {
            const p = path.join(resolvedRepoPath, '.git', 'MERGE_MSG');
            return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
        } catch { return null; }
    }

    // Inspect an in-progress conflict and return a preview of which flow nodes
    // can be auto-merged and which still need a human choice. No writes.
    async function previewMergeResolution({ repoPath } = {}) {
        const resolved = core.resolveRepoPath(repoPath);
        const git = core.getGit(resolved);
        await core.validateRepo(git);
        const ms = core.getMergeState(resolved);
        if (!ms.inProgress) throw new Error('No merge, cherry-pick, revert, or rebase is in progress');

        const status = await git.status();
        const conflicted = status.conflicted || [];
        const relPath = core.getFlowFileRelPath(resolved);
        const otherFiles = conflicted.filter(f => f !== relPath);
        const flowConflicted = conflicted.includes(relPath);

        if (!flowConflicted) {
            return {
                success: true, operation: 'merge-preview', kind: ms.kind,
                flowFileMergeable: false, reason: 'flow file is not conflicted',
                conflicts: [], autoMerged: 0, otherFiles
            };
        }

        const baseText = await readStage(git, 1, relPath);
        const oursText = await readStage(git, 2, relPath);
        const theirsText = await readStage(git, 3, relPath);
        const parse = (txt, label) => {
            const p = flowModel.parseFlows(txt || '');
            if (p.error) throw new Error(`Cannot parse ${label} side of ${relPath}: ${p.error}`);
            return p.nodes;
        };
        const baseNodes = baseText == null ? [] : parse(baseText, 'base');
        const oursNodes = oursText == null ? [] : parse(oursText, 'ours');
        const theirsNodes = theirsText == null ? [] : parse(theirsText, 'theirs');

        const merge = flowModel.mergeFlowsThreeWay(baseNodes, oursNodes, theirsNodes);
        const context = await collectMergeContext(git, resolved);
        return {
            success: true, operation: 'merge-preview', kind: ms.kind,
            flowFileMergeable: true,
            autoMerged: merge.autoMerged,
            conflicts: merge.conflicts,
            otherFiles,
            ...context
        };
    }

    // Gathers everything the resolver UI shows in its header / commit editor:
    // both sides' commit metadata, branch labels, merge base, and the message
    // git already wrote to .git/MERGE_MSG (which we pre-fill the editor with).
    async function collectMergeContext(git, resolvedRepoPath) {
        const mergeMessage = readMergeMsg(resolvedRepoPath);
        const [oursCommit, theirsCommit] = await Promise.all([
            readCommitMeta(git, 'HEAD'),
            readCommitMeta(git, 'MERGE_HEAD')
        ]);
        const { oursRef, theirsRef } = await readMergeRefs(git, resolvedRepoPath, mergeMessage, theirsCommit);
        let mergeBase = null;
        try {
            const out = await git.raw(['merge-base', 'HEAD', 'MERGE_HEAD']);
            const hash = String(out).trim();
            if (hash) mergeBase = { hash, shortHash: hash.slice(0, 7) };
        } catch { /* unrelated histories or unborn ref */ }
        return { oursRef, theirsRef, oursCommit, theirsCommit, mergeBase, mergeMessage };
    }

    // Apply the user's per-node / per-unit choices to the merger, write the
    // resolved flows.json, stage it, and finalize the commit. Refuses if any
    // conflict remains unresolved (fallback==='auto') or any non-flow file is
    // still unmerged (we don't manage those).
    async function resolveConflict({ repoPath, choices = {}, fallback = 'auto', commitMessage, user } = {}) {
        const resolved = core.resolveRepoPath(repoPath);
        const ms = core.getMergeState(resolved);
        if (!ms.inProgress) throw new Error('No merge, cherry-pick, revert, or rebase is in progress');
        if (ms.kind !== 'merge') {
            throw new Error(`Flow-aware resolution currently supports merge only (in-progress: ${ms.kind})`);
        }

        const git = await buildAuthoredGit(resolved, user);
        const status = await git.status();
        const conflicted = status.conflicted || [];
        const relPath = core.getFlowFileRelPath(resolved);
        const otherFiles = conflicted.filter(f => f !== relPath);
        if (otherFiles.length) {
            throw httpError(409, {
                success: false,
                error: 'Other files still have conflicts',
                details: 'The flow file resolver can only complete a merge when flows.json is the only conflicted file.',
                files: otherFiles
            });
        }

        const baseText = await readStage(git, 1, relPath);
        const oursText = await readStage(git, 2, relPath);
        const theirsText = await readStage(git, 3, relPath);
        const parse = (txt, label) => {
            const p = flowModel.parseFlows(txt || '');
            if (p.error) throw new Error(`Cannot parse ${label} side of ${relPath}: ${p.error}`);
            return p.nodes;
        };
        const baseNodes = baseText == null ? [] : parse(baseText, 'base');
        const oursNodes = oursText == null ? [] : parse(oursText, 'ours');
        const theirsNodes = theirsText == null ? [] : parse(theirsText, 'theirs');

        const fb = fallback === 'ours' || fallback === 'theirs' ? fallback : null;
        const merge = flowModel.mergeFlowsThreeWay(baseNodes, oursNodes, theirsNodes, { choices, fallback: fb });
        if (merge.conflicts.length) {
            throw httpError(409, {
                success: false,
                error: 'Unresolved conflicts remain',
                details: 'Provide a choice for each flagged node/unit, or set fallback to "ours" or "theirs".',
                conflicts: merge.conflicts
            });
        }

        const before = flowFileDiskHash(resolved);
        writeFlowFile(resolved, relPath, merge.merged);
        await git.raw(['add', '--', relPath]);

        const defaultMsg = (readMergeMsg(resolved) || 'Merge').trim() || 'Merge';
        const msg = commitMessage && commitMessage.trim() ? commitMessage.trim() : defaultMsg;
        const result = await git.commit(msg);

        return {
            success: true, operation: 'merge-resolve',
            commit: result.commit, summary: result.summary,
            autoMerged: merge.autoMerged,
            flowFileChanged: flowFileDiskHash(resolved) !== before
        };
    }

    // ==================== Flow-aware operations ====================

    const summarizeNode = n => ({ id: n.id, type: n.type, name: n.name || n.label || null });

    async function getFlowUnits({ repoPath, ref } = {}) {
        const resolved = core.resolveRepoPath(repoPath);
        await core.validateRepo(core.getGit(resolved));
        const { nodes } = await readFlowNodes(resolved, ref);
        const units = flowModel.groupByUnit(nodes).map(u => ({
            id: u.id, kind: u.kind, label: u.label, nodeCount: u.nodes.length
        }));
        return { success: true, operation: 'flow-units', ref: ref || 'working', units };
    }

    // Per-flow diff between two refs (or a ref and the working tree). `detail`
    // includes full node bodies so an agent can see exact field changes.
    async function diffFlows({ repoPath, base = 'HEAD', head, detail = false } = {}) {
        const resolved = core.resolveRepoPath(repoPath);
        await core.validateRepo(core.getGit(resolved));
        const baseNodes = (await readFlowNodes(resolved, base)).nodes;
        const headNodes = (await readFlowNodes(resolved, head)).nodes;

        const units = flowModel.diffUnits(baseNodes, headNodes).map(u => ({
            id: u.id,
            kind: u.kind,
            label: u.label,
            status: u.status,
            counts: u.counts,
            added: detail ? u.added : u.added.map(summarizeNode),
            removed: detail ? u.removed : u.removed.map(summarizeNode),
            modified: detail
                ? u.modified
                : u.modified.map(m => ({ id: m.id, type: m.head.type }))
        }));

        return {
            success: true,
            operation: 'flow-diff',
            base,
            head: head || 'working',
            changed: units.filter(u => u.status !== 'unchanged').length,
            units
        };
    }

    // Revert a single flow/subflow/config unit to its version at `ref`, leaving
    // every other unit untouched. Writes the working flow file (does NOT commit),
    // so the change shows up as a normal working-tree edit to review and commit.
    async function revertFlowUnit({ repoPath, unitId, ref = 'HEAD', includeDependencies = false } = {}) {
        if (!unitId) throw new Error('unitId is required');
        const resolved = core.resolveRepoPath(repoPath);
        await core.validateRepo(core.getGit(resolved));

        const { nodes: currentNodes, relPath } = await readFlowNodes(resolved, WORKING_TREE);
        const { nodes: targetNodes } = await readFlowNodes(resolved, ref);

        // Detect config/subflow units the reverted flow references, so the caller
        // can choose to revert those too rather than leave dangling references.
        const targetUnit = flowModel.groupByUnit(targetNodes).find(u => u.id === unitId);
        const currentUnit = flowModel.groupByUnit(currentNodes).find(u => u.id === unitId);
        const unitNodes = (targetUnit || currentUnit || { nodes: [] }).nodes;
        const dependencies = flowModel.findUnitDependencies(unitNodes, targetUnit ? targetNodes : currentNodes);

        let result = flowModel.spliceUnit(currentNodes, targetNodes, unitId);
        const revertedUnits = [unitId];
        if (includeDependencies) {
            const depIds = dependencies.subflows.map(s => s.id);
            if (dependencies.config.length) depIds.push(flowModel.CONFIG_UNIT_ID);
            for (const depId of depIds) {
                result = flowModel.spliceUnit(result, targetNodes, depId);
                revertedUnits.push(depId);
            }
        }

        writeFlowFile(resolved, relPath, result);

        const hasUnreverted = !includeDependencies && (dependencies.config.length || dependencies.subflows.length);
        return {
            success: true,
            operation: 'revert-flow-unit',
            unitId,
            ref,
            revertedUnits,
            dependencies,
            file: relPath,
            warning: hasUnreverted
                ? 'The reverted flow references config/subflow units that were not reverted; they may be out of sync.'
                : null
        };
    }

    // Revert individual nodes (by id) to their version at `ref`, leaving the rest
    // of the flow file untouched. Writes the working flow file (no commit).
    async function revertFlowNodes({ repoPath, nodeIds, ref = 'HEAD' } = {}) {
        if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
            throw new Error('nodeIds is required');
        }
        const resolved = core.resolveRepoPath(repoPath);
        await core.validateRepo(core.getGit(resolved));

        const { nodes: currentNodes, relPath } = await readFlowNodes(resolved, WORKING_TREE);
        const { nodes: targetNodes } = await readFlowNodes(resolved, ref);

        const result = flowModel.revertNodes(currentNodes, targetNodes, nodeIds);

        // Dependencies of the restored nodes, for a soft "may be out of sync" hint.
        const targetById = new Map(
            targetNodes.filter(n => n && n.id != null).map(n => [n.id, n])
        );
        const restored = nodeIds.map(id => targetById.get(id)).filter(Boolean);
        const dependencies = flowModel.findUnitDependencies(restored, targetNodes);

        writeFlowFile(resolved, relPath, result);

        const hasDeps = dependencies.config.length || dependencies.subflows.length;
        return {
            success: true,
            operation: 'revert-flow-nodes',
            nodeIds,
            ref,
            file: relPath,
            dependencies,
            warning: hasDeps
                ? 'The reverted node(s) reference config/subflow units that were not reverted; they may be out of sync.'
                : null
        };
    }

    async function getFileDiff({ repoPath, file, base = 'HEAD', head } = {}) {
        const resolved = core.resolveRepoPath(repoPath);
        const git = core.getGit(resolved);
        await core.validateRepo(git);
        const args = ['diff'];
        if (base) args.push(core.assertSafeRef(base));
        if (head) args.push(core.assertSafeRef(head));
        args.push('--');
        if (file) args.push(file);
        const diff = await git.raw(args);
        return { success: true, operation: 'file-diff', base, head: head || 'working', file: file || null, diff };
    }

    async function getCommitDiff({ repoPath, commitRef } = {}) {
        const ref = core.assertSafeRef(commitRef);
        const resolved = core.resolveRepoPath(repoPath);
        const git = core.getGit(resolved);
        await core.validateRepo(git);
        // diff-tree gives just the changed-file name-status (no patch, no header);
        // --root makes the initial commit list its files as additions.
        const nameStatus = await git.raw(['diff-tree', '--no-commit-id', '--name-status', '-r', '--root', ref]);
        const files = nameStatus.trim().split('\n').filter(Boolean).map(line => {
            const parts = line.split('\t');
            return { status: parts[0], path: parts.slice(1).join('\t') };
        });
        return { success: true, operation: 'commit-diff', commit: ref, files };
    }

    // Which branches contain a commit (i.e. have it in their history) - answers
    // "what branch is this commit on?". Local and remote are returned separately;
    // the detached-HEAD marker and the "origin/HEAD ->" alias are filtered out.
    async function getCommitBranches({ repoPath, commitRef } = {}) {
        const ref = core.assertSafeRef(commitRef);
        const resolved = core.resolveRepoPath(repoPath);
        const git = core.getGit(resolved);
        await core.validateRepo(git);

        const clean = (raw) => (raw || '').split('\n')
            .map(s => s.trim())
            .filter(s => s && !/\/HEAD$/.test(s) && !s.includes('->') && s[0] !== '(');

        const local = clean(await git.raw(['branch', '--contains', ref, '--format=%(refname:short)']).catch(() => ''));
        const remote = clean(await git.raw(['branch', '-r', '--contains', ref, '--format=%(refname:short)']).catch(() => ''));
        const status = await git.status();
        return {
            success: true,
            operation: 'commit-branches',
            commit: ref,
            branches: local,
            remoteBranches: remote,
            current: core.getBranchNameFromStatus(status) || null
        };
    }

    return {
        getProjectInfo,
        abortOperation,
        getLog,
        reset,
        checkout,
        discard,
        discardAll,
        getStatus,
        validateCheckout,
        getBranches,
        fetch,
        pull,
        push,
        forcePush,
        getSshKeyInfo,
        selectSshKey,
        add,
        unstage,
        commit,
        // branch / ref operations
        createBranch,
        createOrphanBranch,
        deleteBranch,
        renameBranch,
        setUpstream,
        merge,
        revertCommit,
        cherryPick,
        previewMergeResolution,
        resolveConflict,
        // flow-aware operations
        getFlowUnits,
        diffFlows,
        revertFlowUnit,
        revertFlowNodes,
        getFileDiff,
        getCommitDiff,
        getCommitBranches
    };
};
