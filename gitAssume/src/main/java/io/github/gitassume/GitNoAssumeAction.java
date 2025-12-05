package io.github.gitassume;

/**
 * Action to remove assume-unchanged flag from files in Git.
 * This tells Git to resume tracking changes to the file in the working directory.
 */
public class GitNoAssumeAction extends BaseGitAssumeAction {
    @Override
    protected String getFlag() {
        return "--no-assume-unchanged";
    }

    @Override
    protected String getActionName() {
        return "No Assume Unchanged";
    }
}
