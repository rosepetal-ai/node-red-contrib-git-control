---
title: "HTTP API Reference - Git Control for Node-RED"
description: "Admin HTTP endpoints of the Git Control plugin for Node-RED: authentication, permissions, and the request and response of every Git and flow-aware operation under /rosepetal-git. Part of @rosepetal/node-red-contrib-git-control."
sidebar_label: "HTTP API"
head:
  - - meta
    - name: "keywords"
      content: "node-red, git, http api, admin api, rosepetal-git, flows.json, flow diff, merge conflict, version control, rosepetal"
  - - meta
    - property: "og:title"
      content: "HTTP API Reference - @rosepetal/node-red-contrib-git-control"
  - - meta
    - property: "og:description"
      content: "Admin HTTP endpoints of the Git Control plugin for Node-RED: authentication, permissions, and the request and response of every operation."
---

# HTTP API Reference

The plugin exposes Git control operations via HTTP Admin API endpoints. All routes live on the Node-RED admin server (usually `http://localhost:1880`) under the base path `/rosepetal-git`.

## Authentication & Permissions

- Routes honor Node-RED admin authentication when it is enabled.
- Read-only operations require the `git-control.read` permission; mutating
  operations require `git-control.write`. Note this is by *operation*, not HTTP
  verb — several read-only endpoints are `POST` (they take a JSON body) but still
  only need `read` (e.g. `status`, `branches`, `flow-diff`, `file-diff`).
- One exception: `log` only reads the history, but its route is registered with
  `git-control.write`.

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

All POST bodies are JSON (`Content-Type: application/json`).

### Danger levels

| Level | Endpoints | Notes |
|-------|-----------|-------|
| safe (read-only) | `project-info`, `status`, `log`, `branches`, `validate-checkout`, `flow-units`, `flow-diff`, `file-diff`, `commit-diff`, `commit-branches`, `merge/preview`, `ssh-keys` | never modify the repo |
| writes working tree / history | `add`, `unstage`, `commit`, `checkout`, `fetch`, `pull`, `push`, `merge`, `merge/resolve`, `revert`, `cherry-pick`, `abort`, `create-branch`, `orphan-branch`, `rename-branch`, `set-upstream` | reversible via git |
| plugin settings | `ssh-key` | writes `git-control.json` in the Node-RED user directory, not the repository |
| destructive | `force-push`, `discard-all`, `delete-branch` *(with `force: true`)*, `reset` *(hard)*, `discard`, `revert-flow-unit`, `revert-flow-nodes` | can discard work or rewrite history. `force-push`, `discard-all` and a forced `delete-branch` need `confirmed: true`; a hard `reset` needs `safeMode: false`; `discard` and the two flow reverts overwrite uncommitted changes without a flag |

All responses are JSON. Errors return:
```json
{
  "success": false,
  "error": "Human-readable error message",
  "details": "Technical error details (optional)",
  "suggestion": "Actionable suggestion for resolution (optional)"
}
```

`details` and `suggestion` are missing from the errors of `project-info`,
`status`, `validate-checkout`, `branches`, `add`, `flow-units`, `ssh-keys` and
`ssh-key`, which send only `error`. When `fetch`, `pull`, `push` or `force-push`
fail on authentication, the body also has `"requiresAuth": true` and
`"code": "git_auth_failed"`. Errors are `500` unless an endpoint below says
otherwise.

## Common Patterns

### Request Structure
All POST endpoints accept JSON bodies with at minimum:
```json
{
  "repoPath": "/path/to/repo"  // Optional - defaults to active Node-RED project
}
```

`project-info` and `ssh-keys` (GET) always work on the active project.

### Response Structure
Success responses include (`project-info`, `validate-checkout`, `ssh-keys` and
`ssh-key` have no `operation`):
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
  "flowFile": "flows.json",
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

- `lastKnownBranch`: the last branch the plugin saw checked out (kept in memory);
  `currentBranch` is `null` while `HEAD` is detached.
- `user`: the Git name and email of the Node-RED user settings; when neither is
  set there, those of the Git configuration.
- `flowFile`: the project's flow file, relative to the repository root: the one
  the project's `package.json` names, else Node-RED's `flowFile` setting when it
  is inside the repository, else `flows.json`. Every flow-aware endpoint works on
  this file.
