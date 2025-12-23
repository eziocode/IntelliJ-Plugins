package io.github.gitassume;

import java.awt.Component;
import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;

import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import com.intellij.ide.BrowserUtil;
import com.intellij.openapi.diagnostic.ErrorReportSubmitter;
import com.intellij.openapi.diagnostic.IdeaLoggingEvent;
import com.intellij.openapi.diagnostic.SubmittedReportInfo;
import com.intellij.util.Consumer;

/**
 * Error reporter for Git Assume Unchanged plugin.
 * Allows users to report errors directly from the IDE to GitHub Issues.
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

        // Build error report - keep it short to avoid URL length issues
        StringBuilder errorReport = new StringBuilder();
        
        for (IdeaLoggingEvent event : events) {
            if (event.getThrowable() != null) {
                errorReport.append("**Error:** ").append(event.getThrowable().getClass().getSimpleName()).append("\n");
                
                // Only include the first line of the error message
                String message = event.getThrowable().getMessage();
                if (message != null && !message.isEmpty()) {
                    String firstLine = message.split("\\n")[0];
                    if (firstLine.length() > 200) {
                        firstLine = firstLine.substring(0, 200) + "...";
                    }
                    errorReport.append("**Message:** ").append(firstLine).append("\n");
                }
                break; // Only include first error to keep URL short
            }
        }

        if (additionalInfo != null && !additionalInfo.isEmpty()) {
            String truncatedInfo = additionalInfo.length() > 300 
                ? additionalInfo.substring(0, 300) + "..." 
                : additionalInfo;
            errorReport.append("\n**Additional Info:** ").append(truncatedInfo);
        }

        // Create GitHub issue URL
        String title = "Error Report: " + (events.length > 0 && events[0].getThrowable() != null 
                ? events[0].getThrowable().getClass().getSimpleName() 
                : "Plugin Error");
        
        String body = """
                ## Error Report
                
                **Plugin Version:** 2.1.0
                
                ### Error Details
                %s
                
                > **Note:** Full stack trace was truncated to fit URL limits.
                > Please provide additional details about what you were doing when this error occurred.
                
                ---
                *This error was reported automatically from IntelliJ IDEA*""".formatted(errorReport.toString());

        // Limit body length to avoid URL length issues (GitHub has ~8KB limit)
        if (body.length() > 1500) {
            body = body.substring(0, 1500) + "...\n\n*[Stack trace truncated]*";
        }

        try {
            String encodedTitle = URLEncoder.encode(title, "UTF-8");
            String encodedBody = URLEncoder.encode(body, "UTF-8");
            String issueUrl = "https://github.com/eziocode/IntelliJ-Plugins/issues/new?title=" + 
                    encodedTitle + "&body=" + encodedBody + "&labels=bug,git-assume-plugin";
            
            BrowserUtil.browse(issueUrl);
            
            consumer.consume(new SubmittedReportInfo(
                    issueUrl,
                    "GitHub Issue",
                    SubmittedReportInfo.SubmissionStatus.NEW_ISSUE));
            
            return true;
        } catch (UnsupportedEncodingException e) {
            consumer.consume(new SubmittedReportInfo(
                    null,
                    "Failed to create issue",
                    SubmittedReportInfo.SubmissionStatus.FAILED));
            return false;
        }
    }
}
