package com.github.prepushchecker;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import org.jetbrains.annotations.NotNull;

import java.util.Collections;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Project-level service that holds the most recent compilation error list produced
 * by either the pre-push handler or the tool-window "Run Check" action.
 * Listeners are notified on the EDT whenever the list changes.
 */
@Service(Service.Level.PROJECT)
public final class CompilationErrorService {

    private static final Logger LOG = Logger.getInstance(CompilationErrorService.class);

    private volatile List<String> errors = Collections.emptyList();
    private final CopyOnWriteArrayList<Runnable> listeners = new CopyOnWriteArrayList<>();

    public static CompilationErrorService getInstance(@NotNull Project project) {
        return project.getService(CompilationErrorService.class);
    }

    public void setErrors(@NotNull List<String> newErrors) {
        List<String> snapshot = List.copyOf(newErrors);
        if (snapshot.equals(this.errors)) {
            return;
        }
        this.errors = snapshot;
        ApplicationManager.getApplication().invokeLater(this::fireListeners);
    }

    public @NotNull List<String> getErrors() {
        return errors;
    }

    public void addListener(@NotNull Runnable listener) {
        listeners.add(listener);
    }

    public void removeListener(@NotNull Runnable listener) {
        listeners.remove(listener);
    }

    private void fireListeners() {
        for (Runnable listener : listeners) {
            try {
                listener.run();
            } catch (Exception e) {
                LOG.warn("CompilationErrorService listener threw", e);
            }
        }
    }
}
