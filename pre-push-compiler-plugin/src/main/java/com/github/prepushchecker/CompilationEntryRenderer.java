package com.github.prepushchecker;

import com.intellij.icons.AllIcons;
import com.intellij.openapi.fileEditor.OpenFileDescriptor;
import com.intellij.openapi.fileTypes.FileTypeManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.io.FileUtil;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import javax.swing.*;
import java.awt.*;

/**
 * List cell renderer that displays a file-type icon next to each compilation entry.
 *
 * <p>Understands two entry formats produced by {@link PrePushCompilationHandler}:
 * <ul>
 *   <li>{@code [src/Foo.java 10:5] cannot find symbol} — compilation error</li>
 *   <li>{@code src/Foo.java} — IDE problem file</li>
 * </ul>
 */
final class CompilationEntryRenderer extends DefaultListCellRenderer {

    @Override
    public Component getListCellRendererComponent(
        JList<?> list, Object value, int index, boolean isSelected, boolean cellHasFocus
    ) {
        JLabel label = (JLabel) super.getListCellRendererComponent(
            list, value, index, isSelected, cellHasFocus
        );
        String text = value instanceof String ? (String) value : "";
        label.setIcon(iconForEntry(text));
        return label;
    }

    static Icon iconForEntry(String entry) {
        String path = extractPath(entry);
        if (path == null || path.isBlank()) {
            return AllIcons.General.Error;
        }
        int dot = path.lastIndexOf('.');
        if (dot < 0) {
            return AllIcons.General.Error;
        }
        Icon typeIcon = FileTypeManager.getInstance().getFileTypeByFileName(path).getIcon();
        return typeIcon != null ? typeIcon : AllIcons.General.Error;
    }

    /**
     * Extracts the file path from a compilation entry string.
     *
     * <ul>
     *   <li>{@code [src/Foo.java 10:5] msg} → {@code src/Foo.java}</li>
     *   <li>{@code src/Foo.java}             → {@code src/Foo.java}</li>
     * </ul>
     */
    @Nullable
    static String extractPath(String entry) {
        if (entry.startsWith("[")) {
            int end = entry.indexOf(']');
            if (end < 0) return null;
            String inner = entry.substring(1, end).trim();
            int space = inner.indexOf(' ');
            return space >= 0 ? inner.substring(0, space) : inner;
        }
        return entry.isBlank() ? null : entry;
    }

    /**
     * Opens the file referenced by {@code entry} in the editor.
     * Tries the path as-is (absolute), then relative to the project base.
     */
    static void navigateTo(@NotNull Project project, @Nullable String entry) {
        if (entry == null) return;
        String path = extractPath(entry);
        if (path == null) return;

        VirtualFile file = findFile(path);
        if (file == null && project.getBasePath() != null) {
            file = findFile(project.getBasePath() + "/" + path);
        }
        if (file != null) {
            new OpenFileDescriptor(project, file).navigate(true);
        }
    }

    @Nullable
    private static VirtualFile findFile(String path) {
        return LocalFileSystem.getInstance().findFileByPath(FileUtil.toSystemIndependentName(path));
    }
}
