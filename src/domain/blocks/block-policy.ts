export const BLOCK_LIMIT = 500;
// Block and unblock requests per user per hour (existing fixed-window limiter;
// every request counts, which also slows probing of user ids).
export const BLOCK_CHANGE_LIMIT = 60;
export const BLOCK_CHANGE_WINDOW_MS = 60 * 60 * 1000;
