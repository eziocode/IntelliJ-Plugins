package com.github.prepushchecker;

import com.intellij.dvcs.push.PrePushHandler;
import com.intellij.dvcs.push.PushInfo;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.compiler.CompileScope;
import com.intellij.openapi.compiler.CompileStatusNotification;
import com.intellij.openapi.compiler.CompilerManager;
import com.intellij.openapi.compiler.CompilerMessage;
import com.intellij.openapi.compiler.CompilerMessageCategory;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.progress.ProcessCanceledException;
import com.intellij.openapi.progress.ProgressIndicator;
import com.intellij.openapi.module.Module;
import com.intellij.openapi.module.ModuleUtilCore;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.io.FileUtil;
import com.intellij.openapi.vcs.changes.Change;
import com.intellij.openapi.vcs.changes.ContentRevision;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.problems.WolfTheProblemSolver;
import com.intellij.vcs.log.VcsFullCommitDetails;
import org.jetbrains.annotations.NotNull;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;

public final class PrePushCompilationHandler implements PrePushHandler {
    private static final Logger LOG = Logger.getInstance(PrePushCompilationHandler.class);
    private static final long WAIT_SLICE_MILLIS = 250L;
    private static final long TARGETED_TIMEOUT_MILLIS = TimeUnit.MINUTES.toMillis(2);
    private static final long FULL_BUILD_TIMEOUT_MILLIS = TimeUnit.MINUTES.toMillis(5);

    @Override
    public @NotNull String getPresentableName() {
        return "Pre-Push Compilation Checker";
    }

    @Override
    public @NotNull Result handle(
        @NotNull Project project,
        @NotNull List<PushInfo> pushDetails,
        @NotNull ProgressIndicator indicator
    ) {
        if (project.isDisposed()) {
            return Result.OK;
        }

        try {
            PushChangeSet changeSet = collectRelevantChanges(pushDetails, indicator);
            if (!changeSet.hasRelevantChanges()) {
                LOG.info("Skipping pre-push compilation check because no source/build files are affected.");
                return Result.OK;
            }

            CompilationErrorService errorService = CompilationErrorService.getInstance(project);

            List<String> problemFiles = collectKnownProblemFiles(project, changeSet.getSourceFiles());
            if (!problemFiles.isEmpty()) {
                errorService.setErrors(problemFiles);
                boolean resolved = showDialog(
                    project,
                    indicator.getModalityState(),
                    "Push Blocked - IDE Problems Found",
                    "IntelliJ already reports problems in files included in this push. Fix them before pushing:",
                    problemFiles,
                    _ind -> collectKnownProblemFiles(project, changeSet.getSourceFiles())
                );
                if (!resolved) return Result.ABORT;
            }

            List<String> errors = changeSet.requiresProjectBuild()
                ? compileProject(project, indicator)
                : compileFiles(project, changeSet.getSourceFiles(), indicator);

            if (!errors.isEmpty()) {
                errorService.setErrors(errors);
                boolean resolved = showDialog(
                    project,
                    indicator.getModalityState(),
                    "Push Blocked - Compilation Errors Found",
                    "Compilation failed for this push. Fix the following errors before retrying:",
                    errors,
                    freshInd -> changeSet.requiresProjectBuild()
                        ? compileProject(project, freshInd)
                        : compileFiles(project, changeSet.getSourceFiles(), freshInd)
                );
                if (resolved) errorService.setErrors(Collections.emptyList());
                return resolved ? Result.OK : Result.ABORT;
            }

            errorService.setErrors(Collections.emptyList());
            return Result.OK;
        } catch (ProcessCanceledException ignored) {
            LOG.info("Pre-push compilation check canceled.");
            return Result.ABORT;
        }
    }

    static boolean requiresProjectBuild(Change change, String path) {
        if (PushValidationPaths.isBuildFile(path)) {
            return true;
        }

        Change.Type type = change.getType();
        return type == Change.Type.DELETED || type == Change.Type.MOVED;
    }

