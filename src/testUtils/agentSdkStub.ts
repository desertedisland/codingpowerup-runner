// Jest stand-in for @anthropic-ai/claude-agent-sdk. The real package is ESM-only and cannot be
// loaded by ts-jest's CommonJS transform; tests never call the agent, so the stub only has to
// exist. Mapped in via moduleNameMapper in package.json.
export const query = () => {
  throw new Error('The Agent SDK is stubbed under test');
};

export const tool = () => ({});

export const createSdkMcpServer = () => ({});

export type SDKMessage = { type: string };
