package io.github.gitassume;

import java.awt.BorderLayout;
import java.awt.Dimension;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.awt.event.HierarchyEvent;
import java.awt.event.HierarchyListener;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import javax.swing.BorderFactory;
import javax.swing.Box;
import javax.swing.BoxLayout;
import javax.swing.JButton;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JScrollPane;
import javax.swing.JTable;
import javax.swing.ListSelectionModel;
import javax.swing.table.AbstractTableModel;

import org.jetbrains.annotations.NotNull;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.progress.ProgressIndicator;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.progress.Task;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.ui.components.JBLabel;
import com.intellij.ui.components.JBScrollPane;
import com.intellij.ui.table.JBTable;
import com.intellij.util.ui.JBUI;

import git4idea.repo.GitRepository;
import git4idea.repo.GitRepositoryManager;

/**
 * Panel displaying files marked as assume-unchanged in Git repositories.
 * Allows users to view and unassume these files.
 */
public class AssumedFilesPanel extends JPanel {

    private final Project project;
    private final JBTable fileTable;
    private final AssumedFilesTableModel tableModel;
    private final JButton unassumeButton;
    private final JButton refreshButton;
    private final JBLabel statusLabel;

    public AssumedFilesPanel(@NotNull Project project) {
        this.project = project;
        this.tableModel = new AssumedFilesTableModel();
        this.fileTable = new JBTable(tableModel);
        this.unassumeButton = new JButton("Unassume Selected");
        this.refreshButton = new JButton("Refresh");
        this.statusLabel = new JBLabel("");

        initializeUI();
        loadAssumedFiles();
    }

    private void initializeUI() {
        setLayout(new BorderLayout(5, 5));
        setBorder(JBUI.Borders.empty(10));

        // Configure table
        fileTable.setSelectionMode(ListSelectionModel.MULTIPLE_INTERVAL_SELECTION);
        fileTable.setPreferredScrollableViewportSize(new Dimension(500, 300));
        fileTable.setFillsViewportHeight(true);

        // Add table in scroll pane
        JScrollPane scrollPane = new JBScrollPane(fileTable);
        add(scrollPane, BorderLayout.CENTER);

        // Create button panel
        JPanel buttonPanel = new JPanel();
        buttonPanel.setLayout(new BoxLayout(buttonPanel, BoxLayout.X_AXIS));
        buttonPanel.setBorder(JBUI.Borders.empty(5, 0, 0, 0));

        buttonPanel.add(statusLabel);
        buttonPanel.add(Box.createHorizontalGlue());
        buttonPanel.add(refreshButton);
        buttonPanel.add(Box.createRigidArea(new Dimension(5, 0)));
        buttonPanel.add(unassumeButton);

        add(buttonPanel, BorderLayout.SOUTH);

        // Add button actions
        refreshButton.addActionListener(new ActionListener() {
            @Override
            public void actionPerformed(ActionEvent e) {
                loadAssumedFiles();
            }
        });

        unassumeButton.addActionListener(new ActionListener() {
            @Override
            public void actionPerformed(ActionEvent e) {
                unassumeSelectedFiles();
            }
        });

        // Initial button state
        updateButtonState();

        // Update button state when selection changes
        fileTable.getSelectionModel().addListSelectionListener(e -> {
            if (!e.getValueIsAdjusting()) {
                updateButtonState();
            }
        });

        // Auto-refresh when the panel becomes visible (e.g., when the tool window tab is clicked or focused)
        addHierarchyListener(new HierarchyListener() {
            @Override
            public void hierarchyChanged(HierarchyEvent e) {
                if ((e.getChangeFlags() & (HierarchyEvent.SHOWING_CHANGED | HierarchyEvent.DISPLAYABILITY_CHANGED)) != 0) {
                    if (isShowing()) {
                        loadAssumedFiles();
                    }
                }
            }
        });
    }

    private void updateButtonState() {
        boolean hasSelection = fileTable.getSelectedRowCount() > 0;
        unassumeButton.setEnabled(hasSelection);
    }

    /**
     * Loads all assumed unchanged files from all Git repositories in the project.
     */
    public void loadAssumedFiles() {
        ProgressManager.getInstance().run(new Task.Backgroundable(project, "Loading Assumed Files", false) {
            @Override
            public void run(@NotNull ProgressIndicator indicator) {
                GitRepositoryManager repoManager = GitRepositoryManager.getInstance(project);
                List<GitRepository> repositories = repoManager.getRepositories();

                Map<VirtualFile, GitRepository> fileRepoMap = new HashMap<>();

                for (GitRepository repository : repositories) {
                    List<VirtualFile> assumedFiles = GitAssumeUtil.getAssumedUnchangedFiles(project, repository);
                    for (VirtualFile file : assumedFiles) {
                        fileRepoMap.put(file, repository);
                    }
                }

                // Update UI on EDT
                ApplicationManager.getApplication().invokeLater(() -> {
                    tableModel.setFiles(fileRepoMap);
                    updateStatusLabel(fileRepoMap.size());
                    updateButtonState();
                });
            }
        });
    }

