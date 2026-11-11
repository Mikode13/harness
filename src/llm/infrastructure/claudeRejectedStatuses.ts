/**
 * The HTTP statuses with which Anthropic rejects the request itself: it is wrong or not allowed,
 * so sending it again cannot succeed. Shared by the Messages API client and the Agent SDK engine,
 * which reports the status of a failed turn as `api_error_status`, so both Claude paths classify
 * the same rejection the same way.
 */
export const unrecoverableClaudeStatuses: readonly number[] = [400, 401, 403, 404, 413, 422];
