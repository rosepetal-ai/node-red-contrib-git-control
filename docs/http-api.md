# HTTP API Reference

The plugin exposes Git control operations via HTTP Admin API endpoints. All routes live on the Node-RED admin server (usually `http://localhost:1880`) under the base path `/rosepetal-git`.

## Authentication & Permissions

- Routes honor Node-RED admin authentication when it is enabled.
- Read-only operations require the `git-control.read` permission; mutating
  operations require `git-control.write`. Note this is by *operation*, not HTTP
  verb — several read-only endpoints are `POST` (they take a JSON body) but still
  only need `read` (e.g. `status`, `branches`, `flow-diff`, `file-diff`).

### Calling the API as an agent / external tool

When admin auth is **disabled**, call the endpoints directly — no token needed.

When admin auth is **enabled**, obtain a bearer token once and send it on every
request:

```bash
# 1. Get a token
curl -s http://localhost:1880/auth/token \
  -d 'client_id=node-red-admin' \
  -d 'grant_type=password' \
  -d 'scope=*' \
  -d 'username=admin' \
  -d 'password=secret'
# -> { "access_token": "....", "token_type": "Bearer", ... }

# 2. Use it
curl -s http://localhost:1880/rosepetal-git/project-info \
  -H 'Authorization: Bearer <access_token>'
```

Bearer-token requests are not subject to CSRF (CSRF only guards cookie-based
editor sessions). All POST bodies are JSON (`Content-Type: application/json`).

### Danger levels

| Level | Endpoints | Notes |
|-------|-----------|-------|
| safe (read-only) | `project-info`, `status`, `log`, `branches`, `validate-checkout`, `flow-units`, `flow-diff`, `file-diff`, `commit-diff`, `commit-branches`, `ssh-keys` | never modify the repo |
| writes working tree / history | `add`, `unstage`, `commit`, `checkout`, `pull`, `merge`, `revert`, `cherry-pick`, `abort`, `create-branch`, `orphan-branch`, `rename-branch`, `set-upstream`, `revert-flow-unit`, `ssh-key` | reversible via git |
| destructive (needs `confirmed: true`) | `force-push`, `discard-all`, `delete-branch` *(when `force: true`)*, `reset` *(hard, when `safeMode: false`)* | can discard work / rewrite history |

All responses are JSON. Errors return:
```json
{
  "success": false,
  "error": "Human-readable error message",
  "details": "Technical error details (optional)",
  "suggestion": "Actionable suggestion for resolution (optional)"
}
```

## Common Patterns

### Request Structure
All POST endpoints accept JSON bodies with at minimum:
```json
{
  "repoPath": "/path/to/repo"  // Optional - defaults to active Node-RED project
}
```

### Response Structure
Success responses include:
```json
{
  "success": true,
  "operation": "operation-name",
  ...operation-specific data
}
```

## Endpoints

### Project Information

#### `GET /rosepetal-git/project-info`
Returns metadata about the active Node-RED project and its Git state.

**Response 200**
```json
{
  "success": true,
  "projectName": "my-project",
  "projectPath": "/home/user/.node-red/projects/my-project",
  "currentBranch": "main",
  "lastKnownBranch": "main",
  "remotes": [
    {
      "name": "origin",
      "refs": {
        "fetch": "git@github.com:user/repo.git",
        "push": "git@github.com:user/repo.git"
      }
    }
  ],
  "user": {
    "name": "John Doe",
    "email": "john@example.com"
  },
  "sshKeyConfigured": true,
  "tracking": "origin/main",
  "ahead": 2,
  "behind": 0,
  "isDetachedHead": false,
  "hasTracking": true,
  "conflicted": [],
  "diverged": false,
  "mergeState": { "inProgress": false, "kind": null }
}
```

- `conflicted`: paths with unresolved merge conflicts (empty when clean).
- `diverged`: `true` when the branch is both ahead of and behind its remote (a plain push will be rejected — pull first, or `force-push`).
- `mergeState.inProgress` / `kind`: a `merge` / `cherry-pick` / `revert` / `rebase` left mid-flight (usually by a conflict). `kind` is also the subcommand `/abort` uses. See `POST /rosepetal-git/abort`.

### Repository Operations

