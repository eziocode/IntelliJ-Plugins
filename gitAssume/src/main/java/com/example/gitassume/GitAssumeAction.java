package com.example.gitassume;

/**
 * Action to mark files as assume-unchanged in Git.
 * This tells Git to ignore changes to the file in the working directory.
 */
public class GitAssumeAction extends BaseGitAssumeAction {
    @Override
    protected String getFlag() {
        return "--assume-unchanged";
    }

    @Override
    protected String getActionName() {
        return "Assume Unchanged";
    }
}
