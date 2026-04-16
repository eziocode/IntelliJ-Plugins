package com.github.prepushchecker;

import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.startup.StartupActivity;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.EnumSet;
import java.util.Set;

public final class GitHookInstaller implements StartupActivity {
    private static final Logger LOG = Logger.getInstance(GitHookInstaller.class);
    static final String HOOK_MARKER = "pre-push-compilation-checker-plugin";
    static final String MANAGED_HOOK_NAME = "pre-push-prepushchecker";
    private static final Set<PosixFilePermission> HOOK_PERMISSIONS = EnumSet.of(
        PosixFilePermission.OWNER_READ,
        PosixFilePermission.OWNER_WRITE,
        PosixFilePermission.OWNER_EXECUTE,
        PosixFilePermission.GROUP_READ,
        PosixFilePermission.GROUP_EXECUTE,
        PosixFilePermission.OTHERS_READ,
        PosixFilePermission.OTHERS_EXECUTE
    );

    @Override
    public void runActivity(Project project) {
        String basePath = project.getBasePath();
        if (basePath == null || basePath.isBlank()) {
            return;
        }

        Path gitDirectory = Path.of(basePath, ".git");
        if (!Files.isDirectory(gitDirectory)) {
            LOG.info("No .git directory found under " + basePath + "; skipping hook installation.");
            return;
        }

        Path hooksDirectory = gitDirectory.resolve("hooks");
        Path mainHook = hooksDirectory.resolve("pre-push");
        Path managedHook = hooksDirectory.resolve(MANAGED_HOOK_NAME);

        try {
            Files.createDirectories(hooksDirectory);
            String managedContent = buildManagedHookScript();
            if (!Files.exists(managedHook) || !Files.readString(managedHook, StandardCharsets.UTF_8).equals(managedContent)) {
                Files.writeString(managedHook, managedContent, StandardCharsets.UTF_8);
            }
            makeExecutable(managedHook.toFile());

            if (Files.exists(mainHook)) {
                String existingContent = Files.readString(mainHook, StandardCharsets.UTF_8);
                if (existingContent.contains(MANAGED_HOOK_NAME)) {
                    LOG.info("Pre-push hook already delegates to the managed checker.");
                    return;
                }

                if (existingContent.contains(HOOK_MARKER)) {
                    Files.writeString(mainHook, buildWrapperHookScript(), StandardCharsets.UTF_8);
                    makeExecutable(mainHook.toFile());
                    LOG.info("Updated existing managed pre-push hook.");
                    return;
                }

                Files.writeString(mainHook, existingContent + buildDelegatingSnippet(), StandardCharsets.UTF_8);
                makeExecutable(mainHook.toFile());
                LOG.info("Chained the managed pre-push checker into an existing hook.");
                return;
            }

            Files.writeString(mainHook, buildWrapperHookScript(), StandardCharsets.UTF_8);
            makeExecutable(mainHook.toFile());
            LOG.info("Installed pre-push hook wrapper (detected build tool: " + detectBuildTool(basePath) + ").");
        } catch (IOException ioException) {
            LOG.error("Failed to install the pre-push hook.", ioException);
        }
    }

    static BuildTool detectBuildTool(String basePath) {
        if (new File(basePath, "gradlew").exists()) {
            return BuildTool.GRADLE_WRAPPER;
        }
        if (new File(basePath, "build.gradle.kts").exists() || new File(basePath, "build.gradle").exists()) {
            return BuildTool.GRADLE;
        }
        if (new File(basePath, "mvnw").exists()) {
            return BuildTool.MAVEN_WRAPPER;
        }
        if (new File(basePath, "pom.xml").exists()) {
            return BuildTool.MAVEN;
        }
        return BuildTool.UNKNOWN;
    }