    private void updateStatusLabel(int fileCount) {
        if (fileCount == 0) {
            statusLabel.setText("No assumed unchanged files");
        } else if (fileCount == 1) {
            statusLabel.setText("1 file");
        } else {
            statusLabel.setText(fileCount + " files");
        }
    }

    private void unassumeSelectedFiles() {
        int[] selectedRows = fileTable.getSelectedRows();
        if (selectedRows.length == 0) {
            return;
        }

        List<FileRepositoryPair> filesToUnassume = new ArrayList<>();
        for (int row : selectedRows) {
            FileRepositoryPair pair = tableModel.getFileAtRow(row);
            if (pair != null) {
                filesToUnassume.add(pair);
            }
        }

        ProgressManager.getInstance().run(new Task.Backgroundable(project, "Unassuming Files", false) {
            @Override
            public void run(@NotNull ProgressIndicator indicator) {
                int successCount = 0;
                int failureCount = 0;

                for (FileRepositoryPair pair : filesToUnassume) {
                    GitAssumeUtil.CommandResult result = GitAssumeUtil.runUpdateIndexCommand(
                            project,
                            pair.repository,
                            pair.file,
                            "--no-assume-unchanged");

                    if (result.success) {
                        successCount++;
                    } else {
                        failureCount++;
                    }
                }

                final int finalSuccessCount = successCount;
                final int finalFailureCount = failureCount;

                // Reload the list and show notification
                ApplicationManager.getApplication().invokeLater(() -> {
                    loadAssumedFiles();

                    // Show notification
                    String title = finalFailureCount == 0 ? "Files Unassumed" : "Unassume Partial Success";
                    String message;
                    if (finalFailureCount == 0) {
                        message = finalSuccessCount == 1
                                ? "Successfully unassumed 1 file"
                                : "Successfully unassumed " + finalSuccessCount + " files";
                    } else {
                        message = "Unassumed " + finalSuccessCount + " file(s), " + finalFailureCount + " failed";
                    }

                    BaseGitAssumeAction.showNotification(
                            project,
                            title,
                            message,
                            finalFailureCount == 0
                                    ? com.intellij.notification.NotificationType.INFORMATION
                                    : com.intellij.notification.NotificationType.WARNING);
                });
            }
        });
    }

    /**
     * Table model for displaying assumed unchanged files.
     */
    private static class AssumedFilesTableModel extends AbstractTableModel {
        private final List<FileRepositoryPair> files = new ArrayList<>();
        private final String[] columnNames = { "File", "Path", "Repository" };

        public void setFiles(Map<VirtualFile, GitRepository> fileRepoMap) {
            files.clear();
            for (Map.Entry<VirtualFile, GitRepository> entry : fileRepoMap.entrySet()) {
                files.add(new FileRepositoryPair(entry.getKey(), entry.getValue()));
            }
            fireTableDataChanged();
        }

        public FileRepositoryPair getFileAtRow(int row) {
            if (row >= 0 && row < files.size()) {
                return files.get(row);
            }
            return null;
        }

        @Override
        public int getRowCount() {
            return files.size();
        }

        @Override
        public int getColumnCount() {
            return columnNames.length;
        }

        @Override
        public String getColumnName(int column) {
            return columnNames[column];
        }

        @Override
        public Object getValueAt(int rowIndex, int columnIndex) {
            if (rowIndex >= files.size()) {
                return null;
            }

            FileRepositoryPair pair = files.get(rowIndex);
            VirtualFile file = pair.file;
            GitRepository repo = pair.repository;

            switch (columnIndex) {
                case 0: // File name
                    return file.getName();
                case 1: // Path
                    String repoPath = repo.getRoot().getPath();
                    String filePath = file.getPath();
                    if (filePath.startsWith(repoPath)) {
                        return filePath.substring(repoPath.length() + 1);
                    }
                    return filePath;
                case 2: // Repository
                    return repo.getRoot().getName();
                default:
                    return null;
            }
        }
    }

    /**
     * Pair of file and its repository.
     */
    static class FileRepositoryPair {
        final VirtualFile file;
        final GitRepository repository;

        FileRepositoryPair(VirtualFile file, GitRepository repository) {
            this.file = file;
            this.repository = repository;
        }
    }
}
