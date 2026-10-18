// The environment the Claude Code subprocess runs with. The agent runs under the owner's Claude
// subscription via a long-lived token from `claude setup-token`; the API key is for the
// factory's own direct model calls and must not reach the agent, or it would bill the key
// instead. With neither set, the subprocess falls back to the machine's interactive login.
// Like any product command, the agent's own npm runs must not see the factory's .env (port,
// database, JWT secret), so the base is childEnv() and only the token is added back.
import { childEnv } from '../../process/childEnv/childEnv';

export const buildAgentEnvironment = (): Record<string, string> => {

  const environment: Record<string, string> = {};

  // env replaces the subprocess environment, so carry PATH etc. across
  Object.entries(childEnv()).forEach(([key, value]) => {
    if (typeof value === 'string' && key !== 'ANTHROPIC_API_KEY' && key !== 'CLAUDE_CODE_OAUTH_TOKEN') {
      environment[key] = value;
    }
  });

  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    environment.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  return environment;

};
