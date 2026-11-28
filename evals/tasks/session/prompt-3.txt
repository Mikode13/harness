Rename the priority `'normal'` to `'medium'` everywhere: in the type, the default and the order.
Lists stored before keep loading: a stored `'normal'` loads as `'medium'`, and `toJSON` writes
`'medium'`. `'normal'` is no longer accepted by `add` or `list`. Update the tests.
