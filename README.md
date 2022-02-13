# Mutation Testing autograder for testing assignments
This autograder invokes a mutation testing tool (stryker) on student-provided test suites for an instructor-provided system under test. The file `grading.yml` defines the assignment grading specification, mapping mutations to gradable units, and providing breakpoints to translate between number of mutants detected and overall grade.

The autograder is intended to be invoked directly by GradeScope (cloning this repo + calling `run_in_gradescope`), or in GitHub Actions (see `action.yml`).

This repo contains a GitHub Actions workflow to test the autograder on various instructor-provided solutions, located in the `solutions` directory.

This repo is configured for the [Spring 2022 CS4530](https://neu-se.github.io/CS4530-Spring-2022/) HW3 assignment.

## Building the action
You can test the action locally with `ts-node` to directly invoke `src/main.ts`. However, GitHub Actions (and the GradeScope script provided in this repo) assume that the code has already been transpiled into JS, and all dependencies have been packed into a single file (so downstream scripts don't need to do `npm install`). This code is generated using ncc and stored in the `dist` directory. To update it, run:

```bash
$ npm run build
$ npm run package
```