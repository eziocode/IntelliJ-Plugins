# Git Assume Unchanged

Easily manage Git's `assume-unchanged` flag directly from IntelliJ IDEA and all JetBrains IDEs.

## What Does It Do?

This plugin provides convenient actions to mark files as "assume-unchanged" or remove that flag, allowing you to tell Git to temporarily ignore changes to tracked files without modifying `.gitignore`.

Perfect for when you need to modify configuration files locally but don't want to commit the changes!

## Features

- ✅ **Assume Unchanged** - Tell Git to ignore changes to tracked files
- ✅ **No Assume Unchanged** - Resume tracking changes to files
- ✅ **Multi-file Support** - Process single or multiple files at once
- ✅ **Auto Validation** - Only shows for files in Git repositories
- ✅ **Smart Notifications** - Success/error messages with details
- ✅ **All JetBrains IDEs** - Works with IntelliJ IDEA, PyCharm, WebStorm, and more

## Usage

1. Right-click on any file(s) in the Project view
2. Navigate to **Git → Git Assume**
3. Choose an action:
   - **Assume Unchanged** - Git will ignore changes
   - **No Assume Unchanged** - Git will track changes again

### Multi-file Selection

Select multiple files using `Cmd+Click` (macOS) or `Ctrl+Click` (Windows/Linux), then apply the action to all selected files at once.

## When to Use This?

Use this plugin when you need to:

- **Modify config files locally** without committing changes (e.g., database credentials, API endpoints)
- **Test changes** that shouldn't be committed to the repository
- **Keep local customizations** without them appearing in `git status`
- **Prevent accidental commits** of temporary modifications

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

## Compatibility

- **IntelliJ IDEA** 2023.2+
- **All JetBrains IDEs** (PyCharm, WebStorm, PhpStorm, etc.)
- **Future-proof** - Supports all future IDE versions

## Support

For issues or questions:
- Open an issue on [GitHub](https://github.com/eziocode/IntelliJ-Plugins)
- Refer to [Git update-index documentation](https://git-scm.com/docs/git-update-index)

## License

This project is licensed under the MIT License.

---

**Made with ❤️ by Aswin**
