# node-red-contrib-rosepetal-git-control

Advanced Git control **sidebar plugin** for Node-RED with support for reset, revert, checkout, history viewing, and many other Git operations - all accessible from a convenient sidebar panel!

## Features

✨ **Sidebar Panel Integration** - Always accessible from Node-RED's right sidebar, no need to create flows!

✨ **11 Git Operations Supported:**
- 📜 **View History (log)** - Browse commit history with filtering
- ↩️ **Reset** - Go back to specific commits (soft/mixed/hard)
- 🔄 **Revert** - Safely undo commits by creating new commits
- 🔀 **Checkout** - Switch to specific commits or branches
- 🔍 **Show** - View detailed commit information
- 📊 **Diff** - Compare commits and changes
- 📋 **Status** - Enhanced repository status
- 📖 **Reflog** - View reference logs (recover lost commits)
- 🏷️ **Tag** - Create, list, and delete tags
- 🌿 **Branches** - List all branches
- 💾 **Stash** - Save, list, apply, and pop stashed changes

🛡️ **Safety Features:**
- Safe mode to prevent destructive operations
- Input validation and error handling
- Detailed error messages
- Repository existence checks

⚙️ **User-Friendly Interface:**
- Form-based UI with dynamic fields
- Quick action buttons
- Real-time results display
- Color-coded status indicators
- Keyboard shortcuts

## Installation

### From npm (when published)

```bash
cd ~/.node-red
npm install node-red-contrib-rosepetal-git-control
```

### Local Installation (for development/testing)

```bash
# Navigate to the plugin directory
cd /home/rosepetal-laptop-nil/Desktop/node-red-contrib-rosepetal-git-control

# Install dependencies
npm install

# Link to Node-RED
cd ~/.node-red
npm install /home/rosepetal-laptop-nil/Desktop/node-red-contrib-rosepetal-git-control

# Restart Node-RED
node-red-restart
# or stop and start manually
```

Then **refresh your browser** (Ctrl+F5 / Cmd+Shift+R) and look for the **"Git Control"** tab in Node-RED's right sidebar!

## Quick Start

