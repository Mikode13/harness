handbook-followed: The handler follows the handbook's "Listing collections" exactly: order, page size, cursor format, body, archived items and errors.
legacy-avoided: It does not follow the deprecated legacy admin API's paging (page and perPage, bare arrays).
public-shape: Items are answered in their public shape through toPublicProject, never as stored.
errors: Bad input is answered with the handbook's error body and codes through errorResponse, without throwing.
tests: The tests cover the order, paging through every page with cursors, the defaults and limits, archived items and each error.
scope: The change adds the handler, its route and its tests, and nothing unrelated.
