// The runner as a library: what a wrapper (the CLI, a service, a tray application) uses
export { RunnerConnection, socketUrlFor } from './connection/RunnerConnection';
export { readRunnerConfig, writeRunnerConfig, requireServer } from './config/RunnerConfig';
export { detectCapabilities } from './capabilities/capabilities';
export { describeProjects } from './repositories/RepositoryRegistry';
export { connect, start, status } from './cli/commands';
export { JobDispatcher } from './jobs/JobDispatcher';
export { JobLedger } from './jobs/JobLedger';
export { handlers } from './jobs/handlers';
