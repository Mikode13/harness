continuity: The three changes read as one consistent design: the filter builds on the priority of the first prompt, and the rename leaves no trace of the old name except where stored lists are read.
migration: Lists stored before each change keep loading, without a priority and with normal, and what is written is the new form.
validation: Invalid priorities fail with InvalidPriorityError in add and in list, and the type allows only the three.
tests: The tests cover the order, the filter, the default, invalid priorities and loading every older stored form.
conventions: It follows AGENTS.md: named exports, an error class that sets its name, no disabled rules.
scope: Each prompt changed only what it asked for, and the last one left no dead code from the earlier ones.