    private static PushChangeSet collectRelevantChanges(List<PushInfo> pushDetails, ProgressIndicator indicator) {
        Map<String, VirtualFile> sourceFiles = new LinkedHashMap<>();
        Set<String> relevantPaths = new LinkedHashSet<>();
        boolean requiresProjectBuild = false;

        for (PushInfo pushInfo : pushDetails) {
            for (VcsFullCommitDetails commit : pushInfo.getCommits()) {
                indicator.checkCanceled();
                for (Change change : commit.getChanges()) {
                    String path = extractPath(change);
                    if (!PushValidationPaths.isRelevantPath(path)) {
                        continue;
                    }

                    relevantPaths.add(path);
                    if (requiresProjectBuild(change, path)) {
                        requiresProjectBuild = true;
                    }

                    if (PushValidationPaths.isCompilableSource(path)) {
                        VirtualFile file = findVirtualFile(change);
                        if (file != null) {
                            sourceFiles.putIfAbsent(file.getPath(), file);
                        }
                    }
                }
            }
        }

        return new PushChangeSet(new ArrayList<>(sourceFiles.values()), !relevantPaths.isEmpty(), requiresProjectBuild);
    }

    private static String extractPath(Change change) {
        ContentRevision afterRevision = change.getAfterRevision();
        if (afterRevision != null) {
            return afterRevision.getFile().getPath();
        }

        ContentRevision beforeRevision = change.getBeforeRevision();
        return beforeRevision != null ? beforeRevision.getFile().getPath() : "";
    }

    private static VirtualFile findVirtualFile(Change change) {
        ContentRevision afterRevision = change.getAfterRevision();
        if (afterRevision == null) {
            return null;
        }

        String path = FileUtil.toSystemIndependentName(afterRevision.getFile().getPath());
        LocalFileSystem localFileSystem = LocalFileSystem.getInstance();
        VirtualFile file = localFileSystem.findFileByPath(path);
        return file != null ? file : localFileSystem.refreshAndFindFileByPath(path);
    }

    private static List<String> collectKnownProblemFiles(Project project, Collection<VirtualFile> sourceFiles) {
        if (sourceFiles.isEmpty()) {
            return Collections.emptyList();
        }

        WolfTheProblemSolver problemSolver = WolfTheProblemSolver.getInstance(project);
        List<String> problemFiles = new ArrayList<>();
        for (VirtualFile sourceFile : sourceFiles) {
            if (problemSolver.isProblemFile(sourceFile)) {
                problemFiles.add(toDisplayPath(project, sourceFile));
            }
        }
        return problemFiles;
    }

    private static List<String> compileFiles(Project project, Collection<VirtualFile> sourceFiles, ProgressIndicator indicator) {
        if (sourceFiles.isEmpty()) {
            return Collections.emptyList();
        }

        CompilerManager compilerManager = CompilerManager.getInstance(project);

        // Compile at module granularity so that callers of changed APIs (Case 2: A depends on
        // B, only B pushed) are also recompiled and any breakage is detected.
        Set<Module> modules = new LinkedHashSet<>();
        for (VirtualFile file : sourceFiles) {
            Module module = ModuleUtilCore.findModuleForFile(file, project);
            if (module != null) {
                modules.add(module);
            }
        }

        CompileScope scope = modules.isEmpty()
            ? compilerManager.createFilesCompileScope(sourceFiles.toArray(VirtualFile.EMPTY_ARRAY))
            : compilerManager.createModulesCompileScope(modules.toArray(Module.EMPTY_ARRAY), false);

        return runCompilation(
            project,
            indicator,
            TARGETED_TIMEOUT_MILLIS,
            notification -> compilerManager.make(scope, notification)
        );
    }

    private static List<String> compileProject(Project project, ProgressIndicator indicator) {
        CompilerManager compilerManager = CompilerManager.getInstance(project);
        CompileScope scope = compilerManager.createProjectCompileScope(project);
        return runCompilation(
            project,
            indicator,
            FULL_BUILD_TIMEOUT_MILLIS,
            notification -> compilerManager.make(scope, notification)
        );
    }

