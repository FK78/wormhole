import { isDatabaseReady } from "./health.service.ts";
import { getLogger, type Logger } from "../observability/logger.ts";
import { recordDatabaseCheck } from "../observability/metrics.ts";

export type DatabaseMonitorOptions = {
  intervalMs: number;
  logger?: Logger;
  check?: () => Promise<boolean>;
};

export type DatabaseMonitor = {
  stop: () => void;
};

/**
 * Polls the database independently of HTTP traffic so availability metrics
 * and alerts keep working when no requests are arriving. Transitions are
 * logged once; the gauge changes on every check.
 */
export const startDatabaseMonitor = (
  options: DatabaseMonitorOptions,
): DatabaseMonitor => {
  const logger = options.logger ?? getLogger();
  const check = options.check ?? (() => isDatabaseReady());
  let stopped = false;
  let running = false;
  let last: boolean | undefined;

  const runCheck = async (): Promise<void> => {
    if (stopped || running) return;

    running = true;

    try {
      const up = await check();
      if (stopped) return;

      recordDatabaseCheck(up);

      if (last === undefined) {
        if (!up) {
          logger.error("database health check failed", { check: "database" });
        }
      } else if (up !== last) {
        if (up) {
          logger.info("database availability restored", { check: "database" });
        } else {
          logger.error("database became unavailable", { check: "database" });
        }
      }

      last = up;
    } catch (err) {
      if (stopped) return;

      recordDatabaseCheck(false);

      if (last !== false) {
        logger.error("database health check failed", {
          check: "database",
          error: err,
        });
      }

      last = false;
    } finally {
      running = false;
    }
  };

  void runCheck();

  const timer = setInterval(() => {
    void runCheck();
  }, options.intervalMs);

  // Never hold the process open just for the monitor; the HTTP server already
  // keeps it alive while the service is running.
  timer.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
};
