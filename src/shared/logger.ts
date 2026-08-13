export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * Namespaced logger. Tests set the level to `silent` so a failing assertion
 * is not buried under simulation chatter.
 */
export function createLogger(namespace: string): Logger {
  const prefix = `[${namespace}]`;
  const enabled = (level: LogLevel): boolean => ORDER[level] >= ORDER[currentLevel];

  return {
    debug: (...args) => {
      if (enabled('debug')) console.info(prefix, ...args);
    },
    info: (...args) => {
      if (enabled('info')) console.info(prefix, ...args);
    },
    warn: (...args) => {
      if (enabled('warn')) console.warn(prefix, ...args);
    },
    error: (...args) => {
      if (enabled('error')) console.error(prefix, ...args);
    },
  };
}
