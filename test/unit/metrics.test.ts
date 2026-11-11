import assert from "node:assert/strict";
import test from "node:test";
import {
  databaseHealthChecksTotal,
  httpRequestDurationSeconds,
  httpRequestsTotal,
  recordDatabaseCheck,
  registerGaugeCollector,
  renderMetrics,
} from "../../src/observability/metrics.ts";

const metricLine = (text: string, name: string): string | undefined =>
  text
    .split("\n")
    .find((line) => line.startsWith(`${name}{`) || line.startsWith(`${name} `));

const metricValue = (text: string, name: string, labels = ""): number => {
  const prefix = `${name}${labels} `;
  const line = text.split("\n").find((candidate) => candidate.startsWith(prefix));

  assert.ok(line, `missing metric ${prefix}\n${text}`);

  return Number(line.slice(prefix.length));
};

const metricValueOrZero = (text: string, name: string, labels = ""): number => {
  const prefix = `${name}${labels} `;
  const line = text.split("\n").find((candidate) => candidate.startsWith(prefix));

  return line ? Number(line.slice(prefix.length)) : 0;
};

test("counters accumulate by label set and escape label values", () => {
  httpRequestsTotal.increment({
    method: "GET",
    route: "/unit/counter",
    status: "200",
  });
  httpRequestsTotal.increment({
    method: "GET",
    route: "/unit/counter",
    status: "200",
  });
  httpRequestsTotal.increment({
    method: 'GET"x',
    route: "/unit/counter\nnext",
    status: "500",
  });

  const text = renderMetrics();

  assert.equal(
    metricValue(
      text,
      "wormhole_http_requests_total",
      '{method="GET",route="/unit/counter",status="200"}',
    ),
    2,
  );
  assert.match(text, /# TYPE wormhole_http_requests_total counter/);
  assert.ok(
    text.includes(
      'wormhole_http_requests_total{method="GET\\"x",route="/unit/counter\\nnext",status="500"} 1',
    ),
    text,
  );
});

test("histograms expose cumulative buckets, sum, and count", () => {
  const labels = '{method="GET",route="/unit/histogram"}';

  const bucket = (le: string) =>
    `{le="${le}",method="GET",route="/unit/histogram"}`;

  httpRequestDurationSeconds.observe(0.003, {
    method: "GET",
    route: "/unit/histogram",
  });
  httpRequestDurationSeconds.observe(0.2, {
    method: "GET",
    route: "/unit/histogram",
  });
  httpRequestDurationSeconds.observe(2, {
    method: "GET",
    route: "/unit/histogram",
  });

  const text = renderMetrics();

  assert.equal(
    metricValue(
      text,
      "wormhole_http_request_duration_seconds_bucket",
      bucket("0.005"),
    ),
    1,
  );
  assert.equal(
    metricValue(
      text,
      "wormhole_http_request_duration_seconds_bucket",
      bucket("0.25"),
    ),
    2,
  );
  assert.equal(
    metricValue(
      text,
      "wormhole_http_request_duration_seconds_bucket",
      bucket("+Inf"),
    ),
    3,
  );
  assert.equal(
    metricValue(text, "wormhole_http_request_duration_seconds_count", labels),
    3,
  );
  assert.equal(
    metricValue(text, "wormhole_http_request_duration_seconds_sum", labels),
    2.203,
  );
});

test("database availability is a gauge and each check is counted", () => {
  const before = renderMetrics();
  const beforeValue = metricValue(before, "wormhole_database_up");
  const downsBefore = metricValueOrZero(
    before,
    "wormhole_database_health_checks_total",
    '{status="down"}',
  );
  const upsBefore = metricValueOrZero(
    before,
    "wormhole_database_health_checks_total",
    '{status="up"}',
  );

  recordDatabaseCheck(false);
  let text = renderMetrics();
  assert.equal(metricValue(text, "wormhole_database_up"), 0);
  assert.equal(
    metricValue(
      text,
      "wormhole_database_health_checks_total",
      '{status="down"}',
    ),
    downsBefore + 1,
  );

  recordDatabaseCheck(true);
  text = renderMetrics();
  assert.equal(metricValue(text, "wormhole_database_up"), 1);
  assert.equal(
    metricValue(text, "wormhole_database_health_checks_total", '{status="up"}'),
    upsBefore + 1,
  );

  assert.ok(Number.isInteger(beforeValue));
});

test("scrape-time gauge collectors are sampled on every render", () => {
  let value = 0;

  registerGaugeCollector(
    "wormhole_unit_scrape_gauge",
    "A gauge collected at scrape time.",
    () => value,
  );

  assert.ok(
    renderMetrics().includes("wormhole_unit_scrape_gauge 0"),
  );

  value = 42;

  assert.ok(
    renderMetrics().includes("wormhole_unit_scrape_gauge 42"),
  );

  // Re-registering replaces rather than duplicates.
  registerGaugeCollector(
    "wormhole_unit_scrape_gauge",
    "A gauge collected at scrape time.",
    () => 7,
  );

  const text = renderMetrics();
  assert.ok(text.includes("wormhole_unit_scrape_gauge 7"));
  assert.equal(
    text.split("\n").filter((line) => line.startsWith("# HELP wormhole_unit_scrape_gauge")).length,
    1,
  );
});

test("renders build information and Prometheus end-of-exposition newline", () => {
  const text = renderMetrics();

  assert.match(text, /wormhole_build_info\{commit="[^"]*",version="[^"]*"\} 1/);
  assert.ok(text.endsWith("\n"));
});

test("databaseHealthChecksTotal is exported for direct assertions", () => {
  assert.equal(databaseHealthChecksTotal.name, "wormhole_database_health_checks_total");
  assert.ok(metricLine(renderMetrics(), "wormhole_database_health_checks_total"));
});