    static String buildManagedHookScript() {
        return String.join("\n",
            "#!/usr/bin/env sh",
            "# " + HOOK_MARKER,
            "# Installed by the Pre-Push Compilation Checker IntelliJ plugin.",
            "",
            "NULL_SHA=0000000000000000000000000000000000000000",
            "",
            "collect_changed_files() {",
            "  while IFS=' ' read -r local_ref local_sha remote_ref remote_sha; do",
            "    [ -z \"${local_sha:-}\" ] && continue",
            "    if [ \"$local_sha\" = \"$NULL_SHA\" ]; then",
            "      continue",
            "    fi",
            "",
            "    if [ \"${remote_sha:-$NULL_SHA}\" = \"$NULL_SHA\" ]; then",
            "      git rev-list \"$local_sha\" --not --remotes 2>/dev/null | while IFS= read -r commit_sha; do",
            "        [ -z \"$commit_sha\" ] && continue",
            "        git diff-tree --no-commit-id --name-only -r \"$commit_sha\" 2>/dev/null",
            "      done",
            "    else",
            "      git diff --name-only --diff-filter=ACMR \"$remote_sha\" \"$local_sha\" 2>/dev/null",
            "    fi",
            "  done",
            "}",
            "",
            "run_compilation() {",
            "  if [ -n \"${PRE_PUSH_CHECKER_COMMAND:-}\" ]; then",
            "    sh -c \"$PRE_PUSH_CHECKER_COMMAND\"",
            "    return $?",
            "  fi",
            "",
            "  if [ -x \"./gradlew\" ]; then",
            "    ./gradlew --daemon --quiet classes",
            "    return $?",
            "  fi",
            "",
            "  if [ -f \"./build.gradle\" ] || [ -f \"./build.gradle.kts\" ]; then",
            "    gradle --daemon --quiet classes",
            "    return $?",
            "  fi",
            "",
            "  if [ -x \"./mvnw\" ]; then",
            "    ./mvnw -q -DskipTests -T1C compile",
            "    return $?",
            "  fi",
            "",
            "  if [ -f \"./pom.xml\" ]; then",
            "    mvn -q -DskipTests -T1C compile",
            "    return $?",
            "  fi",
            "",
            "  echo \"[pre-push] No supported build tool found. Skipping compilation check.\"",
            "  return 0",
            "}",
            "",
            "CHANGED_FILES=\"$(collect_changed_files | sed '/^$/d' | sort -u)\"",
            "",
            "if [ -z \"$CHANGED_FILES\" ]; then",
            "  if git rev-parse --verify --quiet '@{upstream}' >/dev/null 2>&1; then",
            "    CHANGED_FILES=\"$(git diff --name-only --diff-filter=ACMR '@{upstream}...HEAD' 2>/dev/null | sed '/^$/d' | sort -u)\"",
            "  else",
            "    CHANGED_FILES=\"$(git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null | sed '/^$/d' | sort -u)\"",
            "  fi",
            "fi",
            "",
            "if [ -z \"$CHANGED_FILES\" ]; then",
            "  echo \"[pre-push] No outgoing files detected. Skipping compilation check.\"",
            "  exit 0",
            "fi",
            "",
            "if ! printf '%s\\n' \"$CHANGED_FILES\" | grep -Eq '(^|/)(pom\\.xml|build\\.gradle(\\.kts)?|settings\\.gradle(\\.kts)?|gradle\\.properties|gradlew|mvnw)$|(\\.java|\\.kt|\\.groovy|\\.scala)$'; then",
            "  echo \"[pre-push] No source or build changes detected. Skipping compilation check.\"",
            "  exit 0",
            "fi",
            "",
            "echo \"[pre-push] Relevant source/build changes detected. Running compilation check...\"",
            "run_compilation",
            "EXIT_CODE=$?",
            "",
            "if [ \"$EXIT_CODE\" -ne 0 ]; then",
            "  echo \"[pre-push] Compilation failed. Push aborted.\"",
            "  exit 1",
            "fi",
            "",
            "echo \"[pre-push] Compilation passed. Proceeding with push.\"",
            "exit 0",
            ""
        );
    }

    static String buildWrapperHookScript() {
        return String.join("\n",
            "#!/usr/bin/env sh",
            "# " + HOOK_MARKER,
            "SCRIPT_DIR=\"$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\"",
            "\"$SCRIPT_DIR/" + MANAGED_HOOK_NAME + "\" \"$@\"",
            ""
        );
    }

    static String buildDelegatingSnippet() {
        return String.join("\n",
            "",
            "# " + HOOK_MARKER,
            "SCRIPT_DIR=\"$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\"",
            "\"$SCRIPT_DIR/" + MANAGED_HOOK_NAME + "\" \"$@\" || exit $?",
            ""
        );
    }

    private static void makeExecutable(File file) throws IOException {
        try {
            Files.setPosixFilePermissions(file.toPath(), HOOK_PERMISSIONS);
        } catch (UnsupportedOperationException unsupportedOperationException) {
            if (!file.setExecutable(true, false)) {
                throw new IOException("Failed to mark hook as executable: " + file.getAbsolutePath());
            }
        }
    }

    enum BuildTool {
        GRADLE_WRAPPER,
        GRADLE,
        MAVEN_WRAPPER,
        MAVEN,
        UNKNOWN
    }
}