    private static List<String> runCompilation(
        Project project,
        ProgressIndicator indicator,
        long timeoutMillis,
        CompilationStarter compilationStarter
    ) {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<List<String>> errors = new AtomicReference<>(Collections.emptyList());

        Runnable startCompilation = () -> compilationStarter.start((aborted, errorCount, warnings, compileContext) -> {
            if (aborted) {
                errors.set(Collections.singletonList("Compilation was aborted."));
            } else if (errorCount > 0) {
                errors.set(formatCompilerMessages(project, compileContext.getMessages(CompilerMessageCategory.ERROR)));
            }
            latch.countDown();
        });

        Application application = ApplicationManager.getApplication();
        if (application.isDispatchThread()) {
            startCompilation.run();
        } else {
            application.invokeAndWait(startCompilation, ModalityState.any());
        }

        long deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis);
        try {
            while (true) {
                indicator.checkCanceled();
                long remainingNanos = deadlineNanos - System.nanoTime();
                if (remainingNanos <= 0) {
                    return Collections.singletonList("Compilation check timed out.");
                }

                long waitMillis = Math.min(WAIT_SLICE_MILLIS, TimeUnit.NANOSECONDS.toMillis(remainingNanos));
                if (latch.await(waitMillis, TimeUnit.MILLISECONDS)) {
                    return errors.get();
                }
            }
        } catch (InterruptedException interruptedException) {
            Thread.currentThread().interrupt();
            return Collections.singletonList("Compilation check was interrupted.");
        }
    }

    static List<String> formatCompilerMessages(Project project, CompilerMessage[] messages) {
        List<String> formattedMessages = new ArrayList<>();
        for (CompilerMessage message : messages) {
            if (message == null) {
                continue;
            }

            StringBuilder builder = new StringBuilder();
            VirtualFile file = message.getVirtualFile();
            builder.append('[');
            builder.append(file != null ? toDisplayPath(project, file) : "unknown");
            String prefix = message.getRenderTextPrefix();
            if (prefix != null && !prefix.isBlank()) {
                builder.append(' ').append(prefix.trim());
            }
            builder.append("] ").append(message.getMessage());
            formattedMessages.add(builder.toString());
        }

        if (formattedMessages.isEmpty()) {
            return Collections.singletonList("Compilation failed with an unknown compiler error.");
        }
        return formattedMessages;
    }

    static String toDisplayPath(Project project, VirtualFile file) {
        String projectBasePath = project.getBasePath();
        if (projectBasePath == null) {
            return file.getPath();
        }

        String relativePath = FileUtil.getRelativePath(projectBasePath, file.getPath(), '/');
        return relativePath != null ? relativePath : file.getPath();
    }

    private static boolean showDialog(
        Project project,
        ModalityState modalityState,
        String title,
        String header,
        List<String> items,
        Function<ProgressIndicator, List<String>> refreshAction
    ) {
        boolean[] result = {false};
        ApplicationManager.getApplication().invokeAndWait(
            () -> {
                CompilationReportDialog dialog = new CompilationReportDialog(
                    project, title, header, items, refreshAction
                );
                result[0] = dialog.showAndGet();
            },
            modalityState
        );
        return result[0];
    }

    @FunctionalInterface
    private interface CompilationStarter {
        void start(CompileStatusNotification notification);
    }

    private static final class PushChangeSet {
        private final List<VirtualFile> sourceFiles;
        private final boolean hasRelevantChanges;
        private final boolean requiresProjectBuild;

        private PushChangeSet(List<VirtualFile> sourceFiles, boolean hasRelevantChanges, boolean requiresProjectBuild) {
            this.sourceFiles = sourceFiles;
            this.hasRelevantChanges = hasRelevantChanges;
            this.requiresProjectBuild = requiresProjectBuild;
        }

        private List<VirtualFile> getSourceFiles() {
            return sourceFiles;
        }

        private boolean hasRelevantChanges() {
            return hasRelevantChanges;
        }

        private boolean requiresProjectBuild() {
            return requiresProjectBuild;
        }
    }
}
