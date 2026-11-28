# Engineering handbook

How the services of the organization are written, tested and run. Every service follows it. Each section covers one subject; the sections are independent, so find the one you need rather than reading the whole handbook.

## Contents

1. Repository layout
2. Naming
3. Logging
4. Metrics
5. Tracing
6. Configuration
7. Secrets
8. Time and dates
9. Identifiers
10. Validation
11. Retries
12. Timeouts
13. Caching
14. Rate limiting
15. Feature flags
16. Database migrations
17. Background jobs
18. Webhooks
19. Events
20. Security reviews
21. HTTP API
22. Dependencies
23. Testing
24. Code review
25. Releases
26. Incidents
27. Accessibility
28. Internationalization
29. Performance budgets
30. Documentation
31. Ownership

## Repository layout

This section covers the folders of a service.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- `src/` holds the code, `tests/` the tests and `docs/` the documents.
- A handler lives in `src/handlers/`, one file per route.
- Shared helpers live next to what uses them until a second user appears.

Reviewers check this section on every pull request that touches the folders of a service. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for the folders of a service. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Repository layout: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on the folders of a service like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on the folders of a service being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Naming

This section covers names in code and in APIs.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- Types are nouns in PascalCase, functions verbs in camelCase.
- A boolean reads as a question: `archived`, `hasOwner`.
- URLs use plural nouns and kebab-case: `/projects`, `/audit-events`.

Reviewers check this section on every pull request that touches names in code and in APIs. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for names in code and in APIs. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Naming: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on names in code and in APIs like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on names in code and in APIs being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Logging

This section covers what a service writes to its logs.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- One JSON line per event, with `level`, `message` and `requestId`.
- Never log a secret, a token or an email address.
- A warning is something an operator could act on; everything else is info.

Reviewers check this section on every pull request that touches what a service writes to its logs. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for what a service writes to its logs. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Logging: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on what a service writes to its logs like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on what a service writes to its logs being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Metrics

This section covers the numbers a service publishes.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- Each handler counts its requests by status class.
- Latency is a histogram in milliseconds.
- A metric name says its unit: `request_duration_ms`.

Reviewers check this section on every pull request that touches the numbers a service publishes. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for the numbers a service publishes. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Metrics: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on the numbers a service publishes like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on the numbers a service publishes being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Tracing

This section covers how a request is followed across services.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- Every incoming request carries or gets a `traceparent`.
- A span per outgoing call, named after the callee.
- Sampling is decided at the edge, never in a handler.

Reviewers check this section on every pull request that touches how a request is followed across services. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for how a request is followed across services. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Tracing: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on how a request is followed across services like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on how a request is followed across services being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Configuration

This section covers how a service is configured.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- Configuration comes from environment variables, read once at start.
- A missing required variable stops the service at start with its name.
- Defaults are written next to where the variable is read.

Reviewers check this section on every pull request that touches how a service is configured. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for how a service is configured. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Configuration: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on how a service is configured like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on how a service is configured being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Secrets

This section covers credentials and keys.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- Secrets come from the secret store, never from the repository.
- A secret is rotated every ninety days.
- A test uses fake secrets that look obviously fake.

Reviewers check this section on every pull request that touches credentials and keys. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for credentials and keys. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Secrets: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on credentials and keys like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on credentials and keys being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Time and dates

This section covers timestamps.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- Timestamps are ISO 8601 in UTC, with milliseconds.
- A duration in an API is a whole number of milliseconds.
- Never compare dates as local times.

Reviewers check this section on every pull request that touches timestamps. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for timestamps. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Time and dates: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on timestamps like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on timestamps being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Identifiers

This section covers ids of stored things.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- Ids are opaque strings to clients.
- An id never encodes meaning a client could rely on.
- Ids sort as strings, not as numbers.

Reviewers check this section on every pull request that touches ids of stored things. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for ids of stored things. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Identifiers: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on ids of stored things like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on ids of stored things being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Validation

This section covers how input is checked.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- Input is checked at the boundary, before any work.
- A check names the field and what was expected.
- A value outside its range is refused, never clamped silently.

Reviewers check this section on every pull request that touches how input is checked. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for how input is checked. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Validation: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on how input is checked like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on how input is checked being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Retries

This section covers calling something that may fail.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- Only idempotent calls are retried.
- Retries back off exponentially with jitter, three at most.
- A retry never outlives the request that started it.

Reviewers check this section on every pull request that touches calling something that may fail. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for calling something that may fail. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Retries: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on calling something that may fail like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on calling something that may fail being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Timeouts

