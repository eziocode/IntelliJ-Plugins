package io.github.gitassume;

import java.awt.BorderLayout;
import java.awt.Dimension;

import javax.swing.BorderFactory;
import javax.swing.JComponent;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JSplitPane;
import javax.swing.JTextArea;

import org.jetbrains.annotations.Nullable;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.DialogWrapper;
import com.intellij.ui.components.JBScrollPane;

/**
 * Dialog for submitting error reports to GitHub.
 * Allows users to review error details and add additional information before submitting.
 */
public class ErrorSubmissionDialog extends DialogWrapper {
    
    private final JTextArea errorDetailsArea;
    private final JTextArea additionalInfoArea;
    private final String errorReport;
    
    public ErrorSubmissionDialog(@Nullable Project project, String errorReport) {
        super(project);
        this.errorReport = errorReport;
        
        setTitle("Report Error to GitHub");
        
        // Error details (read-only)
        errorDetailsArea = new JTextArea(errorReport);
        errorDetailsArea.setEditable(false);
        errorDetailsArea.setLineWrap(true);
        errorDetailsArea.setWrapStyleWord(true);
        errorDetailsArea.setRows(10);
        
        // Additional info (editable)
        additionalInfoArea = new JTextArea();
        additionalInfoArea.setLineWrap(true);
        additionalInfoArea.setWrapStyleWord(true);
        additionalInfoArea.setRows(5);
        additionalInfoArea.setText("Please describe what you were doing when this error occurred...");
        
        init();
    }
    
    @Override
    protected @Nullable JComponent createCenterPanel() {
        JPanel panel = new JPanel(new BorderLayout(10, 10));
        panel.setPreferredSize(new Dimension(600, 500));
        
        // Error details section
        JPanel errorPanel = new JPanel(new BorderLayout(5, 5));
        errorPanel.add(new JLabel("Error Details:"), BorderLayout.NORTH);
        errorPanel.add(new JBScrollPane(errorDetailsArea), BorderLayout.CENTER);
        
        // Additional info section
        JPanel infoPanel = new JPanel(new BorderLayout(5, 5));
        infoPanel.add(new JLabel("Additional Information (optional):"), BorderLayout.NORTH);
        infoPanel.add(new JBScrollPane(additionalInfoArea), BorderLayout.CENTER);
        
        // Combine panels
        JSplitPane splitPane = new JSplitPane(JSplitPane.VERTICAL_SPLIT, errorPanel, infoPanel);
        splitPane.setResizeWeight(0.6);
        splitPane.setDividerLocation(300);
        
        panel.add(splitPane, BorderLayout.CENTER);
        
        // Info message
        JLabel infoLabel = new JLabel(
                "<html>This will open GitHub in your browser with a pre-filled issue form.<br>" +
                "The issue will be publicly visible on the repository.</html>");
        infoLabel.setBorder(BorderFactory.createEmptyBorder(5, 0, 0, 0));
        panel.add(infoLabel, BorderLayout.SOUTH);
        
        return panel;
    }
    
    public String getAdditionalInfo() {
        String text = additionalInfoArea.getText().trim();
        if (text.equals("Please describe what you were doing when this error occurred...")) {
            return "";
        }
        return text;
    }
    
    public String getErrorReport() {
        return errorReport;
    }
}
