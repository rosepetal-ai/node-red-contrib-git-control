# HTTP API Reference

The plugin exposes Git control operations via HTTP Admin API endpoints. All routes live on the Node-RED admin server (usually `http://localhost:1880`) under the base path `/rosepetal-git`.

## Authentication & Permissions

- Routes honor Node-RED admin authentication when enabled
- `GET` routes require `git-control.read` permission
- `POST` routes require `git-control.write` permission
- If CSRF protection is enabled, include the editor's `_csrf` token in POST requests

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
  "hasTracking": true
}
```

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

#### `POST /rosepetal-git/show`
Shows detailed commit information and diff.

**Request**
```json
{
  "commitRef": "abc123"
}
```

**Response 200**
```json
{
  "success": true,
  "operation": "show",
  "commit": "abc123",
  "details": "commit abc123...\nAuthor: ...\nDate: ...\n\ndiff --git..."
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
  "result": "..."
}
```

**Important**: After checkout, the frontend must reload flows from disk to prevent data loss.

#### `POST /rosepetal-git/validate-checkout`
Validates if a checkout operation is safe (no uncommitted changes or unpushed commits).

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
  "blockers": ["uncommitted_changes", "unpushed_commits"],
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
  "message": "Commit message"
}
```

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
  "result": "..."
}
```

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
Pulls changes from remote and merges.

**Response 200**
```json
{
  "success": true,
  "operation": "pull",
  "result": {
    "files": ["flows.json"],
    "insertions": 10,
    "deletions": 5,
    "summary": {
      "changes": 1
    }
  }
}
```

**Important**: After pull, the frontend must reload flows from disk.

#### `POST /rosepetal-git/push`
Pushes commits to remote. Automatically sets upstream tracking for new branches.

**Response 200**
```json
{
  "success": true,
  "operation": "push",
  "result": "...",
  "branch": "main",
  "setUpstream": false
}
```

When pushing a new branch:
```json
{
  "success": true,
  "operation": "push",
  "result": "...",
  "branch": "feature-branch",
  "setUpstream": true
}
```

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

### Flow Synchronization

#### `POST /rosepetal-git/read-flows`
Reads flows.json from disk for reloading after Git operations.

**Response 200**
```json
{
  "success": true,
  "flows": [
    {
      "id": "tab1",
      "type": "tab",
      "label": "Flow 1"
    }
  ]
}
```

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
After destructive Git operations (checkout, reset, pull, discard), the UI must:
1. Call the Git operation endpoint
2. Call `POST /rosepetal-git/read-flows` to read flows.json from disk
3. Call `POST /flows` to deploy the flows to Node-RED runtime
4. Reload the editor with `window.location.reload()`

This prevents editor state from diverging from disk state.

### Detached HEAD Safety
When committing in detached HEAD state, the endpoint automatically creates a new branch named `from-<hash>` to prevent orphaned commits.

### SSH Key Configuration
The plugin uses Node-RED's project SSH keys (`~/.node-red/projects/.sshkeys/__default_NodeRedTest`) rather than the user's `~/.ssh` keys.

### Safe Mode
Hard reset operations are blocked by default (`safeMode: true`). The frontend must explicitly set `safeMode: false` after user confirmation.
