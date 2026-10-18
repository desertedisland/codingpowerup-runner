// Waiting for a started application to answer: poll its readiness URL until it does, the
// application exits, or the time runs out
import { IRunnerReadinessCheck } from '@yellowmelon/factory-global-types';
import { IApplicationPorts } from '@yellowmelon/factory-global-types';

export const DEFAULT_READINESS: Omit<IRunnerReadinessCheck, 'url'> = { timeoutSeconds: 180, intervalMs: 1000 };

// "${CLIENT_PORT}" and "${API_PORT}" in a URL become the ports the runner chose
export const fillPorts = (template: string, ports: IApplicationPorts): string =>
  template.replace(/\$\{CLIENT_PORT\}/g, String(ports.client)).replace(/\$\{API_PORT\}/g, String(ports.api)).replace(/\$\{PORT\}/g, String(ports.client));

const answers = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
    return response.status < 500;
  } catch {
    return false;
  }
};

export type TReadinessOutcome = 'ready' | 'exited' | 'timeout';

export const waitUntilReady = async (url: string, check: Omit<IRunnerReadinessCheck, 'url'>, hasExited: () => boolean): Promise<TReadinessOutcome> => {
  const deadline = Date.now() + check.timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (hasExited()) return 'exited';
    if (await answers(url)) return 'ready';
    await new Promise((resolve) => setTimeout(resolve, check.intervalMs));
  }
  return hasExited() ? 'exited' : 'timeout';
};
