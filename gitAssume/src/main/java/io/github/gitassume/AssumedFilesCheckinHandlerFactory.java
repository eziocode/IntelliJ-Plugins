package io.github.gitassume;

import org.jetbrains.annotations.NotNull;

import com.intellij.openapi.vcs.CheckinProjectPanel;
import com.intellij.openapi.vcs.changes.CommitContext;
import com.intellij.openapi.vcs.checkin.CheckinHandler;
import com.intellij.openapi.vcs.checkin.VcsCheckinHandlerFactory;
import com.intellij.openapi.vcs.ui.RefreshableOnComponent;

import git4idea.GitVcs;

/**
 * Factory for creating check-in handlers that add the Assumed Files panel to the commit dialog.
 */
public class AssumedFilesCheckinHandlerFactory extends VcsCheckinHandlerFactory {

    public AssumedFilesCheckinHandlerFactory() {
        super(GitVcs.getKey());
    }

    @NotNull
    @Override
    public CheckinHandler createVcsHandler(@NotNull CheckinProjectPanel panel, @NotNull CommitContext commitContext) {
        return new AssumedFilesCheckinHandler(panel);
    }

    /**
     * Check-in handler that provides the Assumed Files panel.
     */
    private static class AssumedFilesCheckinHandler extends CheckinHandler {
        private final CheckinProjectPanel panel;

        public AssumedFilesCheckinHandler(CheckinProjectPanel panel) {
            this.panel = panel;
        }

        @Override
        public RefreshableOnComponent getBeforeCheckinConfigurationPanel() {
            return new RefreshableOnComponent() {
                private final AssumedFilesPanel assumedFilesPanel = new AssumedFilesPanel(panel.getProject());

                @Override
                public javax.swing.JComponent getComponent() {
                    return assumedFilesPanel;
                }

                @Override
                @SuppressWarnings("deprecation")
                public void refresh() {
                    assumedFilesPanel.loadAssumedFiles();
                }

                @Override
                public void saveState() {
                    // No state to save
                }

                @Override
                public void restoreState() {
                    // No state to restore
                }
            };
        }
    }
}