#### `POST /rosepetal-git/log`
Fetches commit history with metadata for graph visualization.

**Request**
```json
{
  "repoPath": "/optional/path",
  "maxCount": 50,
  "from": "commit-hash",  // Optional
  "to": "commit-hash"     // Optional
}
```

**Response 200**
```json
{
  "success": true,
  "operation": "log",
  "total": 50,
  "commits": [
    {
      "hash": "abc123def456...",
      "parents": ["parent-hash-1", "parent-hash-2"],
      "date": "2025-01-14T10:30:00Z",
      "message": "Commit message",
      "author": "John Doe",
      "email": "john@example.com",
      "pushed": true,
      "isHead": false,
      "branches": ["main", "feature-branch"]
    }
  ]
}
```

#### `POST /rosepetal-git/status`
Returns working tree status with file changes.

**Request**
```json
{
  "repoPath": "/optional/path"
}
```

**Response 200**
```json
{
  "success": true,
  "operation": "status",
  "status": {
    "current": "main",
    "tracking": "origin/main",
    "ahead": 2,
    "behind": 0,
    "files": [
      {
        "path": "flows.json",
        "index": "M",
        "working_dir": " "
      }
    ],
    "staged": ["flows.json"],
    "modified": [],
    "created": [],
    "deleted": [],
    "not_added": []
  }
}
```

#### `POST /rosepetal-git/branches`
Lists all local and unique remote branches.

**Response 200**
```json
{
  "success": true,
  "operation": "branches",
  "current": "main",
  "all": ["main", "develop", "feature-branch"],
  "branches": {
    "main": {
      "current": true,
      "commit": "abc123...",
      "label": "main"
    }
  }
}
```

### Branch Operations

#### `POST /rosepetal-git/checkout`
Checks out a commit or branch.

**Request**
```json
{
  "commitRef": "main"  // Branch name or commit hash
}
```

**Response 200**
```json
{
  "success": true,
  "operation": "checkout",
  "ref": "main",
  "flowFileChanged": true,
  "result": "..."
}
```

- `flowFileChanged`: whether the on-disk flow file actually changed. The editor
  only needs to reload flows from disk (and restart) when this is `true`; a
  checkout that doesn't touch the flow file requires no resync.

#### `POST /rosepetal-git/validate-checkout`
Validates whether a checkout is safe. The only blocker is **uncommitted working
changes** (which a checkout could overwrite). Unpushed commits are *not* a
blocker — switching away never loses commits a branch still points to;
`unpushedCount` is reported for information only.

**Request**
```json
{
  "targetRef": "abc123"
}
```

**Response 200**
```json
{
  "success": true,
  "canCheckout": false,
  "blockers": ["uncommitted_changes"],
  "uncommittedCount": 3,
  "unpushedCount": 2,
  "isDetachedHead": false,
  "currentRef": "def456",
  "targetRef": "abc123",
  "currentBranch": "main"
}
```

### Commit Operations

#### `POST /rosepetal-git/add`
Stages files for commit.

**Request**
```json
{
  "stageAll": true,          // Stage all changes
  "files": ["file1", "file2"] // Or specific files
}
```

**Response 200**
```json
{
  "success": true,
  "operation": "add",
  "result": "..."
}
```

#### `POST /rosepetal-git/unstage`
Unstages files from the staging area.

**Request**
```json
{
  "unstageAll": true,         // Unstage all
  "files": ["file1", "file2"] // Or specific files
}
```

**Response 200**
```json
{
  "success": true,
  "operation": "unstage",
  "result": "..."
}
```

#### `POST /rosepetal-git/commit`
Creates a new commit. Automatically creates a branch if in detached HEAD state.

**Request**
```json
{
  "message": "Commit message",
  "stageAll": false
}
```
`stageAll` (optional, default `false`): when `true`, stage every change (`git add
-A`, including untracked files and deletions) before committing. The sidebar
sends `true` so a commit captures all current changes in one step; without it,
only already-staged content is committed.

**Response 200**
```json
{
  "success": true,
  "operation": "commit",
  "commit": "abc123...",
  "summary": {
    "changes": 2,
    "insertions": 10,
    "deletions": 5
  },
  "branch": "from-abc123",
  "createdBranch": true,
  "message": "Created commit and new branch 'from-abc123'"
}
```