This section covers how long a call may take.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- Every outgoing call has a timeout.
- A handler answers within two seconds or gives up.
- A timeout is reported as `upstream_timeout`.

Reviewers check this section on every pull request that touches how long a call may take. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for how long a call may take. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Timeouts: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on how long a call may take like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on how long a call may take being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Caching

This section covers what may be cached.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- A response is cached only when its handler says so.
- Cache keys include every input that changes the answer.
- A cached answer is never shared between users.

Reviewers check this section on every pull request that touches what may be cached. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for what may be cached. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Caching: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on what may be cached like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on what may be cached being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Rate limiting

This section covers how clients are limited.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- Limits are per API key, per minute.
- A client over its limit gets `429` and `Retry-After`.
- Internal callers are limited too, with higher limits.

Reviewers check this section on every pull request that touches how clients are limited. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for how clients are limited. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Rate limiting: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on how clients are limited like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on how clients are limited being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Feature flags

This section covers turning features on and off.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- A flag has an owner and an end date.
- Code checks a flag once per request.
- A removed flag leaves no dead branch behind.

Reviewers check this section on every pull request that touches turning features on and off. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for turning features on and off. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Feature flags: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on turning features on and off like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on turning features on and off being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Database migrations

This section covers changing the schema.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- A migration is additive first: add, backfill, switch, then remove.
- A migration never edits a shipped one.
- Each migration runs in its own transaction.

Reviewers check this section on every pull request that touches changing the schema. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for changing the schema. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Database migrations: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on changing the schema like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on changing the schema being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Background jobs

This section covers work outside a request.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- A job is idempotent, keyed by what it works on.
- A failed job is retried three times, then parked for an operator.
- A job reports progress through metrics, not logs.

Reviewers check this section on every pull request that touches work outside a request. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for work outside a request. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Background jobs: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on work outside a request like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on work outside a request being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Webhooks

This section covers calling clients back.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- A webhook body is signed with the client's secret.
- Deliveries are retried for a day.
- A client acknowledges with any `2xx`.

Reviewers check this section on every pull request that touches calling clients back. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for calling clients back. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Webhooks: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on calling clients back like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on calling clients back being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Events

This section covers events published to other services.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- An event is a past-tense fact: `ProjectArchived`.
- Events carry ids, not whole objects.
- A new field may be added; none is ever removed.

Reviewers check this section on every pull request that touches events published to other services. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for events published to other services. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Events: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on events published to other services like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on events published to other services being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Security reviews

This section covers when a change needs one.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- A change that touches authentication, authorization or secrets needs a review.
- A new dependency with native code needs one.
- The reviewer signs off in the pull request.

Reviewers check this section on every pull request that touches when a change needs one. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for when a change needs one. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Security reviews: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on when a change needs one like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on when a change needs one being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## HTTP API

This section covers the HTTP APIs that services expose to clients, and how handlers answer.

### Handlers

A handler is a function from a request to a response. It does not throw for a client's mistake: it answers with an error body. It validates its input before any work, and answers within the performance budget.

### Error bodies

Every error answer has the body `{ "error": { "code": "...", "message": "..." } }`. The `code` is a stable snake_case identifier a client may branch on; the `message` is an English sentence for a developer and may change. A client's mistake is `400`, a missing resource `404`, and a conflict `409`. Use `errorResponse` in `src/http.ts`, which builds this body.

### Public shapes

A handler never answers with a stored object as it is. Each resource has a public shape, built by a `toPublic...` function next to its store, which leaves internal fields out. Lists use the same public shape as single resources.

### Listing collections

Every endpoint that lists a collection, such as `GET /projects`, works the same way, so that clients can page through any of them with one piece of code:

- **Order.** Newest first by `createdAt`; items created at the same time are ordered by `id`, ascending.
- **Page size.** The query parameter `limit` sets how many items a page holds: a whole number from 1 to 100. Without it, a page holds 25.
- **Cursor.** The query parameter `cursor` asks for the page after a previous one. It is the value of that page's `nextCursor`, given back unchanged. A cursor is opaque to clients: it is the base64url encoding (without padding) of the JSON `{"createdAt":"...","id":"..."}` of the last item of the page it continues, and the next page starts with the first item after that one in the order above.
- **Body.** The answer is `200` with `{ "items": [...], "nextCursor": "..." }`, the items in their public shape. `nextCursor` is `null` on the last page, and only there.
- **Archived items.** Items that are archived are left out unless the query has `includeArchived=true`. Any other value of `includeArchived` is refused.
- **Errors.** A `limit` that is not a whole number from 1 to 100, or an `includeArchived` other than `true` or `false`, is answered `400` with code `invalid_query`. A `cursor` that cannot be decoded, or does not hold both fields as strings, is answered `400` with code `invalid_cursor`.

