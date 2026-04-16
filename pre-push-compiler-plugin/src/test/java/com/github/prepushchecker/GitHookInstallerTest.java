package com.github.prepushchecker;

import com.intellij.testFramework.fixtures.BasePlatformTestCase;

import java.io.File;
import java.io.IOException;

public class GitHookInstallerTest extends BasePlatformTestCase {
    public void testDetectBuildToolPrefersGradleWrapper() throws IOException {
        File tempDir = createTempDir("prepushchecker-gradle");
        assertTrue(new File(tempDir, "gradlew").createNewFile());
        assertTrue(new File(tempDir, "pom.xml").createNewFile());

        assertEquals(GitHookInstaller.BuildTool.GRADLE_WRAPPER, GitHookInstaller.detectBuildTool(tempDir.getAbsolutePath()));
    }

    public void testManagedHookUsesFastSkipAndOverrideCommand() {
        String script = GitHookInstaller.buildManagedHookScript();

        assertTrue(script.contains("PRE_PUSH_CHECKER_COMMAND"));
        assertTrue(script.contains("No source or build changes detected. Skipping compilation check."));
        assertTrue(script.contains("./gradlew --daemon --quiet classes"));
        assertTrue(script.contains("mvn -q -DskipTests -T1C compile"));
    }

    public void testDelegatingSnippetCallsManagedHook() {
        String snippet = GitHookInstaller.buildDelegatingSnippet();

        assertTrue(snippet.contains(GitHookInstaller.MANAGED_HOOK_NAME));
        assertTrue(snippet.contains(GitHookInstaller.HOOK_MARKER));
    }

    private static File createTempDir(String prefix) {
        File tempDir = new File(System.getProperty("java.io.tmpdir"), prefix + "-" + System.nanoTime());
        if (!tempDir.mkdirs()) {
            fail("Failed to create temp dir: " + tempDir);
        }
        tempDir.deleteOnExit();
        return tempDir;
    }
}
