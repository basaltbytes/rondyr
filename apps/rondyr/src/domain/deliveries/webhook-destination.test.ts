import { assert, it } from "@effect/vitest";
import { Option, Result } from "effect";

import { parseWebhookUrl, type DestinationRefusalReason } from "./webhook-destination.ts";

const workerOrigin = Option.some("https://rondyr.example.com");

function reasonFor(url: string) {
  return Result.match(parseWebhookUrl(url, workerOrigin), {
    onSuccess: () => "accepted",
    onFailure: (reason) => reason,
  });
}

it("refuses each class of unsafe destination", () => {
  const refused: ReadonlyArray<readonly [string, DestinationRefusalReason]> = [
    ["not a url", "invalid-url"],
    [`https://example.com/${"a".repeat(2048)}`, "invalid-url"],
    ["http://example.com/hook", "not-https"],
    ["ftp://example.com/hook", "not-https"],
    ["https://user:secret@example.com/hook", "credentials"],
    ["https://token@example.com/hook", "credentials"],
    ["https://example.com:8443/hook", "custom-port"],
    ["https://localhost/hook", "local-hostname"],
    ["https://LOCALHOST./hook", "local-hostname"],
    ["https://api.localhost/hook", "local-hostname"],
    ["https://printer.local/hook", "local-hostname"],
    ["https://service.internal/hook", "local-hostname"],
    ["https://nas.home.arpa/hook", "local-hostname"],
    ["https://intranet/hook", "local-hostname"],
    // IPv4: this network, private, CGNAT, loopback, link-local, protocol
    // assignments, documentation, 6to4 relay, benchmarking, multicast, reserved.
    ["https://0.0.0.0/", "reserved-address"],
    ["https://10.1.2.3/", "reserved-address"],
    ["https://100.64.0.1/", "reserved-address"],
    ["https://100.127.255.254/", "reserved-address"],
    ["https://127.0.0.1/", "reserved-address"],
    ["https://169.254.169.254/", "reserved-address"],
    ["https://172.16.0.1/", "reserved-address"],
    ["https://172.31.255.255/", "reserved-address"],
    ["https://192.0.0.8/", "reserved-address"],
    ["https://192.0.2.1/", "reserved-address"],
    ["https://192.88.99.1/", "reserved-address"],
    ["https://192.168.1.1/", "reserved-address"],
    ["https://198.18.0.1/", "reserved-address"],
    ["https://198.51.100.7/", "reserved-address"],
    ["https://203.0.113.9/", "reserved-address"],
    ["https://224.0.0.1/", "reserved-address"],
    ["https://255.255.255.255/", "reserved-address"],
    // The URL parser turns these spellings of 127.0.0.1 into the dotted form.
    ["https://2130706433/", "reserved-address"],
    ["https://0x7f.1/", "reserved-address"],
    ["https://127.1/", "reserved-address"],
    // IPv6: unspecified, loopback, IPv4-mapped, NAT64, unique local, link-local,
    // multicast, Teredo, documentation, 6to4.
    ["https://[::]/", "reserved-address"],
    ["https://[::1]/", "reserved-address"],
    ["https://[::ffff:127.0.0.1]/", "reserved-address"],
    ["https://[::ffff:8.8.8.8]/", "reserved-address"],
    ["https://[64:ff9b::a00:1]/", "reserved-address"],
    ["https://[fd00::1]/", "reserved-address"],
    ["https://[fe80::1]/", "reserved-address"],
    ["https://[ff02::1]/", "reserved-address"],
    ["https://[2001::1]/", "reserved-address"],
    ["https://[2001:db8::1]/", "reserved-address"],
    ["https://[2002:a00:1::1]/", "reserved-address"],
    ["https://[3fff::1]/", "reserved-address"],
    ["https://rondyr.example.com/hook", "worker-origin"],
    ["https://Rondyr.Example.com./api/hook", "worker-origin"],
  ];
  assert.deepEqual(
    refused.map(([url]) => [url, reasonFor(url)]),
    refused.map(([url, reason]) => [url, reason]),
  );
});

it("accepts public HTTPS destinations and normalizes them", () => {
  const accepted = [
    "https://hooks.example.com/rondyr?token=abc",
    "https://HOOKS.example.com:443/path",
    "https://8.8.8.8/hook",
    "https://100.128.0.1/hook",
    "https://172.32.0.1/hook",
    "https://[2606:4700:4700::1111]/hook",
    "https://other.example.com/hook",
  ];
  assert.deepEqual(
    accepted.map((url) => reasonFor(url)),
    accepted.map(() => "accepted"),
  );
  assert.deepEqual(
    Result.getOrThrow(parseWebhookUrl("https://HOOKS.example.com:443/path", workerOrigin)),
    "https://hooks.example.com/path",
  );
  // Without a configured origin, only the other rules apply.
  assert.isTrue(Result.isSuccess(parseWebhookUrl("https://rondyr.example.com/", Option.none())));
});
