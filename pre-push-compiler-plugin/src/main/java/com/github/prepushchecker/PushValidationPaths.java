package com.github.prepushchecker;

import java.util.Locale;
import java.util.Set;

final class PushValidationPaths {
    private static final Set<String> SOURCE_EXTENSIONS = Set.of(".java", ".kt", ".groovy", ".scala");
    private static final Set<String> BUILD_FILE_NAMES = Set.of(
        "pom.xml",
        "build.gradle",
        "build.gradle.kts",
        "settings.gradle",
        "settings.gradle.kts",
        "gradle.properties",
        "gradlew",
        "mvnw"
    );

    private PushValidationPaths() {
    }

    static boolean isRelevantPath(String path) {
        return isBuildFile(path) || isCompilableSource(path);
    }

    static boolean isBuildFile(String path) {
        if (path == null || path.isBlank()) {
            return false;
        }
        return BUILD_FILE_NAMES.contains(fileName(path));
    }

    static boolean isCompilableSource(String path) {
        if (path == null || path.isBlank() || isBuildFile(path)) {
            return false;
        }

        String normalized = normalizePath(path).toLowerCase(Locale.ROOT);
        return SOURCE_EXTENSIONS.stream().anyMatch(normalized::endsWith);
    }

    static String normalizePath(String path) {
        return path == null ? "" : path.replace('\\', '/');
    }

    private static String fileName(String path) {
        String normalized = normalizePath(path).toLowerCase(Locale.ROOT);
        int slashIndex = normalized.lastIndexOf('/');
        return slashIndex >= 0 ? normalized.substring(slashIndex + 1) : normalized;
    }
}
