Now add a filter to `list`, using the priority you added: `list({ priority })` gives only the
tasks of that priority, in the same order as `list()`.

`add` and `list` throw `InvalidPriorityError`, exported from the package, for a priority that is
not one of the three. Test it.
