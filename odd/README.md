# ODD: how work is planned here

Mirador is built with ODD (Organic Driven Development), a light method for planning and recording
changes. Each feature gets one Markdown file, its feature document. The maintainer's feature documents
are kept outside this repository, and the `odd/tasks/` folder is not part of it. Code comments may still
cite their spec ids (`S1`, `S2`, ...); you do not need those documents to work on the code.

Contributors are not required to write a feature document. A good pull request description is enough:
what changes and why, and how it was checked (the commands you ran and what they printed).

## The feature document

A feature document has four parts:

- **Objective.** One or two sentences: what the feature is for, and the branch it lives on.
- **Specs.** Numbered rules (`S1`, `S2`, ...) that say what must be true when the work is done. They
  are written to be checked: exact strings, error messages, limits and examples. When a summary and a
  spec disagree, the spec wins.
- **Tasks.** A table of work units (`T1`, `T2`, ...). Each row names the specs it covers, who does it,
  its status and the commits that did it.
- **Log.** Numbered entries (`L1`, `L2`, ...) appended in order and never edited afterwards: decisions
  and their reasons, what a task found, and the evidence that it was verified. Specs and tasks cite the
  log entry that settled them.

## Work-unit commits

Each task lands as one or more small commits, each a complete unit that builds and passes the tests on
its own. Messages follow Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`). A
behavior change usually comes with its test first: the test is seen failing for the intended reason,
then the change makes it pass. Pull requests stay small, around 400 authored lines.

## Verification

A task is done when its specs are shown to hold, not when the code is written. The evidence goes in the
log: the commands that were run and what they printed (test counts, exit codes, type errors). Larger or
riskier changes also get an independent check against the specs by someone who did not write them.
