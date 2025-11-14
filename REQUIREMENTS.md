# REQUIREMENTS.md
# Node-RED Git Control Plugin - Comprehensive Requirements Document

**Version:** 2.0
**Last Updated:** 2025-01-14
**Status:** Active Development

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Functional Requirements](#functional-requirements)
3. [API Specifications](#api-specifications)
4. [Non-Functional Requirements](#non-functional-requirements)
5. [UI/UX Guidelines](#uiux-guidelines)
6. [Future Enhancements](#future-enhancements)

---

## Project Overview

### Purpose

Provide Node-RED users with a comprehensive Git control interface directly in the Node-RED editor sidebar, eliminating the need to switch to command-line tools for common Git operations.

### Target Users

- Node-RED developers managing flows in Git repositories
- Teams collaborating on Node-RED projects using version control
- Users who prefer GUI interfaces over command-line Git operations

### Success Criteria

- ✅ Users can perform 90% of common Git operations without leaving Node-RED
- ✅ Zero data loss through flow synchronization after Git operations
- ✅ Clear, actionable error messages for all Git failures
- ✅ Seamless integration with Node-RED's project system and SSH keys
- ✅ 5-second or less response time for all operations

### Current Implementation Status

**Completed Features:**
- Core Git operations (log, status, checkout, reset, commit, add)
- Remote synchronization (fetch, pull, push)
- Branch viewing and switching
- Flow reload after destructive operations
- Safe mode for dangerous operations
- Auto-refresh UI (5-second interval)

**In Development:**
- Branch creation and deletion
- Visual commit graph
- Enhanced commit management

---

## Functional Requirements

### FR-1: Repository Information Display

**Priority:** High
**Status:** Implemented

**Description:**
Display current Node-RED project Git information in the sidebar toolbar.

**Requirements:**
- **FR-1.1:** Project Name Display
  - Location: Toolbar header, left side
  - Format: Plain text, truncated if > 20 characters with "..."
  - Update: Real-time on project switch or rename

- **FR-1.2:** Current Branch Display
  - Location: Branch section, below toolbar
  - Format: Branch icon + branch name
  - Styling: Bold text for current branch
  - Update: Immediately after checkout or branch switch

- **FR-1.3:** Sync Status Indicators
  - Location: Toolbar buttons (pull/push)
  - Ahead indicator: Badge on push button showing commit count ahead of remote
  - Behind indicator: Badge on pull button showing commit count behind remote
  - Colors: Orange badges with white text
  - Update: After fetch, pull, or push operations

**Acceptance Criteria:**
- [ ] Project name appears within 2 seconds of sidebar opening
- [ ] Branch name updates immediately after checkout
- [ ] Sync indicators show correct commit counts
- [ ] No flash/flicker during updates

---

### FR-2: Branch Management

**Priority:** High
**Status:** Partial (view/switch implemented, create/delete pending)

#### FR-2.1: List All Branches

**Description:** Display all local branches in a dropdown selector.

**Requirements:**
- Load branches on sidebar open and after branch operations
- Show current branch as selected option
- Sort alphabetically
- Handle repositories with 50+ branches gracefully

**UI Location:** Branch selector dropdown (already implemented)

**Acceptance Criteria:**
- [x] All branches listed within 1 second
- [x] Current branch pre-selected
- [x] Branches sorted alphabetically

#### FR-2.2: Switch Branches

**Description:** Allow switching between branches with flow reload.

**Requirements:**
- User selects branch from dropdown
- Confirm uncommitted changes warning if applicable
- Execute checkout operation
- Reload flows.json from disk
- Refresh editor page

**UI Flow:**
1. User selects different branch from dropdown
2. If uncommitted changes exist: Show warning dialog
3. Execute checkout
4. Reload flows from disk
5. Reload browser page
6. Show success notification

**Acceptance Criteria:**
- [x] Branch switches successfully
- [x] Flows reload from disk
- [x] No data loss on switch
- [x] Success notification appears

#### FR-2.3: Create New Branch

**Priority:** High
**Status:** Not Implemented

**Description:** Create new branches from current HEAD or specific commits.

**Requirements:**

**UI Design:**
```
┌─────────────────────────────────────────────┐
│ Create New Branch                      [X]  │
├─────────────────────────────────────────────┤
│                                             │
│ Branch Name:                                │
│ ┌─────────────────────────────────────────┐│
│ │ feature/my-new-feature                  ││
│ └─────────────────────────────────────────┘│
│                                             │
│ Create from:                                │
│ ┌─────────────────────────────────────────┐│
│ │ ○ Current HEAD (main)                   ││
│ │ ○ Specific commit: [abc123...]          ││
│ └─────────────────────────────────────────┘│
│                                             │
│ [ ] Checkout new branch after creation     │
│                                             │
│        [Cancel]  [Create Branch]            │
└─────────────────────────────────────────────┘
```

**Validation Rules:**
- Branch name required (non-empty)
- No spaces or special characters except `-`, `_`, `/`
- Cannot start or end with `/`
- Cannot match existing branch name
- Max length: 255 characters

**UI Trigger:** "+" button next to branch selector

**Backend API:** `POST /rosepetal-git/create-branch`

**Request:**
```json
{
  "branchName": "feature/new-feature",
  "fromCommit": "abc123...", // optional, defaults to HEAD
  "checkout": true // optional, default false
}
```

**Response Success:**
```json
{
  "success": true,
  "operation": "create-branch",
  "branchName": "feature/new-feature",
  "commit": "abc123...",
  "checkedOut": true
}
```

**Response Error:**
```json
{
  "success": false,
  "error": "A branch with this name already exists",
  "details": "...",
  "suggestion": "Please choose a different branch name or delete the existing branch first"
}
```

**Acceptance Criteria:**
- [ ] Modal opens on "+" button click
- [ ] Branch name validated in real-time
- [ ] Cannot create duplicate branch names
- [ ] Success creates branch and optionally checks it out
- [ ] Error shows helpful message
- [ ] Branch list refreshes after creation

#### FR-2.4: Delete Branch

**Priority:** Medium
**Status:** Not Implemented

**Description:** Delete local branches with safety checks.

**Requirements:**

**UI Design:** Trash icon button appears on branch selector hover (except current branch)

**Confirmation Dialog:**
```
┌─────────────────────────────────────────────┐
│ Delete Branch                          [X]  │
├─────────────────────────────────────────────┤
│                                             │
│ Are you sure you want to delete the branch │
│ "feature/old-feature"?                      │
│                                             │
│ ⚠️ This action cannot be undone.            │
│                                             │
│ Branch status:                              │
│ • Not merged into main                      │
│ • Contains 3 commits not in main            │
│                                             │
│ [ ] Force delete (delete unmerged branch)   │
│                                             │
│        [Cancel]  [Delete Branch]            │
└─────────────────────────────────────────────┘
```

**Safety Checks:**
- Cannot delete current branch
- Warn if branch not merged
- Require force flag for unmerged branches
- Show commit count not in main branch

**Backend API:** `POST /rosepetal-git/delete-branch`

**Request:**
```json
{
  "branchName": "feature/old-feature",
  "force": false // required to delete unmerged branches
}
```

**Acceptance Criteria:**
- [ ] Cannot delete current branch
- [ ] Warning shown for unmerged branches
- [ ] Force flag required for unmerged deletion
- [ ] Branch list refreshes after deletion
- [ ] Success notification appears

---

### FR-3: Commit History View

**Priority:** High
**Status:** Partial (list implemented, graph pending)

#### FR-3.1: Simple List View (Current Implementation)

**Description:** Display commit history as a scrollable list.

**Requirements:**
- Load 50 commits initially
- "Load More" button to fetch additional commits
- Show for each commit:
  - Short hash (7 characters)
  - Commit message (truncated to 60 chars)
  - Author name
  - Relative time (e.g., "2 hours ago")
- Click commit to open actions modal

**Acceptance Criteria:**
- [x] 50 commits load within 2 seconds
- [x] "Load More" adds 50 more commits
- [x] Commit info accurately displayed
- [x] Click opens modal

#### FR-3.2: Visual Commit Graph

**Priority:** High
**Status:** Not Implemented

**Description:** Display commit history as a visual graph showing branch topology and merge history.

**Requirements:**

**Graph Library:** GitGraph.js (https://gitgraphjs.com/)
- Lightweight (< 50KB)
- Canvas-based rendering
- Supports branching and merging visualization
- Customizable colors

**Visual Design:**
```
Graph (left)              Commit Details (right)
┌──────────────┬────────────────────────────────────┐
│              │                                    │
│   ●──●──●    │ abc1234 - Fix login bug           │
│   │     │    │ John Doe • 2 hours ago            │
│   │     ●    │                                    │
│   │    / \   │ Fixed authentication issue that   │
│   │   ●   ●  │ prevented users from logging in   │
│   │   │   │  │                                    │
│   ●───●───●  │ [Checkout] [Reset] [Details]      │
│              │                                    │
└──────────────┴────────────────────────────────────┘

Legend:
● Blue   - Pushed commits
● Purple - Unpushed local commits
● Green  - Current HEAD
```

**Color Scheme:**
- **Blue (#4A90E2):** Commits pushed to remote
- **Purple (#9B59B6):** Local commits not yet pushed
- **Green (#27AE60):** Current HEAD position
- **Gray (#95A5A6):** Branch lines

**Performance Requirements:**
- Render 100 commits in < 500ms
- Smooth scrolling at 60fps
- Lazy load commits beyond viewport

**Interaction:**
- Click commit node → Open actions modal
- Hover commit → Show tooltip with full message
- Scroll graph → Load more commits (infinite scroll)
- Zoom controls → +/- buttons (future enhancement)

**Backend API Enhancement:**

Update `/rosepetal-git/log` to include parent commit hashes:

**Response:**
```json
{
  "success": true,
  "operation": "log",
  "total": 150,
  "commits": [
    {
      "hash": "abc123...",
      "parents": ["def456..."], // NEW: parent commit hashes
      "date": "2025-01-14T10:30:00Z",
      "message": "Fix login bug",
      "author": "John Doe",
      "email": "john@example.com",
      "pushed": true, // NEW: whether commit is on remote
      "branches": ["main", "feature/login"], // NEW: branches at this commit
      "isHead": true // NEW: whether this is current HEAD
    }
  ]
}
```

**Implementation Steps:**
1. Add GitGraph.js library to git-control-plugin.html
2. Update backend `/rosepetal-git/log` to include parent info
3. Replace commits list section with graph canvas
4. Implement commit rendering with proper colors
5. Add click handlers for commit nodes
6. Implement lazy loading for performance

**Acceptance Criteria:**
- [ ] Graph renders within 500ms for 100 commits
- [ ] Branch topology accurately shown
- [ ] Colors distinguish pushed/unpushed commits
- [ ] Click opens commit actions modal
- [ ] Smooth scrolling performance
- [ ] Works on repositories with complex merge history

---

### FR-4: Commit Operations

**Priority:** High
**Status:** Implemented

#### FR-4.1: Checkout Commit

**Description:** Navigate repository to a specific commit (detached HEAD state).

**UI:** Click commit → Modal → "Checkout to this commit" button

**Warning Required:**
```
⚠️ Warning: Detached HEAD State

Checking out this commit will put you in 'detached HEAD' state.
You can look around, make changes, and commit them, but any
commits you make will be orphaned when you switch branches.

Recommendations:
• To keep your work, create a new branch: [Create Branch]
• To discard changes, just checkout a branch later

[Cancel] [Checkout Anyway]
```

**Acceptance Criteria:**
- [x] Checkout executes successfully
- [x] Warning shown for detached HEAD
- [ ] Option to create branch instead
- [x] Flows reload after checkout

#### FR-4.2: Reset to Commit

**Description:** Move current branch pointer to a specific commit.

**Reset Modes:**
- **Soft:** Keep changes staged
- **Mixed:** Keep changes unstaged
- **Hard:** Discard all changes (⚠️ destructive)

**UI:** Click commit → Modal → "Reset (Hard)" button

**Confirmation Required (Hard Reset Only):**
```
⚠️ WARNING: Destructive Operation

Hard reset will permanently discard ALL uncommitted changes.
This action CANNOT be undone.

You are about to reset to: abc123... "Fix login bug"

Current changes that will be LOST:
• 3 modified files
• 2 new files

Are you absolutely sure?

[Cancel] [Yes, Reset and Lose Changes]
```

**Safe Mode:** Hard reset blocked by default (user must disable in settings)

**Acceptance Criteria:**
- [x] Reset executes successfully
- [x] Hard reset requires confirmation
- [x] Safe mode blocks hard reset by default
- [x] Flows reload after reset

#### FR-4.3: View Commit Details

**Description:** Display full commit information and diff.

**UI:** Click commit → Modal → "View full details" button → Opens details panel

**Details Panel Content:**
- Full commit hash
- Author name and email
- Commit date (full timestamp)
- Full commit message (multi-line)
- Changed files list with +/- indicators
- Diff preview (future enhancement)

**Acceptance Criteria:**
- [x] Details panel opens on click
- [x] All commit metadata shown
- [x] Panel closes cleanly

---

### FR-5: Commit Creation

**Priority:** High
**Status:** Implemented

**Description:** Create new commits with all changed files.

**UI Location:** Commit panel (always visible in sidebar)

**Workflow:**
1. User makes changes to flows
2. Changes appear in "Changes" section automatically
3. User enters commit message in textarea
4. User clicks "Stage All & Commit" button
5. All files staged automatically
6. Commit created with message
7. Commit appears in history
8. Success notification shown

**Commit Message Requirements:**
- Minimum 1 character (non-empty)
- Max 500 characters recommended
- Multi-line supported
- Trimmed of leading/trailing whitespace

**Validation:**
- Empty message → Warning: "Commit message is required"
- No changes to commit → Warning: "No changes to commit"

**Acceptance Criteria:**
- [x] Commit created successfully
- [x] Empty message validation
- [x] All files staged automatically
- [x] Commit appears in history immediately
- [x] Success notification shown

---

### FR-6: Remote Operations

**Priority:** High
**Status:** Implemented

#### FR-6.1: Fetch from Remote

**Description:** Download commits/branches from remote without merging.

**UI:** Toolbar "Fetch" button (download icon)

**Behavior:**
- Updates remote-tracking branches
- Does not modify working directory
- Updates sync indicators (ahead/behind counts)
- Shows success notification

**Acceptance Criteria:**
- [x] Fetch executes successfully
- [x] Sync indicators update
- [x] No working directory changes
- [x] Success notification shown

#### FR-6.2: Pull from Remote

**Description:** Fetch and merge changes from remote.

**UI:** Toolbar "Pull" button (down arrow icon) with behind count badge

**Behavior:**
- Fetches latest commits
- Merges into current branch
- Reloads flows.json from disk
- Refreshes editor page
- Handles merge conflicts gracefully

**Merge Conflict Handling:**
```
Error: Merge conflict detected during pull

Your local changes conflict with changes from the remote. You need to:
1. Pull the changes
2. Resolve conflicts manually
3. Commit the resolved changes

[View Conflicts in Terminal]
```

**Acceptance Criteria:**
- [x] Pull executes successfully
- [x] Flows reload after pull
- [x] Merge conflicts shown clearly
- [x] Success notification on clean merge

#### FR-6.3: Push to Remote

**Description:** Upload local commits to remote repository.

**UI:** Toolbar "Push" button (up arrow icon) with ahead count badge

**Behavior:**
- Pushes current branch to remote
- Uses Node-RED SSH keys for authentication
- Handles rejection errors gracefully
- Updates sync indicators

**Rejection Handling:**
```
Push rejected: Remote has newer commits

Pull the remote changes first, then push:
1. Click the Pull button
2. Resolve any merge conflicts
3. Click Push again

[Pull Now]
```

**Acceptance Criteria:**
- [x] Push executes successfully
- [x] SSH authentication works
- [x] Rejection errors handled gracefully
- [x] Sync indicators update

---

### FR-7: File Change Management

**Priority:** Medium
**Status:** Partial (view implemented, per-file staging pending)

#### FR-7.1: View Changed Files

**Description:** Display all modified, added, and deleted files.

**UI Location:** "Changes" section in sidebar

**File Status Indicators:**
- **M** (Modified) - Orange badge
- **A** (Added) - Green badge
- **D** (Deleted) - Red badge
- **U** (Untracked) - Gray badge

**Display Format:**
```
Changes (4)                              [🗑️]
├─ M  flows.json
├─ A  package.json
├─ M  README.md
└─ U  temp.js
```

**Acceptance Criteria:**
- [x] All changed files shown
- [x] Status badges display correctly
- [x] Updates automatically every 5s
- [x] File count badge accurate

#### FR-7.2: Stage Individual Files (Future)

**Priority:** Medium
**Status:** Not Implemented

**Description:** Allow staging specific files instead of all-or-nothing.

**UI Enhancement:** Add checkbox next to each file

**Display Format:**
```
Changes (4)                    [Stage All] [🗑️]
├─ ☑ M  flows.json
├─ ☐ A  package.json           [Stage]
├─ ☑ M  README.md
└─ ☐ U  temp.js                [Stage]
```

**Behavior:**
- Check file → Stage that file
- Uncheck file → Unstage that file
- "Stage All" → Check all boxes and stage
- Commit button → Commits only checked files

**Acceptance Criteria:**
- [ ] Individual file checkboxes work
- [ ] "Stage All" button stages everything
- [ ] Commit only commits staged files
- [ ] Visual indication of staged vs unstaged

#### FR-7.3: Discard All Changes

**Description:** Reset all uncommitted changes (hard reset to HEAD).

**UI:** Trash button in Changes section header (appears when changes exist)

**Confirmation Dialog:**
```
⚠️ WARNING: Permanent Data Loss

This will permanently discard ALL uncommitted changes.
This action CANNOT be undone.

Files that will be lost:
• flows.json (modified)
• package.json (new file)
• README.md (modified)

Are you absolutely sure?

[Cancel] [Yes, Discard All Changes]
```

**Acceptance Criteria:**
- [x] Button only appears when changes exist
- [x] Confirmation required
- [x] All changes discarded successfully
- [x] Flows reload after discard

---

### FR-8: Safety Features

**Priority:** Critical
**Status:** Implemented

#### FR-8.1: Safe Mode

**Description:** Prevent destructive operations by default.

**Protected Operations:**
- Hard reset
- Force push (future)
- Force delete branch (future)

**Behavior:**
- Enabled by default
- Hard reset blocked with error message
- User must disable safe mode to proceed

**Error Message:**
```
Hard reset is disabled in safe mode

To enable hard reset:
1. Understand that hard reset permanently discards changes
2. Disable safe mode (at your own risk)
3. Try the operation again

Safer alternatives:
• Use soft reset to keep your changes
• Commit your work first, then reset
```

**Future Enhancement:** Safe mode toggle in settings panel

**Acceptance Criteria:**
- [x] Safe mode enabled by default
- [x] Hard reset blocked when enabled
- [x] Clear error message shown
- [ ] Settings toggle (future)

#### FR-8.2: Flow Synchronization

**Description:** Reload flows after Git operations that modify files.

**Trigger Operations:**
- Checkout commit/branch
- Reset to commit
- Pull from remote
- Discard all changes

**Workflow:**
1. Execute Git operation
2. Read flows.json from disk via backend
3. POST flows to Node-RED runtime
4. Show "Flows reloaded" notification
5. Reload browser page after 1 second delay

**Failure Handling:**
```
Failed to reload flows

Git operation succeeded, but flows couldn't be reloaded.
You may need to manually reload the page.

[Reload Page Now]
```

**Acceptance Criteria:**
- [x] Flows reload after all trigger operations
- [x] No data loss on reload
- [x] Success notification shown
- [x] Failure handled gracefully

---

## API Specifications

### Authentication

All endpoints require Node-RED authentication via `RED.auth.needsPermission()`.

**Permissions:**
- `git-control.read` - Read operations (log, status, branches, show, project-info)
- `git-control.write` - Write operations (checkout, reset, commit, add, fetch, pull, push, create-branch, delete-branch)

### Request/Response Format

**Content-Type:** `application/json`

**Success Response Format:**
```json
{
  "success": true,
  "operation": "operation-name",
  ...additional data...
}
```

**Error Response Format:**
```json
{
  "success": false,
  "error": "User-friendly error message",
  "details": "Technical error details for debugging",
  "suggestion": "Actionable suggestions for resolution"
}
```

### Endpoint Catalog

#### Project Information

**GET /rosepetal-git/project-info**

Get active Node-RED project Git information.

**Request:** None (GET)

**Response:**
```json
{
  "success": true,
  "projectName": "my-node-red-project",
  "projectPath": "/path/to/project",
  "currentBranch": "main",
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
  "behind": 0
}
```

#### Repository Operations

**POST /rosepetal-git/log**

Get commit history with optional pagination.

**Request:**
```json
{
  "repoPath": "/optional/path", // optional, uses active project if omitted
  "maxCount": 50, // optional, default 20
  "from": "commit-hash", // optional
  "to": "commit-hash" // optional
}
```

**Response:**
```json
{
  "success": true,
  "operation": "log",
  "total": 150,
  "commits": [
    {
      "hash": "abc123def456...",
      "date": "2025-01-14T10:30:00Z",
      "message": "Fix login bug",
      "author": "John Doe",
      "email": "john@example.com"
    }
  ]
}
```

---

**POST /rosepetal-git/status**

Get repository status and changed files.

**Request:**
```json
{
  "repoPath": "/optional/path" // optional
}
```

**Response:**
```json
{
  "success": true,
  "operation": "status",
  "status": {
    "current": "main",
    "tracking": "origin/main",
    "ahead": 2,
    "behind": 0,
    "modified": ["flows.json", "README.md"],
    "not_added": ["temp.js"],
    "created": ["package.json"],
    "deleted": []
  }
}
```

---

**POST /rosepetal-git/branches**

List all local branches.

**Request:**
```json
{
  "repoPath": "/optional/path" // optional
}
```

**Response:**
```json
{
  "success": true,
  "operation": "branches",
  "current": "main",
  "all": ["dev", "feature/login", "main"],
  "branches": {
    "main": {
      "current": true,
      "commit": "abc123...",
      "label": "main"
    }
  }
}
```

---

**POST /rosepetal-git/show**

Show detailed commit information.

**Request:**
```json
{
  "repoPath": "/optional/path", // optional
  "commitRef": "abc123..." // required
}
```

**Response:**
```json
{
  "success": true,
  "operation": "show",
  "commit": "abc123...",
  "details": "commit abc123...\nAuthor: John Doe\nDate: ...\n\nFix login bug\n\ndiff --git ..."
}
```

#### Branch Operations

**POST /rosepetal-git/checkout**

Checkout a commit or branch.

**Request:**
```json
{
  "repoPath": "/optional/path", // optional
  "commitRef": "main" // required: branch name or commit hash
}
```

**Response:**
```json
{
  "success": true,
  "operation": "checkout",
  "ref": "main",
  "result": "..."
}
```

---

**POST /rosepetal-git/create-branch** (Future)

Create a new branch.

**Request:**
```json
{
  "repoPath": "/optional/path", // optional
  "branchName": "feature/new-feature", // required
  "fromCommit": "abc123...", // optional, defaults to HEAD
  "checkout": true // optional, default false
}
```

**Response:**
```json
{
  "success": true,
  "operation": "create-branch",
  "branchName": "feature/new-feature",
  "commit": "abc123...",
  "checkedOut": true
}
```

---

**POST /rosepetal-git/delete-branch** (Future)

Delete a branch.

**Request:**
```json
{
  "repoPath": "/optional/path", // optional
  "branchName": "feature/old-feature", // required
  "force": false // required for unmerged branches
}
```

**Response:**
```json
{
  "success": true,
  "operation": "delete-branch",
  "branchName": "feature/old-feature",
  "wasUnmerged": false
}
```

#### Commit Operations

**POST /rosepetal-git/add**

Stage files for commit.

**Request:**
```json
{
  "repoPath": "/optional/path", // optional
  "files": ["flows.json", "README.md"], // required if stageAll is false
  "stageAll": true // required if files is omitted
}
```

**Response:**
```json
{
  "success": true,
  "operation": "add",
  "result": "..."
}
```

---

**POST /rosepetal-git/commit**

Create a new commit.

**Request:**
```json
{
  "repoPath": "/optional/path", // optional
  "message": "Fix login bug" // required, non-empty
}
```

**Response:**
```json
{
  "success": true,
  "operation": "commit",
  "commit": "abc123...",
  "summary": {
    "changes": 3,
    "insertions": 25,
    "deletions": 10
  },
  "branch": "main"
}
```

---

**POST /rosepetal-git/reset**

Reset to a specific commit.

**Request:**
```json
{
  "repoPath": "/optional/path", // optional
  "commitRef": "HEAD~1", // required
  "resetMode": "soft", // required: "soft", "mixed", or "hard"
  "safeMode": true // optional, default true
}
```

**Response:**
```json
{
  "success": true,
  "operation": "reset",
  "mode": "soft",
  "commit": "HEAD~1",
  "result": "..."
}
```

#### Remote Operations

**POST /rosepetal-git/fetch**

Fetch from remote repository.

**Request:**
```json
{
  "repoPath": "/optional/path" // optional
}
```

**Response:**
```json
{
  "success": true,
  "operation": "fetch",
  "result": "..."
}
```

---

**POST /rosepetal-git/pull**

Pull changes from remote.

**Request:**
```json
{
  "repoPath": "/optional/path" // optional
}
```

**Response:**
```json
{
  "success": true,
  "operation": "pull",
  "result": {
    "files": ["flows.json"],
    "insertions": 10,
    "deletions": 5
  }
}
```

---

**POST /rosepetal-git/push**

Push commits to remote.

**Request:**
```json
{
  "repoPath": "/optional/path" // optional
}
```

**Response:**
```json
{
  "success": true,
  "operation": "push",
  "result": "..."
}
```

#### Flow Synchronization

**POST /rosepetal-git/read-flows**

Read flows.json from disk (for flow reload).

**Request:**
```json
{}
```

**Response:**
```json
{
  "success": true,
  "flows": [ /* Node-RED flow JSON array */ ]
}
```

---

## Non-Functional Requirements

### Performance

**NFR-1: Response Time**
- All Git operations complete within 5 seconds
- UI updates appear within 500ms of operation completion
- Auto-refresh cycle completes in < 1 second
- Graph rendering completes in < 500ms for 100 commits

**NFR-2: Resource Usage**
- Plugin memory footprint < 50MB
- No memory leaks during long sessions
- CPU usage < 10% during idle
- Network bandwidth < 1MB for typical operations

### Security

**NFR-3: Authentication**
- All API endpoints require Node-RED authentication
- SSH keys stored securely in Node-RED user directory
- No credentials logged or exposed in errors
- CSRF protection enabled

**NFR-4: Authorization**
- Read/write permissions enforced
- Destructive operations require explicit user action
- Safe mode enabled by default
- No unauthorized file system access

### Reliability

**NFR-5: Error Handling**
- All errors caught and handled gracefully
- User-friendly error messages with actionable suggestions
- No silent failures
- Technical details logged to console

**NFR-6: Data Integrity**
- Flow synchronization prevents data loss
- Atomic Git operations (rollback on failure)
- No corrupted repositories
- Backup/recovery strategy documented

### Compatibility

**NFR-7: Node-RED Version Support**
- Node-RED >= 2.0.0 (tested up to 3.x)
- Node.js >= 14.0.0 (tested up to 20.x)
- Git >= 2.0 (any recent version)

**NFR-8: Browser Support**
- Chrome/Edge >= 90
- Firefox >= 88
- Safari >= 14
- No Internet Explorer support

### Maintainability

**NFR-9: Code Quality**
- Clear, self-documenting code
- Consistent naming conventions
- Modular architecture
- Comprehensive error handling

**NFR-10: Documentation**
- README with installation and usage
- API documentation (this file)
- Inline code comments for complex logic
- CLAUDE.md for AI assistance

---

## UI/UX Guidelines

### Design System

**Colors:**
- Primary: Node-RED red (#8f0000)
- Success: Green (#27AE60)
- Warning: Orange (#E67E22)
- Error: Red (#E74C3C)
- Info: Blue (#3498DB)

**Typography:**
- Font: System font stack (same as Node-RED)
- Monospace: For commit hashes and code

**Spacing:**
- Base unit: 8px
- Small: 8px
- Medium: 16px
- Large: 24px

### Interaction Patterns

**Modals:**
- Center on screen
- Overlay dims background
- Click outside or X to close
- ESC key closes modal

**Confirmations:**
- Required for destructive operations
- Clear warning messages
- "Cancel" as default focus
- Destructive button styled in red

**Loading States:**
- Spinner icon on buttons during operation
- "Loading..." text in empty states
- Disable buttons during operations
- Show progress where applicable

**Notifications:**
- Top-right corner
- Auto-dismiss after 5 seconds
- Click to dismiss immediately
- Color-coded by type (success/error/warning/info)

### Accessibility

**WCAG 2.1 AA Compliance:**
- Keyboard navigation for all actions
- Screen reader support
- Sufficient color contrast (4.5:1 minimum)
- Focus indicators visible
- Alt text for icons

**Keyboard Shortcuts (Future):**
- Ctrl/Cmd + G: Open Git Control sidebar
- Ctrl/Cmd + Enter: Commit (when message focused)
- ESC: Close modals

---

## Future Enhancements

### Phase 2 (Priority: High)

**2.1 Visual Commit Graph**
- GitGraph.js integration
- Branch topology visualization
- Color-coded commit status
- Interactive commit nodes

**2.2 Branch Management**
- Create new branches with modal
- Delete branches with confirmation
- Rename branches (if possible)
- Merge branches (future consideration)

**2.3 Enhanced Error Messages**
- Context-specific suggestions
- Recovery action buttons
- Link to relevant documentation

### Phase 3 (Priority: Medium)

**3.1 File-Level Operations**
- Stage individual files
- Unstage files
- Discard individual file changes
- View file diffs

**3.2 Commit Message Enhancements**
- Message templates
- Commit message validation
- Multi-line message editor
- Recent messages dropdown

**3.3 Advanced Git Operations**
- Cherry-pick commits
- Rebase interactive
- Stash operations
- Tag management

### Phase 4 (Priority: Low)

**4.1 Collaboration Features**
- Blame view
- Contributor statistics
- Pull request integration (GitHub/GitLab)
- Code review comments

**4.2 Performance Optimizations**
- Virtual scrolling for large commit lists
- Diff caching
- Background fetch
- WebSocket for real-time updates

**4.3 Customization**
- Theme support
- Configurable auto-refresh interval
- Keyboard shortcuts customization
- Default branch preference

---

## Revision History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 1.0 | 2025-01-14 | Initial requirements document | Claude |
| 2.0 | 2025-01-14 | Comprehensive update with detailed specs | Claude |

---

## Approval

**Product Owner:** _Pending_
**Technical Lead:** _Pending_
**Date:** _Pending_

---

**End of Requirements Document**
