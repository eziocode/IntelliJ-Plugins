package io.github.gitassume;

import java.awt.Component;
import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;

import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import com.intellij.ide.BrowserUtil;
import com.intellij.notification.Notification;
import com.intellij.notification.NotificationType;
import com.intellij.notification.Notifications;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.ErrorReportSubmitter;
import com.intellij.openapi.diagnostic.IdeaLoggingEvent;
import com.intellij.openapi.diagnostic.SubmittedReportInfo;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.project.ProjectManager;
import com.intellij.util.Consumer;

/**
 * Error reporter for Git Assume Unchanged plugin.
 * Shows a dialog for users to review error details, then opens GitHub in browser to submit.
 */
public class GitAssumeErrorReporter extends ErrorReportSubmitter {

    @Override
    public @NotNull String getReportActionText() {
        return "Report to GitHub";
    }

    @Override
    public boolean submit(
            @NotNull IdeaLoggingEvent[] events,
            @Nullable String additionalInfo,
            @NotNull Component parentComponent,
            @NotNull Consumer<? super SubmittedReportInfo> consumer) {

        // Build error report
        StringBuilder errorReport = new StringBuilder();
        
        for (IdeaLoggingEvent event : events) {
            if (event.getThrowable() != null) {
                errorReport.append("**Error Message:**\n");
                errorReport.append(event.getThrowableText()).append("\n\n");
            }
        }

        if (additionalInfo != null && !additionalInfo.isEmpty()) {
            errorReport.append("**Additional Information:**\n");
            errorReport.append(additionalInfo).append("\n\n");
        }

        String errorReportText = """
                ## Error Report
                
                **Plugin Version:** 1.3.0
                
                %s
                
                ---
                *This error was reported automatically from IntelliJ IDEA*""".formatted(errorReport.toString());

        // Show dialog on EDT
        ApplicationManager.getApplication().invokeLater(() -> {
            Project project = getProject();
            ErrorSubmissionDialog dialog = new ErrorSubmissionDialog(project, errorReportText);
            
            if (dialog.showAndGet()) {
                // User clicked OK, open browser with GitHub issue form
                submitToGitHub(events, dialog.getAdditionalInfo(), dialog.getErrorReport(), consumer, project);
            } else {
                // User cancelled
                consumer.consume(new SubmittedReportInfo(
                        null,
                        "Cancelled by user",
                        SubmittedReportInfo.SubmissionStatus.FAILED));
            }
        });

        return true;
    }
    
    private void submitToGitHub(
            @NotNull IdeaLoggingEvent[] events,
            String additionalInfo,
            String errorReport,
            @NotNull Consumer<? super SubmittedReportInfo> consumer,
            @Nullable Project project) {
        
        // Create GitHub issue title
        String title = "Error Report: " + (events.length > 0 && events[0].getThrowable() != null 
                ? events[0].getThrowable().getClass().getSimpleName() 
                : "Plugin Error");
        
        // Build full report with user description
        StringBuilder fullReport = new StringBuilder(errorReport);
        if (additionalInfo != null && !additionalInfo.isEmpty()) {
            fullReport.append("\n\n**User Description:**\n").append(additionalInfo);
        }

        try {
            String encodedTitle = URLEncoder.encode(title, "UTF-8");
            String encodedBody = URLEncoder.encode(fullReport.toString(), "UTF-8");
            String issueUrl = "https://github.com/eziocode/IntelliJ-Plugins/issues/new?title=" + 
                    encodedTitle + "&body=" + encodedBody + "&labels=bug,git-assume-plugin";
            
            // Open browser
            BrowserUtil.browse(issueUrl);
            
            // Show success notification
            Notification notification = new Notification(
                    "Git Assume Notifications",
                    "Opening GitHub Issue Form",
                    "Your browser will open with a pre-filled GitHub issue. Please review and submit.",
                    NotificationType.INFORMATION);
            Notifications.Bus.notify(notification, project);
            
            consumer.consume(new SubmittedReportInfo(
                    issueUrl,
                    "GitHub Issue",
                    SubmittedReportInfo.SubmissionStatus.NEW_ISSUE));
            
        } catch (UnsupportedEncodingException e) {
            // Show error notification
            Notification notification = new Notification(
                    "Git Assume Notifications",
                    "Failed to Open GitHub",
                    "Failed to create GitHub issue URL. Please report manually at: " +
                    "https://github.com/eziocode/IntelliJ-Plugins/issues/new",
                    NotificationType.ERROR);
            Notifications.Bus.notify(notification, project);
            
            consumer.consume(new SubmittedReportInfo(
                    null,
                    "Failed to create issue URL",
                    SubmittedReportInfo.SubmissionStatus.FAILED));
        }
    }
    
    private Project getProject() {
        Project[] projects = ProjectManager.getInstance().getOpenProjects();
        return projects.length > 0 ? projects[0] : null;
    }
}