- `sshKeyConfigured`: whether an SSH key applies to the project (see SSH Keys below).
- `conflicted`: paths with unresolved merge conflicts (empty when clean).
- `diverged`: `true` when the branch is both ahead of and behind its remote (a plain push will be rejected — pull first, or `force-push`).
- `mergeState.inProgress` / `kind`: a `merge` / `cherry-pick` / `revert` / `rebase` left mid-flight (usually by a conflict). `kind` is also the subcommand `/abort` uses. See `POST /rosepetal-git/abort`.

With no active project, or when the active project is not a Git repository, the
response is still `200`, with `"success": false` and an `error` message.

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
`maxCount` defaults to 20 (the sidebar asks for 50). `from` and `to` restrict the
history to a range; on a branch they are passed to `git log` as `from...to`.
While `HEAD` is detached, the history is that of the last branch the plugin saw
checked out, or else of a branch that contains `HEAD`.

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
      "date": "2025-01-14 10:30:00 +0100",
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

- `total`: the number of commits returned.
- `pushed`: whether the commit is reachable from the upstream of the current
  branch (from `origin/<branch>` when it has none).
- `isHead`: whether the commit is `HEAD`.
- `branches`: the local branches whose tip is this commit.

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
    "renamed": [],
    "conflicted": [],
    "not_added": [],
    "detached": false
  }
}
```

`status` is the status summary of the `simple-git` library: `files` has every
changed path with its index and working-tree codes; `not_added` lists untracked
files and `conflicted` the files with unresolved conflicts.

#### `POST /rosepetal-git/branches`
Lists all local and unique remote branches, the remotes, and for every local
branch its upstream and how far it is from it (as of the last fetch).

**Response 200**
```json
{
  "success": true,
  "operation": "branches",
  "current": "main",
  "tracking": "origin/main",
  "all": ["main", "develop", "feature-branch", "hotfix"],
  "local": ["main", "develop", "feature-branch"],
  "remoteOnly": ["hotfix"],
  "remoteBranches": ["origin/main", "origin/develop", "origin/hotfix"],
  "remotes": ["origin"],
  "upstreams": {
    "main": { "upstream": "origin/main", "ahead": 1, "behind": 0, "gone": false },
    "develop": { "upstream": "origin/develop", "ahead": 0, "behind": 3, "gone": false },
    "feature-branch": { "upstream": null, "ahead": 0, "behind": 0, "gone": false }
  },
  "branches": {
    "main": {
      "current": true,
      "linkedWorkTree": false,
      "name": "main",
      "commit": "abc1234",
      "label": "Subject of the last commit"
    }
  }
}
```

- `current`: the current branch (the short hash of `HEAD` while it is detached).
- `tracking`: the upstream of the current branch, or `null`.
- `local`: the local branches. `remoteOnly`: the branches of `origin` that have no
  local branch of the same name. `all` is both lists together.
- `remoteBranches`: every remote branch as `<remote>/<branch>` (without the `HEAD` alias).
- `upstreams`: `gone` is `true` when the upstream was deleted on the remote.
- `branches`: every local and remote branch (remote ones keyed
  `remotes/<remote>/<branch>`) with its abbreviated tip commit; `label` is the
  subject of that commit.

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
  checkout that doesn't touch the flow file requires no resync. (The sidebar
  reloads after every checkout anyway.)

The checkout runs `git checkout <commitRef>`: a name that exists only as
`origin/<name>` becomes a local branch that tracks it, and Git refuses when
uncommitted changes would be overwritten. The plugin does not check for
uncommitted changes itself; see `validate-checkout`.

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

- `uncommittedCount`: every changed path, untracked files included.
- `targetRef`: echoed from the request; it does not change the result.
- `currentRef`: the full hash of `HEAD`. `currentBranch` is the string
  `"detached HEAD"` while `HEAD` is detached.

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
`stageAll` runs `git add .`. Without `stageAll` or `files` the request fails
with `Either stageAll or files array is required`.

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
It runs `git reset HEAD` (with `-- <files>` for specific files).

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

`message` is required; without it the response has
`"error": "Git commit failed"` and `"details": "Commit message is required"`.

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
  "branch": "main",
  "createdBranch": false
}
```