#### `POST /rosepetal-git/reset`
Resets to a specific commit (soft/mixed/hard).

**Request**
```json
{
  "commitRef": "HEAD~1",
  "resetMode": "mixed",  // soft, mixed, or hard
  "safeMode": true       // Blocks hard resets when true
}
```

**Response 200**
```json
{
  "success": true,
  "operation": "reset",
  "mode": "mixed",
  "commit": "HEAD~1",
  "flowFileChanged": false,
  "result": "..."
}
```

- `flowFileChanged`: whether the on-disk flow file changed (and thus whether the
  editor must resync). A `mixed`/`soft` reset never rewrites the working tree, so
  this is always `false` for them; only a `hard` reset can flip it to `true`.

**Error 500** (when safeMode blocks hard reset)
```json
{
  "success": false,
  "error": "Hard reset is disabled in safe mode"
}
```

#### `POST /rosepetal-git/discard`
Discards uncommitted changes to specific files.

**Request**
```json
{
  "files": ["flows.json", "package.json"]
}
```

**Response 200**
```json
{
  "success": true,
  "operation": "discard",
  "files": ["flows.json", "package.json"],
  "result": "..."
}
```

### Remote Operations

#### `POST /rosepetal-git/fetch`
Fetches updates from remote without merging.

**Response 200**
```json
{
  "success": true,
  "operation": "fetch",
  "result": "..."
}
```

#### `POST /rosepetal-git/pull`
Fetches the upstream and integrates it, but **never auto-merges**. It fast-forwards
when possible; if the branch has diverged (a merge commit would be required) it
stops and reports `needsMerge` instead — call again with `allowMerge: true` to
perform the merge (`--no-edit`, so it never blocks on an editor).

**Request**
```json
{ "allowMerge": false }
```
- `allowMerge` (default `false`): permit creating a merge commit when the branch
  has diverged. Has no effect on a fast-forward or no-op pull.

**Response 200** — varies by outcome (all share `success`/`operation`):

Up to date (nothing behind the upstream):
```json
{ "success": true, "operation": "pull", "upToDate": true, "changed": false, "flowFileChanged": false, "conflicted": false, "conflictedFiles": [] }
```
Diverged, merge not yet confirmed (the fetch already ran):
```json
{ "success": true, "operation": "pull", "needsMerge": true, "ahead": 2, "behind": 3, "changed": false, "flowFileChanged": false, "conflicted": false, "conflictedFiles": [] }
```
Fast-forward, or a confirmed merge (`merged: true` only for the merge case):
```json
{ "success": true, "operation": "pull", "merged": false, "conflicted": false, "conflictedFiles": [], "changed": true, "flowFileChanged": true, "result": "..." }
```

- `needsMerge`: the branch diverged and `allowMerge` was not set — nothing was
  merged; re-call with `allowMerge: true` to proceed.
- `changed`: whether `HEAD` moved. `flowFileChanged`: whether the flow file
  changed — the editor resyncs from disk only when `true` and there's no conflict.
- `conflicted` / `conflictedFiles`: a confirmed merge can still conflict — see the
  conflict note under `merge`.
- Upstream defaults to the **same-named** remote branch: if the branch has no
  upstream but `origin/<branch>` exists, pull links to it automatically. If no
  such remote branch exists, it errors asking you to push the branch first.

#### `POST /rosepetal-git/push`
Pushes the current branch's commits to the remote.

When the branch already has an upstream, this is a plain `git push`:
```json
{
  "success": true,
  "operation": "push",
  "branch": "main",
  "setUpstream": false,
  "upstream": "origin/main"
}
```