1. **Open Node-RED editor** (usually http://localhost:1880)
2. **Look for the "Git Control" tab** in the right sidebar (next to Debug, Config, etc.)
3. **Click the tab** to open the Git Control panel
4. **Set repository path** (or leave empty to use Node-RED's directory)
5. **Choose an operation** from the dropdown
6. **Fill in required fields** (they appear dynamically)
7. **Click "Execute"** button
8. **View results** in the results section below!

## Usage Guide

### Interface Overview

The sidebar panel contains:

1. **Repository Section** - Set the path to your git repository
2. **Quick Actions** - Fast access to common operations (Status, History, Branches, Refresh)
3. **Operation Selector** - Choose from 11 different git operations
4. **Dynamic Options** - Form fields that change based on selected operation
5. **Safe Mode Toggle** - Prevent destructive operations
6. **Execute Button** - Run the selected operation
7. **Results Display** - View operation results with formatted output

### Common Operations

#### View Last 10 Commits
1. Select "View History (log)" from operations
2. Set "Max Commits" to 10
3. Click "Execute"
4. View commits with hash, author, date, and message

#### Check Repository Status
1. Click "Status" quick action button
2. View modified, untracked, and staged files
3. See current branch name

#### Go Back to Previous Commit (Keep Changes)
1. Select "Reset to Commit"
2. Enter commit reference: `HEAD~1` (one commit back)
3. Choose "Soft" reset mode (keeps changes staged)
4. Click "Execute"

⚠️ **Warning:** Hard reset permanently discards changes!

#### Safely Undo Last Commit
1. Select "Revert Commit"
2. Enter commit reference: `HEAD`
3. Click "Execute"
4. A new commit is created that undoes the changes (non-destructive)

#### Switch to Different Branch
1. Select "Checkout Commit/Branch"
2. Enter branch name (e.g., `main`, `develop`)
3. Click "Execute"

#### View All Branches
1. Click "Branches" quick action button
2. See all branches with current branch highlighted

#### Recover Lost Commits
1. Select "Reference Log" from operations
2. Click "Execute"
3. View all HEAD movements with commit hashes
4. Use hash to checkout or reset if needed

### Operations Reference

| Operation | Description | Required Fields | Safe Mode |
|-----------|-------------|-----------------|-----------|
| **log** | View commit history | Max Commits | ✓ |
| **reset** | Reset to commit | Commit Ref, Reset Mode | Blocks hard reset |
| **revert** | Revert commit | Commit Ref | ✓ |
| **checkout** | Checkout commit/branch | Commit/Branch Ref | ✓ |
| **show** | Show commit details | Commit Ref | ✓ |
| **diff** | Show differences | (Optional: Commit Range) | ✓ |
| **status** | Repository status | None | ✓ |
| **reflog** | Reference log | None | ✓ |
| **tags** | Tag operations | Tag Action, (Tag Name) | ✓ |
| **branches** | List branches | None | ✓ |
| **stash** | Stash operations | Stash Action, (Stash Ref) | ✓ |

### Commit References

You can use these reference formats:
- `HEAD` - Current commit
- `HEAD~1` - One commit before HEAD
- `HEAD~5` - Five commits before HEAD
- `abc123...` - Commit hash (full or short)
- `main` - Branch name
- `v1.0.0` - Tag name
- `HEAD~1..HEAD` - Commit range (for diff)

## Safety and Best Practices

### Safe Mode

**Enabled by default** - Prevents:
- Hard resets that permanently discard changes
- Other potentially destructive operations

Disable only when you understand the consequences!

### Destructive Operations

**⚠️ These operations can cause data loss:**
- `reset --hard`: Permanently discards uncommitted changes
- `checkout` (to commit): Can lose uncommitted changes if not stashed

**Best Practices:**
1. ✅ Always check status before destructive operations
2. ✅ Use stash to save work-in-progress
3. ✅ Prefer revert over reset when possible
4. ✅ Keep Safe Mode enabled during development
5. ✅ Test operations in a non-production repository first
6. ✅ Use reflog to recover from mistakes

### Recovery

If you make a mistake:
1. Open "Reference Log" operation
2. Find the commit hash before your mistake
3. Use "Reset to Commit" (soft mode) to go back
4. Your changes will be preserved!

## Troubleshooting

### "Path is not a git repository"
- Verify the repository path is correct
- Ensure the directory contains a `.git` folder
- Check file system permissions

### "Commit reference is required"
- Some operations need a commit reference
- Provide the reference in the appropriate field
- Use `HEAD` for current commit

### "Hard reset is disabled in safe mode"
- Disable safe mode checkbox to perform hard resets
- Understand that hard reset **permanently discards changes**

### Plugin Not Appearing in Sidebar
1. Verify installation: `cd ~/.node-red && npm list | grep rosepetal`
2. Check Node-RED logs for errors: `node-red-log`
3. Restart Node-RED completely
4. **Hard refresh browser** (Ctrl+F5 / Cmd+Shift+R)
5. Check browser console for JavaScript errors (F12)

### Operations Not Working
1. Check Node-RED logs for detailed error messages
2. Verify Git is installed: `git --version`
3. Test Git commands manually in terminal
4. Ensure repository is not in conflicted state
5. Check simple-git dependency is installed

### Permission Errors
- Plugin requires Node-RED authentication if enabled
- Check user has read/write permissions for repository
- Verify Git is configured with user name and email

## Development

### Project Structure
```
node-red-contrib-rosepetal-git-control/
├── package.json                    # NPM package configuration
├── LICENSE                         # MIT License
├── README.md                       # This file
├── git-control-api.js              # Backend API endpoints
├── git-control-plugin.html         # Frontend sidebar UI
└── resources/
    └── git-control.css            # Styling
```

### Local Development
```bash
# Clone or navigate to repository
cd /home/rosepetal-laptop-nil/Desktop/node-red-contrib-rosepetal-git-control

# Install dependencies
npm install

# Link for local development
cd ~/.node-red
npm install /home/rosepetal-laptop-nil/Desktop/node-red-contrib-rosepetal-git-control

# Make changes to code
# Restart Node-RED to see changes
node-red-restart

# Refresh browser to reload plugin UI
```

### Making Changes
- **Backend (git-control-api.js)**: Restart Node-RED after changes
- **Frontend (git-control-plugin.html)**: Just refresh browser
- **Styles (resources/git-control.css)**: Just refresh browser

## API Endpoints

The plugin registers these HTTP Admin API endpoints:

- `POST /rosepetal-git/log` - Get commit history
- `POST /rosepetal-git/reset` - Reset to commit
- `POST /rosepetal-git/revert` - Revert commit
- `POST /rosepetal-git/checkout` - Checkout commit/branch
- `POST /rosepetal-git/status` - Get status
- `POST /rosepetal-git/reflog` - Get reflog
- `POST /rosepetal-git/branches` - List branches
- `POST /rosepetal-git/tags` - Tag operations
- `POST /rosepetal-git/stash` - Stash operations
- `POST /rosepetal-git/show` - Show commit
- `POST /rosepetal-git/diff` - Show diff

All endpoints require authentication and return JSON responses.

## Dependencies

- [simple-git](https://github.com/steveukx/git-js) - ^3.25.0
- Node-RED >= 2.0.0
- Node.js >= 14.0.0
- Git (installed on system)

## Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Author

RosePetal

## Support

- **Issues**: [GitHub Issues](https://github.com/rosepetal/node-red-contrib-rosepetal-git-control/issues)
- **Node-RED**: [Node-RED Forum](https://discourse.nodered.org/)
- **Git Documentation**: [git-scm.com](https://git-scm.com/docs)

## Changelog

### Version 1.0.0
- Initial release as sidebar plugin
- 11 Git operations supported
- Safe mode for destructive operations
- Comprehensive error handling
- User-friendly sidebar interface
- Quick action buttons
- Real-time results display

## Keywords

node-red, git, version-control, git-control, sidebar, plugin, reset, revert, checkout, commit, history, reflog, branches, tags, stash

---

**Made with ❤️ for the Node-RED community**
