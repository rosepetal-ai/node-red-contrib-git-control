/**
 * Git Control - core execution layer
 *
 * Owns HOW git runs and authenticates, independent of HTTP. Two instances:
 *   - getGit():       simple-git for LOCAL operations (no network, no auth).
 *   - getRemoteGit(): simple-git for NETWORK operations, with SSH auth applied
 *                     via .env() (key + trust-on-first-use) and a block
 *                     timeout so a hung connection is killed.
 * Plus repo/identity/key resolution, branch memory and error formatting.
 */
module.exports = function(RED) {
    const simpleGit = require('simple-git');
    const path = require('path');
    const fs = require('fs');

    // Last known non-detached branch per repo, used to keep context while in
    // detached HEAD and to offer "return to latest".
    const repoBranchMemory = new Map();

    // Helper function to get active Node-RED project path
    function getActiveProjectPath() {
        try {
            const settings = RED.settings;
            const projectsDir = path.resolve(path.join(settings.userDir, "projects"));

            const projectsSettings = settings.get('projects');
            if (projectsSettings && projectsSettings.activeProject) {
                return path.join(projectsDir, projectsSettings.activeProject);
            }

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

    // Resolve repo path consistently (also used as the memoization key).
    function resolveRepoPath(inputPath) {
        if (inputPath && typeof inputPath === 'string' && inputPath.trim() !== '') {
            return path.resolve(inputPath);
        }
        return getActiveProjectPath() || process.cwd();
    }

    // Node-RED stores project SSH keys in <userDir>/projects/.sshkeys as a
    // "<name>" / "<name>.pub" pair (e.g. "__default_<project>").
    function getSshKeysDir() {
        return path.resolve(path.join(RED.settings.userDir, "projects", ".sshkeys"));
    }

    // List available private keys (entries that have a matching ".pub" sibling).
    function listSshKeys() {
        try {
            const dir = getSshKeysDir();
            if (!fs.existsSync(dir)) {
                return [];
            }
            const entries = fs.readdirSync(dir);
            const pubKeys = new Set(entries.filter(name => name.endsWith('.pub')));
            return entries
                .filter(name => !name.endsWith('.pub') && pubKeys.has(`${name}.pub`))
                .map(name => ({ name, path: path.join(dir, name) }));
        } catch (error) {
            RED.log.warn("Git Control: failed to list SSH keys: " + error.message);
            return [];
        }
    }

    // Plugin settings file (persists the per-project SSH key choice; never secrets).
    function getSettingsFilePath() {
        return path.join(RED.settings.userDir, "git-control.json");
    }
    function readPluginSettings() {
        try {
            const file = getSettingsFilePath();
            if (fs.existsSync(file)) {
                return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
            }
        } catch (error) {
            RED.log.warn("Git Control: failed to read settings: " + error.message);
        }
        return {};
    }
    function writePluginSettings(data) {
        try {
            fs.writeFileSync(getSettingsFilePath(), JSON.stringify(data, null, 2));
        } catch (error) {
            RED.log.warn("Git Control: failed to write settings: " + error.message);
        }
    }
    function getSelectedKeyName(repoPath) {
        const settings = readPluginSettings();
        return (settings.selectedKeys && settings.selectedKeys[resolveRepoPath(repoPath)]) || null;
    }
    function setSelectedKeyName(repoPath, keyName) {
        const settings = readPluginSettings();
        settings.selectedKeys = settings.selectedKeys || {};
        if (keyName) {
            settings.selectedKeys[resolveRepoPath(repoPath)] = keyName;
        } else {
            delete settings.selectedKeys[resolveRepoPath(repoPath)];
        }
        writePluginSettings(settings);
    }

    // Resolve which SSH key to use for a repo:
    //   1) explicit per-project selection, 2) key matching the project name,
    //   3) the only key when there's exactly one. Returns an absolute path or null.
    function getSSHKeyPath(repoPath) {
        const keys = listSshKeys();
        if (keys.length === 0) {
            return null;
        }

        const selected = getSelectedKeyName(repoPath);
        if (selected) {
            const found = keys.find(k => k.name === selected);
            if (found) {
                return found.path;
            }
        }

        const activeProjectPath = getActiveProjectPath();
        const activeProject = activeProjectPath ? path.basename(activeProjectPath) : null;
        if (activeProject) {
            const match = keys.find(k => k.name === `__default_${activeProject}` || k.name.endsWith(`_${activeProject}`));
            if (match) {
                return match.path;
            }
        }

        if (keys.length === 1) {
            return keys[0].path;
        }

        return null;
    }

    // Get git user settings from Node-RED user settings. Returns null when not
    // configured, letting callers fall back to git config.
    async function getGitUserSettings(user) {
        try {
            const getUserSettings = RED.settings?.getUserSettings;
            if (typeof getUserSettings !== 'function') {
                return null;
            }

            const username = user?.username || user?.name || user?.id || null;
            const candidates = [];

            // Match Node-RED's /settings/user behavior by trying the full user object first.
            if (user) candidates.push(user);
            if (username) candidates.push(username);
            candidates.push('_');
            candidates.push(undefined);

            for (const candidate of candidates) {
                let userSettings;
                try {
                    userSettings = candidate === undefined
                        ? await getUserSettings()
                        : await getUserSettings(candidate);
                } catch (innerError) {
                    continue;
                }

                const gitUser = userSettings?.git?.user;
                if (gitUser?.name || gitUser?.email) {
                    return {
                        name: gitUser?.name || '',
                        email: gitUser?.email || ''
                    };
                }
            }

            return null;
        } catch (error) {
            RED.log.warn("Could not read Node-RED git settings: " + error.message);
            return null;
        }
    }

    // Resolve the commit identity, preferring Node-RED settings and falling
    // back to git config for each field independently.
    async function resolveGitIdentity(user, git) {
        const nodeRedGitSettings = await getGitUserSettings(user);
        let name = nodeRedGitSettings?.name || '';
        let email = nodeRedGitSettings?.email || '';

        if (!name) {
            name = (await git.raw(['config', 'user.name']).catch(() => '')).trim();
        }
        if (!email) {
            email = (await git.raw(['config', 'user.email']).catch(() => '')).trim();
        }

        return { name, email };
    }

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

    // Git instance for LOCAL operations (status, log, branches, commit, ...).
    // Network operations go through getRemoteGit() instead, which adds SSH
    // auth. extraConfig entries ("key=value") are passed to git as -c flags;
    // extraOptions are merged into the simple-git options (e.g. timeout).
    function getGit(repoPath, extraConfig = [], extraOptions = {}) {
        const gitOptions = {
            baseDir: resolveRepoPath(repoPath),
            binary: 'git',
            maxConcurrentProcesses: 6,
            ...extraOptions
        };
        if (Array.isArray(extraConfig) && extraConfig.length) {
            gitOptions.config = extraConfig;
        }
        return simpleGit(gitOptions);
    }

    // Resolve SSH auth for a repo's network operations.
    function resolveRemoteAuth(repoPath) {
        const keyFile = getSSHKeyPath(repoPath);
        return keyFile ? { keyFile } : {};
    }

    // Build the environment for a network git command. Mirrors how Node-RED's
    // own git integration drives ssh: a fixed key and trust-on-first-use host keys.
    //
    // We pass this env to simple-git's .env(), which REPLACES the environment
    // (not merge) and is scanned by simple-git's safety checks. So we copy the
    // parent env to keep PATH/HOME (the spawned ssh needs them) but drop any
    // ambient GIT_* settings - we set exactly the git env we mean, and an
    // inherited GIT_EDITOR/GIT_PAGER would otherwise be rejected by the scanner.
    function buildRemoteEnv(auth) {
        const env = {};
        for (const key of Object.keys(process.env)) {
            if (!key.startsWith('GIT_')) {
                env[key] = process.env[key];
            }
        }
        env.GIT_TERMINAL_PROMPT = '0';
        if (auth && auth.keyFile) {
            env.GIT_SSH_COMMAND =
                `ssh -i "${auth.keyFile}" -F /dev/null -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
        }
        return env;
    }

    // simple-git instance for NETWORK operations: same as getGit() but with SSH
    // auth applied via .env() (key only) and a block timeout so a hung
    // connection is killed rather than hanging the request.
    //   - allowUnsafeSshCommand: simple-git blocks GIT_SSH_COMMAND by default;
    //     we set it ourselves from trusted plugin config (never user input), so
    //     enabling it is the intended, safe use of this override.
    function getRemoteGit(repoPath, auth) {
        return getGit(repoPath, [], {
            timeout: { block: 120000 },
            unsafe: { allowUnsafeSshCommand: true }
        }).env(buildRemoteEnv(auth));
    }

    // Helper function to check if path is a repo
    async function validateRepo(git) {
        const isRepo = await git.checkIsRepo();
        if (!isRepo) {
            throw new Error('Path is not a git repository');
        }
    }

    // Reject refs that could be mistaken for git options.
    function assertSafeRef(ref) {
        if (typeof ref !== 'string' || ref.trim() === '') {
            throw new Error('A git reference is required');
        }
        if (ref.trim().startsWith('-')) {
            throw new Error(`Invalid git reference: ${ref}`);
        }
        return ref.trim();
    }

    // Read a file's content at a given commit ref.
    async function showFileAtRef(repoPath, ref, relPath) {
        const git = getGit(repoPath);
        try {
            return await git.raw(['show', `${assertSafeRef(ref)}:${relPath}`]);
        } catch (err) {
            if (/exists on disk, but not in|does not exist|path .* does not exist/i.test(err.message || '')) {
                return null;
            }
            throw err;
        }
    }

    // Resolve Node-RED's flow file path relative to the repo root, so flow-aware
    // operations can read it at any ref. Defaults to "flows.json" (the Node-RED
    // project default) when the configured path can't be mapped into the repo.
    function getFlowFileRelPath(repoPath) {
        const resolved = resolveRepoPath(repoPath);
        let flowFile = RED.settings.flowFile;
        if (typeof flowFile === 'function') {
            try { flowFile = flowFile(); } catch (e) { flowFile = null; }
        }
        if (flowFile && typeof flowFile === 'string') {
            const abs = path.isAbsolute(flowFile) ? flowFile : path.join(resolved, flowFile);
            const rel = path.relative(resolved, abs);
            if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
                return rel;
            }
        }
        return 'flows.json';
    }

    // Map raw git errors to user-friendly messages with actionable suggestions.
    function formatGitError(error, operation) {
        const errorMessage = error.message || error.toString();

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
                pattern: /Author identity unknown|unable to auto-detect email|Please tell me who you are/i,
                message: 'Git identity not configured',
                suggestion: 'Set your Git identity in Node-RED user settings, or run:\n  git config --global user.name "Your Name"\n  git config --global user.email "you@example.com"'
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

        for (const { pattern, message, suggestion } of errorPatterns) {
            if (pattern.test(errorMessage)) {
                return {
                    error: message,
                    details: errorMessage,
                    suggestion: suggestion
                };
            }
        }

        return {
            error: `Git ${operation} failed`,
            details: errorMessage,
            suggestion: 'Check the error details above. If the issue persists, try running the operation from the command line for more information.'
        };
    }

    // Like formatGitError, but flags auth failures so the UI can surface a
    // credentials/permissions problem. Used for network operations.
    function formatRemoteError(error, operation) {
        const info = formatGitError(error, operation);
        const text = `${error.stderr || ''}\n${error.stdout || ''}\n${error.message || ''}`;

        if (/permission denied|could not read from remote|authentication failed|host key verification failed/i.test(text)) {
            info.requiresAuth = true;
            info.code = 'git_auth_failed';
        }
        return info;
    }

    return {
        // resolution
        getActiveProjectPath,
        resolveRepoPath,
        // ssh keys / settings
        listSshKeys,
        getSelectedKeyName,
        setSelectedKeyName,
        getSSHKeyPath,
        // identity
        getGitUserSettings,
        resolveGitIdentity,
        // branch helpers
        getBranchNameFromStatus,
        rememberBranch,
        getRememberedBranch,
        createBranchFromDetachedCommit,
        // runners
        getGit,
        resolveRemoteAuth,
        getRemoteGit,
        validateRepo,
        assertSafeRef,
        // flow file / history
        showFileAtRef,
        getFlowFileRelPath,
        // errors
        formatGitError,
        formatRemoteError
    };
};