When the branch has **no upstream yet** (its remote branch doesn't exist), it
runs `git push -u <remote> <branch>`, which **creates** the remote branch and
sets it as the tracking upstream:
```json
{
  "success": true,
  "operation": "push",
  "branch": "feature-branch",
  "setUpstream": true,
  "upstream": "origin/feature-branch"
}
```
- `setUpstream`: whether this push created the upstream link.
- `upstream`: the tracking ref (after the push). `null` only if the branch
  somehow still has no upstream.

**Optional request body** — publish to an explicit remote branch (creates it if
missing and sets it as upstream, overriding any prior one). Used by the tracking
picker's "create `origin/<name>`" option:
```json
{ "targetRemote": "origin", "targetBranch": "feature-branch" }
```
This runs `git push -u <targetRemote> HEAD:<targetBranch>`, so it works even when
the branch currently tracks a differently-named upstream.

#### `POST /rosepetal-git/force-push`
Force pushes with `--force-with-lease` (requires confirmation).

**Request**
```json
{
  "confirmed": true
}
```

**Response 400** (when not confirmed)
```json
{
  "success": false,
  "error": "Force push requires explicit confirmation",
  "requiresConfirmation": true
}
```

**Response 200**
```json
{
  "success": true,
  "operation": "force-push",
  "result": "...",
  "warning": "Force push completed - Git history has been rewritten"
}
```

### Branch & Ref Operations

All accept the optional `repoPath`. Refs must not begin with `-` (rejected as
unsafe). Operations that create a commit resolve the author identity from
Node-RED user settings or git config.

#### `POST /rosepetal-git/create-branch`
Create a branch, optionally checking it out.

**Request**
```json
{ "name": "feature/x", "startPoint": "main", "checkout": true }
```
`startPoint` (optional) is any ref to branch from. `checkout` defaults to `true`.

**Response 200**
```json
{ "success": true, "operation": "create-branch", "branch": "feature/x", "checkedOut": true, "startPoint": "main", "flowFileChanged": false }
```
- `flowFileChanged`: when `checkout` is true and `startPoint` is an earlier
  commit, the working tree is rewritten; this reports whether the flow file
  actually changed (so the editor only resyncs when needed).

#### `POST /rosepetal-git/orphan-branch`
Create a branch with **no history** (`git checkout --orphan`). With
`keepContent: true` (default) the working tree carries over so the first commit
captures current content; `false` clears the index to start empty.

**Request**
```json
{ "name": "clean-slate", "keepContent": true }
```

#### `POST /rosepetal-git/delete-branch`
Delete a branch. A safe delete (`force` omitted) fails if the branch has
unmerged commits. Force-delete requires `confirmed: true`.

**Request**
```json
{ "name": "feature/x", "force": true, "confirmed": true }
```

#### `POST /rosepetal-git/rename-branch`
Rename a branch. Omit `from` to rename the current branch.

**Request**
```json
{ "from": "old-name", "to": "new-name" }
```

#### `POST /rosepetal-git/set-upstream`
Link a local branch to a remote branch (its tracking upstream). Defaults the
branch to the current one and the remote to `origin`.

**Request**
```json
{ "branch": "main", "remote": "origin", "remoteBranch": "main" }
```

**Response 200**
```json
{ "success": true, "operation": "set-upstream", "branch": "main", "upstream": "origin/main" }
```

#### `POST /rosepetal-git/merge`
Merge a ref into the current branch. `noFastForward: true` forces a merge commit.

**Request**
```json
{ "ref": "feature/x", "noFastForward": false }
```

**Response 200**
```json
{ "success": true, "operation": "merge", "ref": "feature/x", "conflicted": false, "conflictedFiles": [], "flowFileChanged": true, "result": "..." }
```

> `merge`, `pull`, `revert`, and `cherry-pick` can leave the repo mid-operation
> on a conflict. Instead of throwing, they return `200` with
> `"conflicted": true` and `"conflictedFiles": [...]`. The flow file then contains
> conflict markers (invalid JSON) — do **not** redeploy from it. Resolve the files
> and commit, or call `POST /rosepetal-git/abort` to undo the operation.
>
> `merge`, `pull`, and `revert` also return `flowFileChanged` (see `checkout`):
> the editor only needs to resync from disk when it is `true` and there is no
> conflict. Merges/pulls run headless (`--no-edit`), so a merge commit never
> blocks on an editor.

#### `POST /rosepetal-git/revert`
Create a new commit that undoes a previous commit (`git revert`, history-safe).
`noCommit: true` stages the revert without committing. May report a conflict (see note above).

**Request**
```json
{ "commitRef": "abc123", "noCommit": false }
```

#### `POST /rosepetal-git/cherry-pick`
Apply a commit onto the current branch. `noCommit: true` stages without committing.
May report a conflict (see note above).

**Request**
```json
{ "commitRef": "abc123", "noCommit": false }
```

#### `POST /rosepetal-git/abort`
Abort whatever operation is in progress (`merge` / `cherry-pick` / `revert` /
`rebase` — see `mergeState` in `project-info`), returning the repo to its
pre-operation state. Errors with `400` if nothing is in progress.

**Request**
```json
{}
```

**Response 200**
```json
{ "success": true, "operation": "abort", "kind": "merge" }
```

#### `POST /rosepetal-git/discard-all`
Discard **all** working changes: hard reset to `HEAD` and remove untracked files
(`clean -fd`, respecting `.gitignore`). Requires `confirmed: true`.

**Request**
```json
{ "confirmed": true }
```

### Diff Operations

#### `POST /rosepetal-git/file-diff`
Unified text diff for a file between two refs (or a ref and the working tree).

**Request**
```json
{ "file": "package.json", "base": "HEAD", "head": null }
```
Omit `head` (or send `null`) to diff against the working tree. Omit `file` to
diff the whole tree.

**Response 200**
```json
{ "success": true, "operation": "file-diff", "base": "HEAD", "head": "working", "file": "package.json", "diff": "diff --git a/package.json..." }
```

#### `POST /rosepetal-git/commit-diff`
List the files changed in a commit (name-status, vs its parent; the root commit
lists all files as additions).

**Request**
```json
{ "commitRef": "abc123" }
```

**Response 200**
```json
{ "success": true, "operation": "commit-diff", "commit": "abc123", "files": [ { "status": "M", "path": "flows.json" } ] }
```

#### `POST /rosepetal-git/commit-branches`
List the branches that **contain** a commit (answers "what branch is this commit
on?"). Local and remote are returned separately; `origin/HEAD` and the
detached-HEAD marker are filtered out.

**Request**
```json
{ "commitRef": "abc123" }
```

**Response 200**
```json
{ "success": true, "operation": "commit-branches", "commit": "abc123", "branches": ["main", "feature/x"], "remoteBranches": ["origin/main"], "current": "main" }
```

### Flow-Aware Operations

Node-RED stores all flows in a single `flows.json` (a flat array of node
objects). These endpoints present it as logical **units** so you can diff and
revert one flow at a time without touching the others. The file on disk stays a
single file — the decomposition is logical.

A unit is one of:
- **flow** — a tab and every node on it (`id` = the tab's id)
- **subflow** — a subflow definition and its internal nodes (`id` = the subflow's id)
- **config** — all global config nodes, grouped into a single unit (`id` = `"__config__"`)

A ref of the literal string `"WORKING"` (or an omitted ref) means the working
tree on disk.

#### `POST /rosepetal-git/flow-units`
List the logical units present at a ref (or the working tree).

**Request**
```json
{ "ref": "HEAD" }
```

**Response 200**
```json
{
  "success": true,
  "operation": "flow-units",
  "ref": "HEAD",
  "units": [
    { "id": "a1b2c3d4", "kind": "flow", "label": "Main", "nodeCount": 12 },
    { "id": "e5f6...",   "kind": "subflow", "label": "Resize Image", "nodeCount": 4 },
    { "id": "__config__", "kind": "config", "label": "Configuration", "nodeCount": 3 }
  ]
}
```

#### `POST /rosepetal-git/flow-diff`
Per-unit diff between two refs (defaults: `base` = `HEAD`, `head` = working tree).
Each unit reports a `status` (`added` / `removed` / `modified` / `unchanged`) and
the nodes added/removed/modified within it. Pass `detail: true` to include full
node bodies (base + head for modified nodes) instead of summaries.

**Request**
```json
{ "base": "HEAD", "head": null, "detail": false }
```

**Response 200**
```json
{
  "success": true,
  "operation": "flow-diff",
  "base": "HEAD",
  "head": "working",
  "changed": 1,
  "units": [
    {
      "id": "a1b2c3d4",
      "kind": "flow",
      "label": "Main",
      "status": "modified",
      "counts": { "added": 1, "removed": 0, "modified": 2 },
      "added":   [ { "id": "n9", "type": "function", "name": "transform" } ],
      "removed": [],
      "modified": [ { "id": "n2", "type": "mqtt out" } ]
    }
  ]
}
```

To see what a past commit changed at flow level, diff it against its parent:
`{ "base": "abc123^", "head": "abc123" }`.

#### `POST /rosepetal-git/revert-flow-unit`
Revert a single unit to its version at `ref`, leaving every other unit untouched.
Writes the working `flows.json` but does **not** commit — the result shows up as a
normal working-tree change to review and commit (or reload via the flow-reload
pattern below).

**Request**
```json
{ "unitId": "a1b2c3d4", "ref": "HEAD", "includeDependencies": false }
```

If the reverted flow references config nodes or subflows that differ, they are
reported under `dependencies`. Set `includeDependencies: true` to also revert
those units (the whole `config` unit is reverted if any config node is referenced).

**Response 200**
```json
{
  "success": true,
  "operation": "revert-flow-unit",
  "unitId": "a1b2c3d4",
  "ref": "HEAD",
  "revertedUnits": ["a1b2c3d4"],
  "dependencies": {
    "config":   [ { "id": "c1", "type": "mqtt-broker" } ],
    "subflows": [ { "id": "e5f6...", "label": "Resize Image" } ]
  },
  "file": "flows.json",
  "warning": "The reverted flow references config/subflow units that were not reverted; they may be out of sync."
}
```

**Important**: After a flow revert, reload flows from disk (see Flow Reload
Pattern) so the editor and runtime pick up the change.

#### `POST /rosepetal-git/revert-flow-nodes`
Revert individual nodes (by id) to their version at `ref`, leaving the rest of
the flow file untouched. A modified node is reset, a node added in the working
tree is removed, and a deleted node is re-added. Writes the working `flows.json`
without committing.

**Request**
```json
{ "nodeIds": ["abc123", "def456"], "ref": "HEAD" }
```

**Response 200**
```json
{
  "success": true,
  "operation": "revert-flow-nodes",
  "nodeIds": ["abc123"],
  "ref": "HEAD",
  "file": "flows.json",
  "dependencies": { "config": [], "subflows": [] },
  "warning": null
}
```

Like a flow revert, this can leave a dangling wire/config reference if you revert
a node but not what it points to; `dependencies` reports referenced config/subflow
units. Reload flows from disk afterward.

## Error Handling

The plugin provides context-aware error messages with actionable suggestions:

**Merge Conflict**
```json
{
  "success": false,
  "error": "Merge conflict detected during pull",
  "details": "CONFLICT (content): Merge conflict in flows.json",
  "suggestion": "Your local changes conflict with changes from the remote. You need to:\n1. Pull the changes\n2. Resolve conflicts manually\n3. Commit the resolved changes"
}
```

**Push Rejected**
```json
{
  "success": false,
  "error": "Push rejected: Remote has newer commits",
  "details": "! [rejected] main -> main (fetch first)",
  "suggestion": "Pull the remote changes first, then push:\n1. Click the Pull button\n2. Resolve any merge conflicts\n3. Click Push again"
}
```

**Authentication Failed**
```json
{
  "success": false,
  "error": "Authentication failed",
  "details": "Permission denied (publickey)",
  "suggestion": "Git authentication error:\n1. Check Node-RED SSH keys are configured\n2. Verify repository permissions\n3. Check remote URL is correct"
}
```

## Integration Notes

### Flow Reload Pattern
After destructive Git operations (checkout, reset, pull, discard), the UI keeps
the editor in sync with disk by:
1. Calling the Git operation endpoint
2. `POST /flows` with header `Node-RED-Deployment-Type: reload`, which tells the
   Node-RED runtime to re-read its flow file from disk
3. Reloading the editor with `window.location.reload()`

This prevents editor state from diverging from disk state.

### Detached HEAD Safety
When committing in detached HEAD state, the endpoint automatically creates a new branch named `from-<hash>` to prevent orphaned commits.

### SSH Key Configuration
The plugin uses Node-RED's project SSH keys (in `~/.node-red/projects/.sshkeys/`) rather than the user's `~/.ssh` keys. The key is resolved per project: an explicit selection, else a key whose name matches the project, else the only key present.
