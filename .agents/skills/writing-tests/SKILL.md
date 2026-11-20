---
name: writing-tests
description: Rules for writing tests, 15 dos and 13 don'ts. Use when writing or reviewing a test in any framework, choosing a test double, repairing a flaky or brittle test, or putting legacy code under test.
---

# Writing Tests

Apply these rules when you write, review or repair a test. Before you finish, check each test you touched against every rule.

## Dos

1. **Test observable behaviour through the public interface.** A test should fail only when the behaviour changes. It should pass after a refactoring that keeps the behaviour.

2. **Check one behaviour per test.** A failure then points to one cause. Write one test per behaviour, not one test per method.

3. **Name the test after the behaviour and the expected result.** A reader should understand the rule from the name without reading the body. Use the words of the domain, not the names of methods.

4. **Use the arrange, act, assert structure.** Keep one act step. Separate the three parts so the reader can find them.

5. **Keep tests fast, independent and deterministic.** Each test creates its own state and can run alone, in any order, and in parallel. The same code gives the same result on each run.

6. **Show in the test body all the data that affects the result.** Move irrelevant setup into helpers or test data builders. Accept some duplication when it makes the test easier to read.

7. **Use real collaborators when they are fast and deterministic.** Replace only the dependencies that are out of process and that other systems can observe, such as a mail server or a message bus.

8. **Prefer state verification to interaction verification.** Assert on the returned value or the resulting state. Verify a call only when the call is the behaviour, for example a message sent to an external system. When you need a double, prefer a fake to a mock.

9. **Derive test cases in a systematic way.** Divide the inputs into partitions, then test each partition and each boundary. Use structural coverage after that to find the cases you missed.

10. **See the test fail before you make it pass.** Write the test first, or break the code for a moment, and confirm that the test fails for the expected reason. For a defect, write the test that reproduces it before you write the correction.

11. **Make the failure message sufficient to diagnose the problem.** The message should give the expected value, the actual value and the context. A developer should not need a debugger to understand it.

12. **Design the code so that it is easy to test.** Separate domain logic from input, output and orchestration. Pass dependencies in from outside. Test the logic with unit tests and the orchestration with a small number of integration tests.

13. **Add characterization tests before you change legacy code.** Record the current behaviour first, including behaviour that looks wrong. Find a seam to break the dependencies, then make the change.

14. **Put most tests at the lowest level that can find the defect.** Write many unit tests, fewer integration tests and few end-to-end tests. In integration tests, use the real database that the application owns.

15. **Maintain test code with the same care as production code.** Review it, refactor it and remove tests that give little value. Each test has a maintenance cost, so keep only the tests that pay for it.

## Don'ts

1. **Do not test implementation details.** Do not test private methods directly, and do not make private state public for a test. If a private method needs its own tests, it is a missing abstraction. Extract it.

2. **Do not use mocks too much.** Do not mock types that you do not own, value objects, or collaborators inside your own system. Tests with many mocks repeat the structure of the implementation and fail on each refactoring.

3. **Do not put logic in tests.** Do not use conditionals or loops in a test. Do not calculate the expected value with a copy of the production algorithm. Write the expected value as a literal.

4. **Do not share mutable state between tests.** Shared fixtures, static data and order dependence cause failures that you cannot reproduce in isolation.

5. **Do not accept flaky tests.** Do not use sleeps, the system clock, the network or unseeded random data. Correct or remove a flaky test immediately, because the team stops trusting the full suite.

6. **Do not use code coverage as a target.** Low coverage shows that tests are missing. High coverage does not show that the tests are good, because a test can run code without checking it.

7. **Do not hide important data in shared setup or external files.** The reader cannot see why the test passes. Meszaros names these smells "mystery guest" and "general fixture".

8. **Do not add code to production only for tests.** This includes test flags, test-only branches and test-only methods. Use dependency injection instead.

9. **Do not assert more than the behaviour requires.** Do not compare full strings or full objects when only one field is relevant. Such tests fail after changes that have no relation to the behaviour.

10. **Do not ignore a test that is difficult to write.** Do not add more mocks or more setup to make it pass. The difficulty shows a design problem, so change the design.

11. **Do not test trivial code.** Do not write tests for getters, setters or code that has no logic. Such tests have a maintenance cost and find almost no defects.

12. **Do not replace a part of the code under test with a double.** Do not mock a method of the class under test. Do not mock a concrete class to keep one part of its behaviour. The test then checks a configuration that does not exist in production. Move the part that you want to replace into a separate dependency and inject it.

13. **Do not weaken a test to make it pass.** Do not skip the test, remove the assertion or change the expected value before you know why the test fails. A refactoring should not require a change to the existing tests. If it does, the behaviour changed or the test checks implementation details.