In detached HEAD the commit is followed by a new branch named `from-` plus the
first seven characters of the new commit's hash (`-1`, `-2` and so on are added
when that name is taken), and the response has `"createdBranch": true`, the new
`branch`, `"message": "Created commit and new branch 'from-…'"` and
`"warning": null`. When the branch cannot be created, the commit stays in
detached HEAD: `createdBranch` is `false`, `branch` is `null` and `warning`
says why.

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
`commitRef` is required. `resetMode` defaults to `mixed` and `safeMode` to
`true`, so a hard reset needs `"safeMode": false`.

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
  "error": "Git reset failed",
  "details": "Hard reset is disabled in safe mode",
  "suggestion": "Check the error details above. If the issue persists, try running the operation from the command line for more information."
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
  "restored": ["flows.json", "package.json"],
  "removed": []
}
```

- `restored`: tracked files, reset with `git checkout --`. That command restores
  a file from the index, so staged changes are kept, and a new file that is
  already staged is left as it is (it is still listed here).
- `removed`: untracked files, deleted with `git clean -fd` (ignored files are never touched).

`files` must be a non-empty array.

### Remote Operations

These four endpoints authenticate with the project's SSH key when one applies
(see SSH Keys below). Git cannot prompt for credentials, and a command that
prints nothing for two minutes is stopped and reported as an error.

#### `POST /rosepetal-git/fetch`
Fetches updates from remote without merging (`git fetch --prune`).

**Response 200**
```json
{
  "success": true,
  "operation": "fetch"
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
  These errors, and `Cannot pull in detached HEAD state.`, come in `details`
  with `"error": "Git pull failed"`.

#### `POST /rosepetal-git/push`
Pushes the current branch's commits to the remote.

When the branch already has an upstream, it pushes to that upstream
(`git push <remote> HEAD:<upstream-branch>`, so it also works when the local and
upstream branch names differ):
```json
{
  "success": true,
  "operation": "push",
  "branch": "main",
  "setUpstream": false,
  "upstream": "origin/main"
}
```

When the branch has **no upstream yet**, it runs `git push -u <remote> <branch>`
with `origin`, or the first remote when there is no `origin`. That **creates**
the remote branch when it does not exist and sets it as the tracking upstream:
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
- `upstream`: the tracking ref after the push.

It fails (`"error": "Git push failed"`) in detached HEAD (`details`:
`Cannot push while in detached HEAD state`) and when the repository has no
remote (`No Git remotes configured for this repository`).

**Optional request body** — publish to an explicit remote branch (creates it if
missing and sets it as upstream, overriding any prior one). Used by the tracking
picker's "create `origin/<name>`" option. `targetRemote` defaults to `origin`:
```json
{ "targetRemote": "origin", "targetBranch": "feature-branch" }
```
This runs `git push -u <targetRemote> HEAD:<targetBranch>`, so it works even when
the branch currently tracks a differently-named upstream.

#### `POST /rosepetal-git/force-push`
Force pushes with `--force-with-lease` (requires confirmation). It pushes to the
branch's upstream and errors when the branch has none.

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
  "branch": "main",
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
captures current content; `false` clears the index (`git rm -rf --cached .`), so
the files stay on disk as untracked files.

**Request**
```json
{ "name": "clean-slate", "keepContent": true }
```

**Response 200**
```json
{ "success": true, "operation": "create-orphan-branch", "branch": "clean-slate", "keepContent": true, "flowFileChanged": false }
```

#### `POST /rosepetal-git/delete-branch`
Delete a local branch (`git branch -d`, or `-D` with `force`). A safe delete
(`force` omitted) fails if the branch has unmerged commits. Force-delete
requires `confirmed: true`.

**Request**
```json
{ "name": "feature/x", "force": true, "confirmed": true }
```

**Response 200**
```json
{ "success": true, "operation": "delete-branch", "branch": "feature/x", "forced": true }
```

**Response 400** (`force` without `confirmed`)
```json
{
  "success": false,
  "error": "Force-deleting a branch can discard unmerged commits; confirmation required",
  "requiresConfirmation": true
}
```

A safe delete of an unmerged branch fails with `"error": "Branch is not fully merged"`.

#### `POST /rosepetal-git/rename-branch`
Rename a branch. Omit `from` to rename the current branch.

**Request**
```json
{ "from": "old-name", "to": "new-name" }
```

**Response 200**
```json
{ "success": true, "operation": "rename-branch", "from": "old-name", "to": "new-name", "upstream": null }
```

After the rename the upstream is realigned: the branch tracks `origin/<to>` when
that remote branch exists (`upstream` is then `"origin/<to>"`), otherwise its
upstream is removed, so the next push creates `origin/<to>`. `from` is `null`
in the response when it was omitted.

#### `POST /rosepetal-git/set-upstream`
Link a local branch to a remote branch (its tracking upstream). Defaults the
branch to the current one, the remote to `origin` and `remoteBranch` to the
local branch name. The remote branch must exist.

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
> and commit, or call `POST /rosepetal-git/abort` to undo the operation. For a
> merge whose only conflicted file is the flow file, `merge/preview` and
> `merge/resolve` (below) resolve it node by node.
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

**Response 200**
```json
{ "success": true, "operation": "revert", "commit": "abc123", "noCommit": false, "conflicted": false, "conflictedFiles": [], "flowFileChanged": true, "result": "..." }
```

#### `POST /rosepetal-git/cherry-pick`
Apply a commit onto the current branch. `noCommit: true` stages without committing.
May report a conflict (see note above).

**Request**
```json
{ "commitRef": "abc123", "noCommit": false }
```

**Response 200**
```json
{ "success": true, "operation": "cherry-pick", "commit": "abc123", "noCommit": false, "conflicted": false, "conflictedFiles": [], "result": "..." }
```

#### `POST /rosepetal-git/abort`
Abort whatever operation is in progress (`merge` / `cherry-pick` / `revert` /
`rebase` — see `mergeState` in `project-info`), returning the repo to its
pre-operation state. Errors with `500` if nothing is in progress.

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

**Response 200**
```json
{ "success": true, "operation": "discard-all" }
```

**Response 400** (without `confirmed`)
```json
{
  "success": false,
  "error": "Discarding all changes is irreversible; confirmation required",
  "requiresConfirmation": true
}
```

### Diff Operations

#### `POST /rosepetal-git/file-diff`
Unified text diff for a file between two refs (or a ref and the working tree).

**Request**
```json
{ "file": "package.json", "base": "HEAD", "head": null }
```
`base` defaults to `HEAD`. Omit `head` (or send `null`) to diff against the
working tree. Omit `file` to diff the whole tree. Untracked files have no diff.

**Response 200**
```json
{ "success": true, "operation": "file-diff", "base": "HEAD", "head": "working", "file": "package.json", "diff": "diff --git a/package.json..." }
```

#### `POST /rosepetal-git/commit-diff`
List the files changed in a commit (name-status, vs its parent; the root commit
lists all files as additions). The list is empty for a merge commit
(`git diff-tree` without `-m`); `flow-diff` against the first parent
(`abc123^`) shows what a merge changed in the flows.

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

Node-RED stores all flows in a single flow file (`flowFile` in `project-info`),
a flat array of node objects. These endpoints present
it as logical **units** so you can diff and revert one flow at a time without
touching the others. The file on disk stays a single file — the decomposition is
logical.

A unit is one of:
- **flow** — a tab and every node on it (`id` = the tab's id)
- **subflow** — a subflow definition and its internal nodes (`id` = the subflow's id)
- **config** — every node without a `z` (the global config nodes), grouped into a
  single unit (`id` = `"__config__"`)

Units are listed flows first, then subflows, then the config unit. A unit's
`label` is the tab's label or the subflow's name (`Flow <id>` / `Subflow <id>`
with the first eight characters of the id when it has none) and `Configuration`
for the config unit. Nodes are compared by id, ignoring the order of their keys.

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

- `units`: every unit present on either side, unchanged ones included (`status`
  `unchanged`, empty lists). `changed` counts the others.
- Without `detail`, `added` and `removed` hold `{ id, type, name }` and
  `modified` holds `{ id, type }`. With `detail`, `added` and `removed` hold the
  full nodes and `modified` holds `{ id, base, head }`.

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

`ref` defaults to `HEAD`. A unit that does not exist at `ref` is removed from
the file; a unit that exists at `ref` but not in the working tree is added back.

The config nodes and subflows that the reverted unit references are reported
under `dependencies`, whether or not they differ, and `warning` is set when
there are any and `includeDependencies` is false. Set `includeDependencies: true`
to also revert those units (the whole `config` unit is reverted if any config
node is referenced). A config node counts as referenced when a node property,
or a string in an array property, holds its id; a subflow, when a node's type is
`subflow:<id>`.

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
`nodeIds` is required; `ref` defaults to `HEAD`.

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

### Flow-Aware Conflict Resolution

When a merge (or a pull that merges) stops on a conflict in the flow file, these
two endpoints resolve it by node instead of by text line. The three sides of the
conflict are **base** (the common ancestor), **ours** (the current branch) and
**theirs** (the branch being merged). They are merged by node id inside each unit
(see Flow-Aware Operations above): a node changed on one side only, or changed
identically on both, is merged automatically; a node changed differently on both
sides, changed on one and deleted on the other, or added on both with different
content, is a conflict that needs a choice.

#### `POST /rosepetal-git/merge/preview`
Report what the flow-aware merge can do with the operation in progress. Writes
nothing, and needs only `git-control.read`.

**Request**
```json
{}
```

**Response 200** (the flow file is conflicted)
```json
{
  "success": true,
  "operation": "merge-preview",
  "kind": "merge",
  "flowFileMergeable": true,
  "autoMerged": 1,
  "conflicts": [
    {
      "unitId": "a1b2c3d4",
      "kind": "flow",
      "label": "Main",
      "unitConflict": null,
      "perNode": [
        {
          "id": "n1",
          "kind": "inject",
          "base":   { "id": "n1", "type": "inject", "z": "a1b2c3d4", "name": "tick" },
          "ours":   { "id": "n1", "type": "inject", "z": "a1b2c3d4", "name": "tick-ours" },
          "theirs": { "id": "n1", "type": "inject", "z": "a1b2c3d4", "name": "tick-theirs" }
        }
      ]
    }
  ],
  "otherFiles": [],
  "oursRef": "main",
  "theirsRef": "feature/x",
  "oursCommit":   { "hash": "0fce908...", "shortHash": "0fce908", "message": "Rename tick", "author": "John Doe", "when": "2025-01-14 10:30:00 +0100" },
  "theirsCommit": { "hash": "7dcabc4...", "shortHash": "7dcabc4", "message": "Rename tick too", "author": "Jane Doe", "when": "2025-01-14 09:12:00 +0100" },
  "mergeBase": { "hash": "362a029...", "shortHash": "362a029" },
  "mergeMessage": "Merge branch 'feature/x'\n\n# Conflicts:\n#\tflows.json\n"
}
```

- `kind`: the operation in progress (`merge`, `cherry-pick`, `revert` or `rebase`).
- `autoMerged`: how many nodes, in units that exist on all three sides, were
  added or changed on one side (or identically on both) and merged without a
  choice. Nodes deleted without a conflict are not counted.
- `conflicts`: one entry per unit that needs a choice. `perNode` lists the
  conflicting nodes with their three versions (the node's `kind` is its type); a
  version is `null` where the node does not exist on that side.
- `unitConflict`: `null` when the conflicts are per node. `"modify-delete"` when
  one side deleted the whole unit and the other changed it (`deletedSide` says
  which: `"ours"` or `"theirs"`), and `"add-add-different"` when both sides added
  the unit with different content. `perNode` is empty for these two; they take a
  `byUnit` choice.
- `otherFiles`: conflicted files other than the flow file. These endpoints do not
  resolve them.
- `oursRef` / `theirsRef`, `oursCommit` / `theirsCommit`, `mergeBase`: the two
  branches, their tip commits and the common ancestor. Each is `null` when it
  cannot be read.
- `mergeMessage`: the message Git prepared in `.git/MERGE_MSG`, or `null`.

When the flow file is not among the conflicted files:
```json
{ "success": true, "operation": "merge-preview", "kind": "merge", "flowFileMergeable": false, "reason": "flow file is not conflicted", "conflicts": [], "autoMerged": 0, "otherFiles": ["notes.txt"] }
```

Errors with `500` if no operation is in progress.

#### `POST /rosepetal-git/merge/resolve`
Apply the choices, write the merged flow file, stage it and create the merge
commit. Works on an in-progress `merge` only, not on a cherry-pick, revert or
rebase.

**Request**
```json
{
  "choices": {
    "byNode": { "n1": "theirs" },
    "byUnit": { "a1b2c3d4": "ours" }
  },
  "fallback": "auto",
  "commitMessage": "Merge branch 'feature/x'"
}
```

- `choices.byNode`: `"ours"` or `"theirs"` for the id of a node in `perNode`.
- `choices.byUnit`: `"ours"` or `"theirs"` for a `unitId`. It resolves a
  `unitConflict`, and every node conflict of that unit that has no `byNode` choice.
- `fallback`: `"ours"` or `"theirs"` takes that side for **every** conflict and
  overrides `byNode` and `byUnit`. Any other value (default `"auto"`) resolves
  nothing by itself.
- `commitMessage` (optional): defaults to the message in `.git/MERGE_MSG`, or
  `Merge` when there is none.
- Choosing the side that deleted a node or a unit drops it.

**Response 200**
```json
{ "success": true, "operation": "merge-resolve", "commit": "abc123...", "summary": { "changes": 0, "insertions": 0, "deletions": 0 }, "autoMerged": 1, "flowFileChanged": true }
```

**Error 409** (a conflict has no choice; `conflicts` has the shape of `merge/preview`)
```json
{
  "success": false,
  "error": "Unresolved conflicts remain",
  "details": "Provide a choice for each flagged node/unit, or set fallback to \"ours\" or \"theirs\".",
  "conflicts": [ { "unitId": "a1b2c3d4", "kind": "flow", "label": "Main", "unitConflict": null, "perNode": [ ... ] } ]
}
```

**Error 409** (another file is still conflicted)
```json
{
  "success": false,
  "error": "Other files still have conflicts",
  "details": "The flow file resolver can only complete a merge when flows.json is the only conflicted file.",
  "files": ["notes.txt"]
}
```

Errors with `500` if no operation is in progress, or if the operation in progress
is not a merge.

> Call `merge/resolve` only after `merge/preview` returned
> `"flowFileMergeable": true`. The endpoint does not check it: called during a
> merge in which the flow file is not conflicted (and no other file is), it writes
> an empty flow file (`[]`) and commits it.

### SSH Keys

Network operations use one of Node-RED's project SSH keys when one applies (see
SSH Key Configuration below). These two endpoints show and set which one.

#### `GET /rosepetal-git/ssh-keys`
List the available keys and the one used for the active project.

**Response 200**
```json
{ "success": true, "keys": ["__default_my-project", "deploy"], "selected": null, "effective": "__default_my-project" }
```

- `keys`: the private keys in the keys directory that have a matching `.pub` file.
- `selected`: the key selected for the project with `ssh-key`, or `null`.
- `effective`: the key that network operations will use, or `null` when none
  applies.

#### `POST /rosepetal-git/ssh-key`
Select the key of the project. The choice is saved per repository path in
`git-control.json`, in the Node-RED user directory. An empty or omitted `keyName`
clears the selection.

**Request**
```json
{ "keyName": "deploy" }
```

**Response 200**
```json
{ "success": true, "selected": "deploy" }
```

**Error 400** (the name is not in `keys`)
```json
{ "success": false, "error": "Unknown SSH key: other-key" }
```

## Error Handling

The plugin matches the Git error text against known cases and sends a message
with a suggestion; `details` keeps Git's own output. Unknown errors get
`"error": "Git <operation> failed"`. A few examples:

**Conflict** (here, `commit` without `stageAll` while files are still unmerged;
a conflict that a merge, pull, revert or cherry-pick runs into is not an error,
see the note under `merge`)
```json
{
  "success": false,
  "error": "Merge conflict detected during commit",
  "details": "U\tflows.json\nerror: Committing is not possible because you have unmerged files.\n...\nfatal: Exiting because of an unresolved conflict.\n",
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

**Authentication Failed** (from `fetch`, `pull`, `push` or `force-push`)
```json
{
  "success": false,
  "error": "Authentication failed",
  "details": "git@github.com: Permission denied (publickey).",
  "suggestion": "Git authentication error:\n1. Check Node-RED SSH keys are configured\n2. Verify repository permissions\n3. Check remote URL is correct",
  "requiresAuth": true,
  "code": "git_auth_failed"
}
```

## Integration Notes

### Flow Reload Pattern
After operations that can change the flow file on disk (checkout, create-branch
with checkout, orphan-branch, reset, revert, merge, pull, merge/resolve, discard,
revert-flow-unit, revert-flow-nodes), the UI keeps the editor in sync with disk by:
1. Calling the Git operation endpoint
2. `POST /flows` with header `Node-RED-Deployment-Type: reload`, which tells the
   Node-RED runtime to re-read its flow file from disk
3. Reloading the editor with `window.location.reload()`

This prevents editor state from diverging from disk state. The UI skips the
reload when the operation reports `"conflicted": true`, and when a pull was up to
date or stopped with `needsMerge`.

### Detached HEAD Safety
When committing in detached HEAD state, the endpoint automatically creates a new branch named `from-<hash>` to prevent orphaned commits (see `commit`).

### SSH Key Configuration
When a key applies, network operations use one of Node-RED's project SSH keys (in `<userDir>/projects/.sshkeys/`) instead of the user's `~/.ssh` keys and `~/.ssh/config`. The key is resolved per project: an explicit selection (`POST /rosepetal-git/ssh-key`), else a key whose file name is `__default_<project>` or ends in `_<project>`, else the only key present. When none applies, Git uses its default SSH settings.
