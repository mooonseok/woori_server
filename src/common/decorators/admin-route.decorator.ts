// Routes carrying this metadata are authorized only by the separate admin
// session guard (src/admin); the member SessionGuard never authorizes them.
export const ADMIN_ROUTE = Symbol('admin-route');
// Everything under /v1/admin belongs to the admin realm. Express routing is
// case-insensitive, so this check is too.
export const ADMIN_PATH_PATTERN = /^\/(?:api\/)?v1\/admin(?:\/|$)/i;
