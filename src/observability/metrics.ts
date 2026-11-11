import { buildInfo } from "../utils/buildInfo.ts";

export type MetricLabels = Readonly<Record<string, string>>;

const escapeLabelValue = (value: string): string =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");

const formatLabels = (labels: MetricLabels): string => {
  const entries = Object.entries(labels).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  if (entries.length === 0) return "";

  return `{${entries
    .map(([name, value]) => `${name}="${escapeLabelValue(value)}"`)
    .join(",")}}`;
};

const seriesKey = (labels: MetricLabels): string =>
  Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}\u0000${value}`)
    .join("\u0001");

const formatNumber = (value: number): string => {
  if (!Number.isFinite(value)) {
    return value > 0 ? "+Inf" : Number.isNaN(value) ? "NaN" : "-Inf";
  }

  if (Number.isInteger(value)) return String(value);

  return String(Number(value.toFixed(9)));
};

type CounterSeries = {
  labels: MetricLabels;
  value: number;
};

class Counter {
  readonly name: string;
  readonly help: string;
  private readonly series = new Map<string, CounterSeries>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  increment(labels: MetricLabels = {}, amount = 1): void {
    const key = seriesKey(labels);
    const existing = this.series.get(key);

    if (existing) {
      existing.value += amount;
      return;
    }

    this.series.set(key, { labels, value: amount });
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];

    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${formatLabels(labels)} ${formatNumber(value)}`);
    }

    return lines;
  }
}

type HistogramSeries = {
  labels: MetricLabels;
  counts: number[];
  sum: number;
  count: number;
};

export const DEFAULT_LATENCY_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.3, 0.5, 1, 2.5, 5, 10,
] as const;

class Histogram {
  private readonly name: string;
  private readonly help: string;
  private readonly buckets: readonly number[];
  private readonly series = new Map<string, HistogramSeries>();

  constructor(name: string, help: string, buckets: readonly number[]) {
    this.name = name;
    this.help = help;
    this.buckets = buckets;
  }

  observe(valueSeconds: number, labels: MetricLabels = {}): void {
    const value =
      Number.isFinite(valueSeconds) && valueSeconds >= 0 ? valueSeconds : 0;
    const key = seriesKey(labels);
    let entry = this.series.get(key);

    if (!entry) {
      entry = {
        labels,
        counts: this.buckets.map(() => 0),
        sum: 0,
        count: 0,
      };
      this.series.set(key, entry);
    }

    for (let index = 0; index < this.buckets.length; index += 1) {
      if (value <= this.buckets[index]!) {
        entry.counts[index]! += 1;
      }
    }

    entry.sum += value;
    entry.count += 1;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];

    for (const { labels, counts, sum, count } of this.series.values()) {
      this.buckets.forEach((bucket, index) => {
        lines.push(
          `${this.name}_bucket${formatLabels({
            ...labels,
            le: String(bucket),
          })} ${counts[index]}`,
        );
      });

      lines.push(
        `${this.name}_bucket${formatLabels({ ...labels, le: "+Inf" })} ${count}`,
      );
      lines.push(`${this.name}_sum${formatLabels(labels)} ${formatNumber(sum)}`);
      lines.push(
        `${this.name}_count${formatLabels(labels)} ${formatNumber(count)}`,
      );
    }

    return lines;
  }
}

type GaugeSeries = {
  labels: MetricLabels;
  value: number;
};

class Gauge {
  readonly name: string;
  readonly help: string;
  private readonly series = new Map<string, GaugeSeries>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  set(value: number, labels: MetricLabels = {}): void {
    this.series.set(seriesKey(labels), { labels, value });
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];

    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${formatLabels(labels)} ${formatNumber(value)}`);
    }

    return lines;
  }
}

type GaugeCollector = {
  name: string;
  help: string;
  collect: () => number;
};

const gaugeCollectors = new Map<string, GaugeCollector>();

/**
 * Registers a gauge whose value is sampled at scrape time. Re-registering the
 * same name replaces the previous collector, so module reloads in tests do not
 * emit duplicate metric families.
 */
export const registerGaugeCollector = (
  name: string,
  help: string,
  collect: () => number,
): void => {
  gaugeCollectors.set(name, { name, help, collect });
};

export const httpRequestsTotal = new Counter(
  "wormhole_http_requests_total",
  "Total number of HTTP requests handled, labeled by method, route, and status.",
);

export const httpRequestDurationSeconds = new Histogram(
  "wormhole_http_request_duration_seconds",
  "HTTP request duration in seconds.",
  DEFAULT_LATENCY_BUCKETS,
);

export const databaseHealthChecksTotal = new Counter(
  "wormhole_database_health_checks_total",
  "Database health checks, labeled by result.",
);

let databaseUp = false;

registerGaugeCollector(
  "wormhole_database_up",
  "Whether the most recent database health check succeeded (1) or failed (0).",
  () => (databaseUp ? 1 : 0),
);

export const recordDatabaseCheck = (up: boolean): void => {
  databaseUp = up;
  databaseHealthChecksTotal.increment({ status: up ? "up" : "down" });
};

const buildInfoGauge = new Gauge(
  "wormhole_build_info",
  "Build information for the running service; always 1.",
);

buildInfoGauge.set(1, {
  version: buildInfo.version,
  commit: buildInfo.commit,
});

/**
 * Renders every registered metric in the Prometheus text exposition format.
 */
export const renderMetrics = (): string => {
  const lines: string[] = [
    ...httpRequestsTotal.render(),
    ...httpRequestDurationSeconds.render(),
    ...databaseHealthChecksTotal.render(),
    ...buildInfoGauge.render(),
  ];

  const collectors = [...gaugeCollectors.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const collector of collectors) {
    lines.push(
      `# HELP ${collector.name} ${collector.help}`,
      `# TYPE ${collector.name} gauge`,
      `${collector.name} ${formatNumber(collector.collect())}`,
    );
  }

  return `${lines.join("\n")}\n`;
};
