import http from 'k6/http';
import { check, fail } from 'k6';

const baseUrl = __ENV.BASE_URL;
const customerToken = __ENV.CUSTOMER_TOKEN;
const benchmarkSecret = __ENV.BENCHMARK_SECRET;
const vus = Number(__ENV.VUS || '25');

if (!baseUrl || !customerToken || !benchmarkSecret) fail('BASE_URL, CUSTOMER_TOKEN, and BENCHMARK_SECRET are required.');

export const options = {
  vus,
  iterations: vus,
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<750'],
  },
};

export function setup() {
  const response = http.post(`${baseUrl}/internal/benchmark/reset`, null, { headers: { 'X-Benchmark-Secret': benchmarkSecret } });
  if (response.status !== 201) fail(`Could not reset benchmark event: ${response.status} ${response.body}`);
  return { eventId: response.json('data.eventId') };
}

export default function (data) {
  const response = http.post(`${baseUrl}/api/v1/events/${data.eventId}/bookings`, JSON.stringify({ quantity: 1 }), {
    headers: {
      Authorization: `Bearer ${customerToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `k6-${__VU}-${__ITER}-${Date.now()}`,
      'X-Benchmark-Secret': benchmarkSecret,
    },
  });
  check(response, {
    'booking accepted': (r) => r.status === 201,
    'no unexpected error body': (r) => r.status !== 500 && r.status !== 503,
  });
}
