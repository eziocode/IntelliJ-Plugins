# Git Assume Unchanged Plugin

<p align="center">
  <img src="plugin-logo.png" alt="Git Assume Plugin Logo" width="200"/>
</p>

<p align="center">
  <a href="https://github.com"><img src="https://img.shields.io/badge/version-2.1.1-blue.svg" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License"></a>
</p>

Easily manage Git's assume-unchanged flag directly from IntelliJ IDEA and other JetBrains IDEs.

## Features

- 🆕 **Assumed Files Tool Window** - Dedicated panel to view and manage all assumed unchanged files
- 🖱️ **Double-Click to Open** - Double-click files in tool window to open in editor
- 📋 **Context Menu** - Right-click for "Open File" and "Show Diff" options
- ✅ **Assume Unchanged** - Tell Git to ignore changes to tracked files
- ✅ **No Assume Unchanged** - Resume tracking changes to files
- ✅ **Multi-file Support** - Process single or multiple files at once
- ✅ **Bulk Unassume** - Unassume multiple files at once from the tool window
- ✅ **Multi-Repository Support** - Works seamlessly across multiple Git repositories
- ✅ **Auto Validation** - Only shows for files in Git repositories
- ✅ **Smart Notifications** - Success/error messages with details
- ✅ **All JetBrains IDEs** - Works with IntelliJ IDEA, PyCharm, WebStorm, and more

## Installation

### From JetBrains Marketplace (Recommended)

1. Open your JetBrains IDE
2. Go to **Settings/Preferences** → **Plugins**
3. Click **Marketplace** tab
4. Search for **"Git Assume Unchanged"**
5. Click **Install** and restart the IDE

### From Disk

1. Download the latest `gitAssume-2.1.1.zip` from [Releases](https://plugins.jetbrains.com/plugin/29274-git-assume-unchanged/edit/versions)
2. Open your IDE → **Settings/Preferences** → **Plugins**
3. Click **⚙️** → **Install Plugin from Disk...**
4. Select the downloaded ZIP file
5. Restart the IDE

## Usage

### Method 1: Context Menu (Quick Actions)

1. Right-click on any file(s) in the Project view
2. Navigate to **Git** → **Git Assume**
3. Choose an action:
   - **Assume Unchanged** - Git will ignore changes
   - **No Assume Unchanged** - Git will track changes again

**Multi-file Selection**: Select multiple files using `Cmd+Click` (macOS) or `Ctrl+Click` (Windows/Linux), then apply the action to all selected files at once.

### Method 2: Assumed Files Tool Window (Recommended)

1. Open the **Assumed Files** tool window from the left sidebar
2. View all files currently marked as assume-unchanged
3. Select one or more files in the table
4. Click **"Unassume Selected"** to remove the flag from selected files
5. Click **"Refresh"** to update the list if needed

The tool window shows files from all Git repositories in your project with columns for file name, path, and repository.

## What is "Assume Unchanged"?

Git's `assume-unchanged` flag tells Git to temporarily ignore changes to a tracked file. This is useful when:

- You need to modify a config file locally but don't want to commit changes
- You're testing changes that shouldn't be committed
- You want to keep local modifications without them showing in `git status`

**Important:** This is a local flag only. It doesn't affect other developers or the repository.

## Known Limitations

### IntelliJ Commit Window

**The assume-unchanged flag works at the Git command-line level but may still show files in IntelliJ's commit window.** This is expected behavior because:

- IntelliJ's VCS integration uses its own file system watchers for change detection
- The IDE's commit window doesn't respect Git's `assume-unchanged` flag
- However, `git status` and `git commit` commands will correctly ignore the files

**Workaround:** If you need to prevent files from appearing in the commit window, use `.gitignore` instead. Use `assume-unchanged` when you want to:
- Keep files tracked in Git
- Ignore local changes temporarily
- Work with command-line Git operations

This is a known limitation of all `assume-unchanged` implementations in JetBrains IDEs.

## Requirements

- **JetBrains IDE**: IntelliJ IDEA 2023.2+ or any other JetBrains IDE (PyCharm, WebStorm, etc.)
- **Git**: Must be installed and configured
- **Java**: 17 or later

## Compatibility

| IDE Version | Build Range | Status |
|-------------|-------------|--------|
| 2023.2+     | 232-252.*   | ✅ Supported |
| 2025.2+     | 252+        | ✅ Supported |

## Building from Source

```bash
git clone <repository-url>
cd gitAssume
./gradlew clean build
```

The plugin will be in `build/distributions/gitAssume-2.1.1.zip`

**Note:** Always use `./gradlew` (not `gradle`) to ensure correct Gradle version.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For issues or questions:
- Open an issue on GitHub
- Refer to [Git update-index documentation](https://git-scm.com/docs/git-update-index)

## Changelog

### Version 2.1.1 (Current)
- 🚀 **New Feature**: Unassume files directly from right-click context menu in Assumed Files tool window
- Enhanced context menu with "Unassume File" option for quick access
- Improved workflow efficiency for managing assumed files
- Verified compatibility with latest IntelliJ Platform versions
- Minor performance improvements

### Version 2.1.0
- 🎯 **New Feature**: Double-click to open files from tool window
- Right-click context menu with "Open File" and "Show Diff" options
- Quick file access improves workflow efficiency
- Diff viewer to compare file states
- Bug fix: Fixed NullPointerException in context menu
- No deprecated API usage

### Version 2.0.0
- 🎉 **New Feature**: Assumed Files tool window in left sidebar
- View all assume-unchanged files at a glance
- Unassume multiple files directly from the tool window
- Multi-repository support
- Auto-refresh on window open
- Dedicated icon and default visibility

### Version 1.3.0
- Added error reporter - Report plugin errors directly to GitHub from IDE
- Enabled "Report and Clear All" button in error dialog
- Automatic error report generation with stack traces
- Fixed error reporter URL length issues

### Version 1.2.1
- Fixed EDT threading error that occurred on every action
- Moved Git repository operations to background thread
- Improved performance and responsiveness

### Version 1.2.0
- Fixed compatibility issue with IntelliJ IDEA 2025.3+
- Plugin now supports all future IntelliJ IDEA versions without updates
- Removed upper version limit for true future-proof compatibility

### Version 1.1.1
- Added professional plugin icon/logo
- Icon displays in plugin manager and marketplace
- Extended compatibility to support all future IntelliJ IDEA versions
- Changed vendor name to Aswin

### Version 1.1.0
- Initial marketplace release
- Fixed EDT threading error ("Do not call synchronous repository update in EDT")
- Works in all Git-related contexts (Project View, Version Control, Changes view)
- Compatible with IntelliJ IDEA 2023.2+ and all JetBrains IDEs

### Version 1.0.0 (Initial Development)
- Support for assume-unchanged and no-assume-unchanged operations
- Multi-file selection support
- Automatic Git repository validation
- Success and error notifications
- Compatible with all JetBrains IDEs
