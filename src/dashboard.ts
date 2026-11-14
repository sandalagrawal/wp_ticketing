import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { getJobsForDashboard } from "./db.js";

/**
 * A job that has been sent to someone but not acknowledged for this long is
 * flagged. This is the project's key metric made visible: the owner should be
 * able to see at a glance who hasn't responded.
 */
export const WAITING_AFTER_MS = 30 * 60 * 1000;   // 30 minutes

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

      if (url.pathname === "/" || url.pathname === "/index.html") {
        const html = await readFile(
          path.join(process.cwd(), "public", "index.html"),
          "utf8",
        );
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
    console.log(`Dashboard:  http://localhost:${port}`);
    for (const ip of lanAddresses()) {
      console.log(`            http://${ip}:${port}   (from your phone, same wifi)`);
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
