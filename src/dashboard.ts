import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { getJobsForDashboard, addToWaitlist, countWaitlist } from "./db.js";

/**
 * A job that has been sent to someone but not acknowledged for this long is
 * flagged. This is the project's key metric made visible: the owner should be
 * able to see at a glance who hasn't responded.
 */
export const WAITING_AFTER_MS = 30 * 60 * 1000;   // 30 minutes

/** Read a request body, refusing anything oversized rather than buffering it. */
function readBody(req: import("node:http").IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Local network addresses, so the dashboard can be opened on a phone. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out;
}

export function startDashboard(port: number): void {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      // The page polls this. Everything it needs in one response.
      //
      // All of it, unaggregated: the page slices by date range and status in
      // the browser, so changing a filter is instant and needs no round trip.
      // Fine while a business has hundreds of jobs; move the counting into SQL
      // if it ever reaches tens of thousands.
      if (url.pathname === "/api/jobs") {
        const payload = {
          now: Date.now(),
          waitingAfterMs: WAITING_AFTER_MS,
          jobs: getJobsForDashboard(),
        };
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(payload));
        return;
      }

      // Early-access signups from the landing page.
      if (url.pathname === "/api/waitlist" && req.method === "POST") {
        const body = await readBody(req, 8 * 1024);
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(body);
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad json" }));
          return;
        }

        const str = (v: unknown) => {
          const s = typeof v === "string" ? v.trim() : "";
          return s ? s.slice(0, 500) : null;
        };
        const phone = str(data.phone);
        const email = str(data.email);

        // One way to reach them is the whole point of the form.
        if (!phone && !email) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "need a phone or an email" }));
          return;
        }

        const id = addToWaitlist({
          name: str(data.name),
          business: str(data.business),
          phone,
          email,
          teamSize: str(data.teamSize),
          note: str(data.note),
        });

        // Printed because a signup is the most interesting thing that can
        // happen while this is running.
        console.log(`\n  ★ EARLY ACCESS #${id} — ${str(data.name) ?? "someone"}` +
                    `${str(data.business) ? " of " + str(data.business) : ""}` +
                    ` · ${phone ?? email}` +
                    `${str(data.teamSize) ? " · " + str(data.teamSize) + " people" : ""}` +
                    `  (${countWaitlist()} total)\n`);

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // "/" is the landing page; the owner's dashboard moved to "/app".
      const page =
        url.pathname === "/" || url.pathname === "/index.html" ? "landing.html"
        : url.pathname === "/app" || url.pathname === "/app/" ? "index.html"
        : null;

      if (page) {
        const html = await readFile(path.join(process.cwd(), "public", page), "utf8");
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(html);
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    } catch (err: any) {
      console.log(`  ⚠ dashboard error: ${err?.message}`);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("Server error");
    }
  });

  // 0.0.0.0 so it's reachable from your phone on the same wifi, not just
  // from this machine.
  server.listen(port, "0.0.0.0", () => {
    console.log(`Landing:    http://localhost:${port}`);
    console.log(`Dashboard:  http://localhost:${port}/app`);
    for (const ip of lanAddresses()) {
      console.log(`            http://${ip}:${port}/app   (from your phone, same wifi)`);
    }
    console.log("");
  });

  server.on("error", (err: any) => {
    if (err?.code === "EADDRINUSE") {
      console.log(`  ⚠ port ${port} is already in use — is another copy running?`);
    } else {
      console.log(`  ⚠ dashboard could not start: ${err?.message}`);
    }
  });
}
