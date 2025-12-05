# Git Assume Unchanged Plugin

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://github.com)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Easily manage Git's assume-unchanged flag directly from IntelliJ IDEA and other JetBrains IDEs.

## Features

- ✅ **Assume Unchanged** - Tell Git to ignore changes to tracked files
- ✅ **No Assume Unchanged** - Resume tracking changes to files
- ✅ **Multi-file Support** - Process single or multiple files at once
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

1. Download the latest `gitAssume-1.0.0.zip` from [Releases](https://github.com)
2. Open your IDE → **Settings/Preferences** → **Plugins**
3. Click **⚙️** → **Install Plugin from Disk...**
4. Select the downloaded ZIP file
5. Restart the IDE

## Usage

1. Right-click on any file(s) in the Project view
2. Navigate to **Git** → **Git Assume**
3. Choose an action:
   - **Assume Unchanged** - Git will ignore changes
   - **No Assume Unchanged** - Git will track changes again

### Multi-file Selection

Select multiple files using `Cmd+Click` (macOS) or `Ctrl+Click` (Windows/Linux), then apply the action to all selected files at once.

## What is "Assume Unchanged"?

Git's `assume-unchanged` flag tells Git to temporarily ignore changes to a tracked file. This is useful when:

- You need to modify a config file locally but don't want to commit changes
- You're testing changes that shouldn't be committed
- You want to keep local modifications without them showing in `git status`

**Important:** This is a local flag only. It doesn't affect other developers or the repository.

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

The plugin will be in `build/distributions/gitAssume-1.0.0.zip`

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

### Version 1.0.0 (Initial Release)
- Support for assume-unchanged and no-assume-unchanged operations
- Multi-file selection support
- Automatic Git repository validation
- Success and error notifications
- Compatible with all JetBrains IDEs
