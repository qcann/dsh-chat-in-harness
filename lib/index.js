/**
 * Chat in Harness — host half.
 *
 * Its only job is to give the loader a module declaring `dsh.client`.
 * Every widget and behavior lives in lib/client.js; nothing here registers
 * services, sends requests, or touches files.
 */
export const name = 'dsh-chat-in-harness'
export const inject = []

export function apply() {}
