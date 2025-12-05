# Git Assume Unchanged Plugin

Manage Git's assume-unchanged flag directly from IntelliJ IDEA.

## Features

- ✅ **Assume Unchanged** - Tell Git to ignore changes to tracked files
- ✅ **No Assume Unchanged** - Resume tracking changes to files
- ✅ **Multi-file Support** - Process single or multiple files at once
- ✅ **Auto Validation** - Only shows for files in Git repositories
- ✅ **Smart Notifications** - Success/error messages with details

## Installation

### Option 1: Automatic Installation (Recommended)

**macOS/Linux:**
```bash
./install.sh
```

**Windows (PowerShell):**
```powershell
.\install.ps1
```

Then restart IntelliJ IDEA.

### Option 2: Manual Installation

1. Download `gitAssume-1.0-SNAPSHOT.zip`
2. Open IntelliJ IDEA
3. Go to **Settings/Preferences** → **Plugins**
4. Click the **⚙️ gear icon** → **Install Plugin from Disk...**
5. Select the downloaded ZIP file
6. Click **OK** and restart IntelliJ IDEA

## Usage

1. Right-click on any file(s) in the Project view
2. Navigate to **Git** → **Git Assume**
3. Choose an action:
   - **Assume Unchanged** - Git will ignore changes
   - **No Assume Unchanged** - Git will track changes again

### Multi-file Selection

Select multiple files using:
- **macOS**: `Cmd + Click`
- **Windows/Linux**: `Ctrl + Click`

Then apply the action to all selected files at once.

## What is "Assume Unchanged"?

Git's `assume-unchanged` flag tells Git to temporarily ignore changes to a tracked file. This is useful when:

- You need to modify a config file locally but don't want to commit changes
- You're testing changes that shouldn't be committed
- You want to keep local modifications without them showing in `git status`

**Important:** This is a local flag only. It doesn't affect other developers or the repository.

## Requirements

- **IntelliJ IDEA**: 2023.2 or later (builds 232-252+)
- **Git**: Must be installed and configured
- **Java**: 17 or later

## Compatibility

| IntelliJ Version | Build Range | Status |
|------------------|-------------|--------|
| 2023.2+          | 232-252.*   | ✅ Supported |
| 2025.2+          | 252+        | ✅ Supported |

## Troubleshooting

### Plugin not showing in menu
- Ensure the file is in a Git repository
- Check that Git4Idea plugin is enabled
- Restart IntelliJ IDEA

### "Not compatible" error
- Update to IntelliJ IDEA 2023.2 or later
- Rebuild the plugin with updated version range

### Installation script fails
- Use manual installation method
- Check IntelliJ IDEA is properly installed
- Verify file permissions

## Building from Source

```bash
# Clone or download the source code
cd gitAssume

# Build the plugin
./gradlew clean build

# Plugin will be in: build/distributions/gitAssume-1.0-SNAPSHOT.zip
```

**Note:** Always use `./gradlew` (not `gradle`) to ensure correct Gradle version.

## Distribution

To share this plugin with others:

1. **Share the ZIP file**: `gitAssume-1.0-SNAPSHOT.zip`
2. **Include installation script**: `install.sh` or `install.ps1`
3. **Include this README**: `README.md`

Users can then install using the automatic script or manual method.

## License

This plugin is provided as-is for use in IntelliJ IDEA.

## Support

For issues or questions, refer to the Git documentation:
- [git update-index documentation](https://git-scm.com/docs/git-update-index)
