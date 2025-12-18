package io.github.gitassume;

import javax.swing.JComponent;

import org.jetbrains.annotations.NotNull;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;

/**
 * Factory for creating the Assumed Files tool window tab.
 */
public class AssumedFilesToolWindow implements ToolWindowFactory {

    @Override
    public void createToolWindowContent(@NotNull Project project, @NotNull ToolWindow toolWindow) {
        AssumedFilesPanel assumedFilesPanel = new AssumedFilesPanel(project);
        ContentFactory contentFactory = ContentFactory.getInstance();
        Content content = contentFactory.createContent(assumedFilesPanel, "Assumed Files", false);
        toolWindow.getContentManager().addContent(content);
    }
}
