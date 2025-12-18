package io.github.gitassume;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import org.jetbrains.annotations.NotNull;

import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.progress.ProgressIndicator;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.progress.Task;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;

import git4idea.commands.Git;
import git4idea.commands.GitCommand;
import git4idea.commands.GitCommandResult;
import git4idea.commands.GitLineHandler;
import git4idea.repo.GitRepository;
import git4idea.repo.GitRepositoryManager;

/**
 * Base class for Git assume-unchanged actions.
 * Provides common functionality for running git update-index commands.
 */
public abstract class BaseGitAssumeAction extends AnAction {

    /**
     * Returns the git update-index flag to use (e.g., "--assume-unchanged" or
     * "--no-assume-unchanged")
     */
    protected abstract String getFlag();

    /**
     * Returns the action name for notifications (e.g., "Assume Unchanged" or "No
     * Assume Unchanged")
     */
    protected abstract String getActionName();

    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        VirtualFile[] files = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY);

        if (project == null || files == null || files.length == 0) {
            return;
        }

        // Run Git repository operations in background thread to avoid EDT issues
        ProgressManager.getInstance().run(new Task.Backgroundable(project, getActionName(), false) {
            @Override
            public void run(@NotNull ProgressIndicator indicator) {
                // Validate that files are in a Git repository
                GitRepositoryManager gitRepositoryManager = GitRepositoryManager.getInstance(project);
                List<VirtualFile> validFiles = Arrays.stream(files)
                        .filter(file -> !file.isDirectory() && gitRepositoryManager.getRepositoryForFile(file) != null)
                        .collect(Collectors.toList());

                if (validFiles.isEmpty()) {
                    showNotification(
                            project,
                            "No Valid Files",
                            "Selected files are not in a Git repository or are directories.",
                            NotificationType.WARNING);
                    return;
                }

                // Process files grouped by repository
                Map<GitRepository, List<VirtualFile>> filesByRepo = new HashMap<>();
                for (VirtualFile file : validFiles) {
                    GitRepository repository = gitRepositoryManager.getRepositoryForFile(file);
                    if (repository != null) {
                        filesByRepo.computeIfAbsent(repository, k -> new ArrayList<>()).add(file);
                    }
                }

                int successCount = 0;
                int failureCount = 0;
                List<String> errors = new ArrayList<>();

                for (Map.Entry<GitRepository, List<VirtualFile>> entry : filesByRepo.entrySet()) {
                    GitRepository repository = entry.getKey();
                    List<VirtualFile> repoFiles = entry.getValue();

                    for (VirtualFile file : repoFiles) {
                        CommandResult result = runGitCommand(project, repository, file);
                        if (result.success) {
                            successCount++;
                        } else {
                            failureCount++;
                            errors.add(file.getName() + ": " + result.error);
                        }
                    }
                }

                // Show result notification
                if (failureCount == 0) {
                    String message;
                    if (successCount == 1) {
                        message = "Successfully applied " + getActionName() + " to " + validFiles.get(0).getName();
                    } else {
                        message = "Successfully applied " + getActionName() + " to " + successCount + " file(s)";
                    }
                    showNotification(project, getActionName(), message, NotificationType.INFORMATION);
                } else if (successCount == 0) {
                    showNotification(
                            project,
                            getActionName() + " Failed",
                            "Failed to process " + failureCount + " file(s):\n" + String.join("\n", errors),
                            NotificationType.ERROR);
                } else {
                    showNotification(
                            project,
                            getActionName() + " Partial Success",
                            "Processed " + successCount + " file(s) successfully, " + failureCount + " failed:\n"
                                    + String.join("\n", errors),
                            NotificationType.WARNING);
                }
            }
        });
    }

    private static class CommandResult {
        final boolean success;
        final String error;

        CommandResult(boolean success, String error) {
            this.success = success;
            this.error = error;
        }

        CommandResult(boolean success) {
            this(success, "");
        }
    }

    private CommandResult runGitCommand(Project project, GitRepository repository, VirtualFile file) {
        try {
            GitLineHandler handler = new GitLineHandler(project, repository.getRoot(), GitCommand.UPDATE_INDEX);
            handler.addParameters(getFlag());

            // Get the relative path from repository root to the file
            String filePath = file.getPath();
            String rootPath = repository.getRoot().getPath();
            String relativePath = filePath.startsWith(rootPath)
                    ? filePath.substring(rootPath.length()).replaceFirst("^/", "")
                    : file.getName();

            handler.addParameters(relativePath);

            GitCommandResult result = Git.getInstance().runCommand(handler);

            if (result.success()) {
                return new CommandResult(true);
            } else {
                String errorMessage = result.getErrorOutputAsJoinedString();
                if (errorMessage.isEmpty()) {
                    errorMessage = "Unknown error";
                }
                return new CommandResult(false, errorMessage);
            }
        } catch (Exception e) {
            String errorMessage = e.getMessage();
            if (errorMessage == null) {
                errorMessage = "Unknown exception";
            }
            return new CommandResult(false, errorMessage);
        }
    }

    public static void showNotification(Project project, String title, String content, NotificationType type) {
        NotificationGroupManager.getInstance()
                .getNotificationGroup("Git Assume Notifications")
                .createNotification(title, content, type)
                .notify(project);
    }
}
