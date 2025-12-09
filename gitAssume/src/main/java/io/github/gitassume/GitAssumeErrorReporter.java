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

        // Create GitHub issue URL
        String title = "Error Report: " + (events.length > 0 && events[0].getThrowable() != null 
                ? events[0].getThrowable().getClass().getSimpleName() 
                : "Plugin Error");
        
        String body = """
                ## Error Report
                
                **Plugin Version:** 1.3.0
                
                %s
                
                ---
                *This error was reported automatically from IntelliJ IDEA*
                """.formatted(errorReport.toString());

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
