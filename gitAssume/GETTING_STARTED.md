# Getting Started with Git Assume Unchanged

Welcome! This guide will help you get started with the Git Assume Unchanged plugin.

## What Does This Plugin Do?

The Git Assume Unchanged plugin allows you to easily manage Git's `assume-unchanged` flag directly from your IDE. This flag tells Git to temporarily ignore changes to tracked files without modifying `.gitignore`.

## When Should I Use This?

Use this plugin when you need to:

- **Modify config files locally** without committing changes (e.g., database credentials, API endpoints)
- **Test changes** that shouldn't be committed to the repository
- **Keep local customizations** without them appearing in `git status`
- **Prevent accidental commits** of temporary modifications

## Quick Start

### 1. Install the Plugin

The plugin is already installed if you're reading this! If not:
- Go to **Settings/Preferences** → **Plugins**
- Search for "Git Assume Unchanged"
- Click **Install** and restart your IDE

### 2. Using the Plugin

There are two ways to use this plugin:

#### A. Assumed Files Tool Window (Recommended) 🆕

1. Open the **Assumed Files** tool window from the **left sidebar**
2. View all files currently marked as assume-unchanged
3. **NEW in v2.1:** **Double-click** any file to open it in the editor
4. **NEW in v2.1:** **Right-click** for context menu with:
   - **Open File** - Opens the file in editor
   - **Show Diff** - Shows current file state in diff viewer
5. Select files and click **"Unassume Selected"** to remove the flag
6. Use **"Refresh"** button to update the list

This is the easiest way to manage all your assumed files in one place!

#### B. Context Menu (Quick Actions)

**To ignore changes to a file:**

1. Right-click on any file in the Project view
2. Navigate to **Git** → **Git Assume**
3. Click **Assume Unchanged**
4. ✅ Git will now ignore changes to this file

**To resume tracking changes:**

1. Right-click on the file
2. Navigate to **Git** → **Git Assume**
3. Click **No Assume Unchanged**
4. ✅ Git will resume tracking changes

### 3. Multi-File Selection

You can process multiple files at once:

1. Select multiple files using:
   - **macOS**: `Cmd + Click`
   - **Windows/Linux**: `Ctrl + Click`
2. Right-click → **Git** → **Git Assume**
3. Choose your action
4. ✅ All selected files will be processed

### 4. Quick File Access (v2.1.0) 🎯

The Assumed Files tool window now supports quick file access:

**Double-Click to Open:**
- Simply double-click any file in the list to open it in the editor
- Perfect for quickly reviewing and editing assumed files

**Right-Click Context Menu:**
- Right-click any file to see options:
  - **Open File**: Opens the file in the editor
  - **Show Diff**: Opens diff viewer to see file changes
- The diff viewer helps you review what changes you've made to assumed files

## Important Notes

### ⚠️ This is a Local Flag Only

The `assume-unchanged` flag is **local to your machine**. It does NOT:
- Affect other developers
- Get committed to the repository
- Sync across machines

### ⚠️ Git May Override This Flag

Git may automatically remove the `assume-unchanged` flag when:
- Pulling changes that modify the file
- Switching branches
- Performing certain Git operations

If this happens, simply reapply the flag using the plugin.

### ⚠️ Not a Replacement for .gitignore

Use `.gitignore` for files that should **never** be tracked. Use `assume-unchanged` for files that are tracked but you want to temporarily ignore changes.

### ⚠️ IntelliJ Commit Window Limitation

**Files may still appear in IntelliJ's commit window even with assume-unchanged flag set.** This is expected because:
- IntelliJ uses its own change detection system
- The IDE doesn't respect Git's `assume-unchanged` flag in the UI
- However, `git status` and command-line Git will correctly ignore these files

**If you need files to not appear in the commit window at all, use `.gitignore` instead.**

## Common Use Cases

### 1. Local Configuration Files

```
# Example: config.properties
database.url=localhost:5432  # Your local database
api.key=dev-key-123          # Your dev API key
```

Mark as assume-unchanged to prevent committing your local settings.

### 2. IDE-Specific Settings

```
# Example: .idea/workspace.xml
# Your personal IDE settings
```

Keep your IDE customizations without affecting the team.

### 3. Testing Changes

```
# Example: feature-flag.json
{
  "newFeature": true  # Testing locally
}
```

Test with the flag enabled locally without committing.

## Checking Assume-Unchanged Files

### Using the Tool Window (Easiest)

Simply open the **Assumed Files** tool window from the right sidebar to see all files!

### Using Command Line

To see which files have the assume-unchanged flag:

```bash
git ls-files -v | grep '^h'
```

Files marked with `h` are assumed unchanged.

## Removing Assume-Unchanged (Command Line)

If you need to remove the flag manually:

```bash
# Single file
git update-index --no-assume-unchanged path/to/file

# All files
git update-index --really-refresh
```

## Troubleshooting

### Plugin Menu Not Showing

- **Check**: Is the file in a Git repository?
- **Solution**: The plugin only works with Git-tracked files

### Changes Still Showing in Git

- **Check**: Did you save the file after marking it?
- **Solution**: The flag applies to the current state; new changes after marking will show

### Flag Disappeared After Pull

- **Cause**: Git automatically removes the flag when the file is updated
- **Solution**: Reapply the flag using the plugin

## Best Practices

1. **Document Your Usage**: Keep a note of which files you've marked
2. **Use Sparingly**: Only for files you actively need to modify
3. **Communicate with Team**: Let others know if they need to do the same
4. **Check Before Committing**: Verify you haven't missed important changes

## Need Help?

- **Plugin Issues**: Report on GitHub
- **Git Questions**: See [Git documentation](https://git-scm.com/docs/git-update-index)
- **Feature Requests**: Open an issue on GitHub

## What's Next?

You're all set! Start using the plugin to manage your local file modifications efficiently.

**Pro Tip**: Create a checklist of files you commonly mark as assume-unchanged for new project setups.

---

**Happy Coding!** 🚀
