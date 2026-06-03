/**
 * Minimal Kubernetes leader election via a `coordination.k8s.io/v1` Lease.
 *
 * Only the lease holder runs the active workload (connects to Discord and
 * processes messages); other replicas wait. This guarantees exactly-once
 * processing regardless of replica count / rollout strategy — without any
 * external dependency. Uses the in-cluster ServiceAccount token over `fetch`.
 *
 * @module core/leader-election
 */

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

export interface LeaderElectionOptions {
  leaseName: string;
  namespace: string;
  /** Unique per pod — POD_NAME (downward API) or HOSTNAME. */
  identity: string;
  leaseDurationSeconds?: number;
  retryIntervalMs?: number;
}

interface Lease {
  metadata: { name: string; namespace: string; resourceVersion?: string };
  spec: {
    holderIdentity?: string;
    leaseDurationSeconds?: number;
    acquireTime?: string;
    renewTime?: string;
    leaseTransitions?: number;
  };
}

/** metav1.MicroTime — RFC3339 with microsecond precision. */
function microTime(d = new Date()): string {
  return d.toISOString().replace("Z", "000Z");
}

class LeaseClient {
  private base: string;
  private headers: Record<string, string>;
  // deno-lint-ignore no-explicit-any
  private httpClient: any;

  constructor(token: string, caCert: string) {
    const host = Deno.env.get("KUBERNETES_SERVICE_HOST");
    const port = Deno.env.get("KUBERNETES_SERVICE_PORT_HTTPS") ??
      Deno.env.get("KUBERNETES_SERVICE_PORT") ?? "443";
    this.base = `https://${host}:${port}`;
    this.headers = {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    };
    // Trust the cluster CA rather than disabling verification.
    this.httpClient = Deno.createHttpClient({ caCerts: [caCert] });
  }

  private url(ns: string, name?: string): string {
    const path = `/apis/coordination.k8s.io/v1/namespaces/${ns}/leases`;
    return this.base + (name ? `${path}/${name}` : path);
  }

  async get(ns: string, name: string): Promise<Lease | null> {
    const res = await fetch(this.url(ns, name), {
      method: "GET",
      headers: this.headers,
      client: this.httpClient,
    });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) throw new Error(`GET lease ${res.status}: ${await res.text()}`);
    return await res.json() as Lease;
  }

  /** Returns true on success, false on conflict (409), throws otherwise. */
  async create(ns: string, lease: Lease): Promise<boolean> {
    const res = await fetch(this.url(ns), {
      method: "POST",
      headers: this.headers,
      client: this.httpClient,
      body: JSON.stringify({ apiVersion: "coordination.k8s.io/v1", kind: "Lease", ...lease }),
    });
    if (res.ok) { await res.body?.cancel(); return true; }
    if (res.status === 409) { await res.body?.cancel(); return false; }
    throw new Error(`CREATE lease ${res.status}: ${await res.text()}`);
  }

  /** Returns true on success, false on conflict (409), throws otherwise. */
  async update(ns: string, lease: Lease): Promise<boolean> {
    const res = await fetch(this.url(ns, lease.metadata.name), {
      method: "PUT",
      headers: this.headers,
      client: this.httpClient,
      body: JSON.stringify({ apiVersion: "coordination.k8s.io/v1", kind: "Lease", ...lease }),
    });
    if (res.ok) { await res.body?.cancel(); return true; }
    if (res.status === 409) { await res.body?.cancel(); return false; }
    throw new Error(`PUT lease ${res.status}: ${await res.text()}`);
  }
}

function isExpired(lease: Lease, durationSeconds: number): boolean {
  if (!lease.spec.renewTime) return true;
  const renew = Date.parse(lease.spec.renewTime);
  return Number.isNaN(renew) || (Date.now() - renew) > durationSeconds * 1000;
}

/**
 * Block until this instance holds the lease, then keep renewing it. When
 * leadership is subsequently lost, `onLost` is invoked (typically to exit so a
 * single Discord connection is ever held).
 */
export async function runLeaderElection(
  opts: LeaderElectionOptions,
  onLost: () => void,
): Promise<void> {
  const { leaseName, namespace, identity } = opts;
  const duration = opts.leaseDurationSeconds ?? 15;
  const retryMs = opts.retryIntervalMs ?? 2000;

  const token = (await Deno.readTextFile(`${SA_DIR}/token`)).trim();
  const caCert = await Deno.readTextFile(`${SA_DIR}/ca.crt`);
  const client = new LeaseClient(token, caCert);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ── Acquire ────────────────────────────────────────────────────────────────
  let waiting = false;
  for (;;) {
    try {
      const current = await client.get(namespace, leaseName);
      const now = microTime();

      if (!current) {
        const ok = await client.create(namespace, {
          metadata: { name: leaseName, namespace },
          spec: {
            holderIdentity: identity,
            leaseDurationSeconds: duration,
            acquireTime: now,
            renewTime: now,
            leaseTransitions: 0,
          },
        });
        if (ok) break;
      } else if (current.spec.holderIdentity === identity || isExpired(current, duration)) {
        const heldBySelf = current.spec.holderIdentity === identity;
        const ok = await client.update(namespace, {
          metadata: { name: leaseName, namespace, resourceVersion: current.metadata.resourceVersion },
          spec: {
            holderIdentity: identity,
            leaseDurationSeconds: duration,
            acquireTime: heldBySelf ? current.spec.acquireTime : now,
            renewTime: now,
            leaseTransitions: (current.spec.leaseTransitions ?? 0) + (heldBySelf ? 0 : 1),
          },
        });
        if (ok) break;
      } else if (!waiting) {
        console.log(`[Leader] Standing by — lease held by ${current.spec.holderIdentity}`);
        waiting = true;
      }
    } catch (err) {
      console.error("[Leader] Acquire error (will retry):", err instanceof Error ? err.message : err);
    }
    await sleep(retryMs);
  }
  console.log(`[Leader] Acquired leadership as ${identity}`);

  // ── Renew ────────────────────────────────────────────────────────────────
  let lost = false;
  const renewMs = Math.max(1000, Math.floor((duration * 1000) / 3));
  const timer = setInterval(async () => {
    if (lost) return;
    try {
      const current = await client.get(namespace, leaseName);
      if (!current || current.spec.holderIdentity !== identity) {
        lost = true;
        clearInterval(timer);
        console.error("[Leader] Lost leadership — another holder took the lease");
        onLost();
        return;
      }
      await client.update(namespace, {
        metadata: { name: leaseName, namespace, resourceVersion: current.metadata.resourceVersion },
        spec: { ...current.spec, holderIdentity: identity, renewTime: microTime() },
      });
    } catch (err) {
      // Transient — keep trying; if we truly can't renew, the lease expires and
      // a standby takes over, which the next GET will detect as lost.
      console.error("[Leader] Renew error:", err instanceof Error ? err.message : err);
    }
  }, renewMs);
}