### Routes

Every handler is registered in `src/routes.ts` under its method and path, such as `GET /projects`.

### The legacy admin API

Some older services still expose the legacy admin API, which pages with `page` and `perPage` (default 50, at most 500) and answers with a bare array and a `Link` header. It is deprecated: do not copy it, and do not add it to a new endpoint. New list endpoints follow "Listing collections" above.

## Dependencies

This section covers adding a package.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- Prefer the platform and what is already installed.
- A new dependency names why in its pull request.
- Versions are pinned by the lockfile.

Reviewers check this section on every pull request that touches adding a package. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for adding a package. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Dependencies: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on adding a package like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on adding a package being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Testing

This section covers what is tested and how.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- Every behavior a handler guarantees has a test, failure paths included.
- Tests call handlers directly, without a server.
- A test builds the data it needs, never shared fixtures that drift.

Reviewers check this section on every pull request that touches what is tested and how. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for what is tested and how. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Testing: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on what is tested and how like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on what is tested and how being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Code review

This section covers reviewing changes.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- A review checks behavior, tests and this handbook, in that order.
- A reviewer asks; an author decides and says why.
- A pull request stays under four hundred lines when it can.

Reviewers check this section on every pull request that touches reviewing changes. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for reviewing changes. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Code review: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on reviewing changes like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on reviewing changes being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Releases

This section covers shipping.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- Main is always releasable.
- A release is tagged from main by the pipeline.
- A breaking change to an API is a new version of it.

Reviewers check this section on every pull request that touches shipping. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for shipping. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Releases: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on shipping like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on shipping being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Incidents

This section covers when production breaks.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- The first responder opens an incident channel and names a lead.
- Fix first, then find the cause.
- Every incident gets a written review within a week.

Reviewers check this section on every pull request that touches when production breaks. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for when production breaks. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Incidents: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on when production breaks like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on when production breaks being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Accessibility

This section covers the admin console.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- Every control is reachable by keyboard.
- Text contrast meets WCAG AA.
- Errors are announced to screen readers.

Reviewers check this section on every pull request that touches the admin console. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for the admin console. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Accessibility: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on the admin console like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on the admin console being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Internationalization

This section covers text shown to people.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- API error messages are English and meant for developers.
- The console translates codes, never messages.
- Dates are formatted by the client, never the server.

Reviewers check this section on every pull request that touches text shown to people. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for text shown to people. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Internationalization: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on text shown to people like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on text shown to people being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Performance budgets

This section covers how fast things must be.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- A handler's median stays under fifty milliseconds.
- A page of a list answers in under two hundred.
- A change that slows a handler by more than ten percent says why.

Reviewers check this section on every pull request that touches how fast things must be. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for how fast things must be. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Performance budgets: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on how fast things must be like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on how fast things must be being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Documentation

This section covers writing documents.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- A document says what is true now, not its history.
- A decision has its own record with its alternatives.
- Examples are runnable or marked as sketches.

Reviewers check this section on every pull request that touches writing documents. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for writing documents. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Documentation: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on writing documents like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on writing documents being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.

## Ownership

This section covers who owns what.

This section is binding for every service in the organization. A change that departs from it says so in its pull request and links a decision record that explains why.

Most mistakes in this area come from code that was copied from an older service. When in doubt, follow this section rather than what neighbouring code does, and fix the neighbouring code when you touch it.

The rules:

- Every service has an owning team in its README.
- An owner answers pages for its service.
- A handover is written down.

Reviewers check this section on every pull request that touches who owns what. A change that does not follow it is sent back, however small it is.

The platform team maintains shared helpers for who owns what. Use them when they fit; when they do not, propose a change to the helpers rather than a local workaround.

### Ownership: common questions

**Does this apply to internal tools?** Yes. Internal tools follow the rules on who owns what like any service; the only exception is a throwaway script that never runs in production.

**What if a library does it differently?** Wrap the library so the rest of the code follows this section, and keep the difference inside the wrapper.

**Who decides an exception?** The owning team, in a decision record that the platform team reviews.

Operators rely on who owns what being consistent across services. An exception in one service is an exception every operator has to remember at three in the morning.
