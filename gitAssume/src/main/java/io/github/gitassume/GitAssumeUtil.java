package io.github.gitassume;

import java.util.ArrayList;
import java.util.List;

import org.jetbrains.annotations.NotNull;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;

import git4idea.commands.Git;
import git4idea.commands.GitCommand;
import git4idea.commands.GitCommandResult;
import git4idea.commands.GitLineHandler;
import git4idea.repo.GitRepository;

/**
 * Utility class for Git assume-unchanged operations.
 * Provides methods to query and manage files marked as assume-unchanged.
 */
public class GitAssumeUtil {

    /**
     * Retrieves all files marked as assume-unchanged in the given Git repository.
     * 
     * @param project    The current project
     * @param repository The Git repository to query
     * @return List of VirtualFile objects representing assume-unchanged files
     */
    @NotNull
    public static List<VirtualFile> getAssumedUnchangedFiles(@NotNull Project project,
            @NotNull GitRepository repository) {
        List<VirtualFile> assumedFiles = new ArrayList<>();

        try {
            // Execute: git ls-files -v
            GitLineHandler handler = new GitLineHandler(project, repository.getRoot(), GitCommand.LS_FILES);
            handler.addParameters("-v");

            GitCommandResult result = Git.getInstance().runCommand(handler);

            if (result.success()) {
                VirtualFile repositoryRoot = repository.getRoot();
                List<String> output = result.getOutput();

                for (String line : output) {
                    // Files marked as assume-unchanged are prefixed with lowercase 'h'
                    if (line.startsWith("h ") || line.startsWith("h\t")) {
                        // Extract the file path (everything after the flag)
                        String filePath = line.substring(2).trim();

                        // Find the VirtualFile
                        VirtualFile file = repositoryRoot.findFileByRelativePath(filePath);
                        if (file != null && file.exists()) {
                            assumedFiles.add(file);
                        }
                    }
                }
            }
        } catch (Exception e) {
            // Log error but don't throw - return empty list instead
            // This allows the UI to show gracefully when there are issues
        }

        return assumedFiles;
    }

    /**
     * Executes a git update-index command on a file.
     * 
     * @param project    The current project
     * @param repository The Git repository containing the file
     * @param file       The file to operate on
     * @param flag       The flag to pass to update-index (e.g., "--assume-unchanged" or
     *                   "--no-assume-unchanged")
     * @return CommandResult indicating success or failure
     */
    @NotNull
    public static CommandResult runUpdateIndexCommand(@NotNull Project project,
            @NotNull GitRepository repository,
            @NotNull VirtualFile file,
            @NotNull String flag) {
        try {
            GitLineHandler handler = new GitLineHandler(project, repository.getRoot(), GitCommand.UPDATE_INDEX);
            handler.addParameters(flag);

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

    /**
     * Result of a Git command execution.
     */
    public static class CommandResult {
        public final boolean success;
        public final String error;

        public CommandResult(boolean success, String error) {
            this.success = success;
            this.error = error;
        }

        public CommandResult(boolean success) {
            this(success, "");
        }
    }
}
