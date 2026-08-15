import { hashSecret } from '../src/hash.ts'

export const TEST_AGENT_SECRET = 'test-agent-secret-1'

/** Fast bcrypt cost for fixtures; production writes use {@link hashSecret}'s default. */
export const BCRYPT_TEST_ROUNDS = 4

export function hashedHubYaml(options: {
  users: Record<string, string>
  agentSecret?: string
  host?: string
  port?: number
  extra?: string
}): string {
  const secret = options.agentSecret ?? TEST_AGENT_SECRET
  const lines = [
    options.host !== undefined ? `host: ${options.host}` : undefined,
    options.port !== undefined ? `port: ${String(options.port)}` : undefined,
    options.extra,
    `agentSecret: ${JSON.stringify(hashSecret(secret, BCRYPT_TEST_ROUNDS))}`,
    'users:',
    ...Object.entries(options.users).map(
      ([username, password]) => `  ${username}: ${JSON.stringify(hashSecret(password, BCRYPT_TEST_ROUNDS))}`,
    ),
    '',
  ]
  return lines.filter((line): line is string => line !== undefined).join('\n')
}
