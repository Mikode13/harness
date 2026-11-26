Give tasks a priority: `'low' | 'normal' | 'high'`, `'normal'` by default.

- `add(title, priority?)` sets it, and a task carries it.
- `list()` gives the tasks by priority, high first, and within one priority oldest first.
- Stored tasks keep their priority through `toJSON` and the constructor, and a stored task
  without one, stored before this change, loads as `'normal'`.

Test it.
