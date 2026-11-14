import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import qrcode from "qrcode-terminal";

/**
 * How the owner connects his WhatsApp the first time.
 *
 * Two paths, and everything after them is identical — both end up writing the
 * same credentials into ./auth, and nothing downstream knows or cares which
 * was used.
 *
 *   qr    — scan a code. Needs a second screen, so it's a desktop thing.
 *   code  — type an 8-digit code into WhatsApp. Works with only a phone,
 *           which is how real customers will onboard.
 */
export interface LinkChoice {
  method: "qr" | "code";
  /** Digits only, country code first. Null for QR. */
  number: string | null;
}

/** Digits only, country code first. Returns null if it doesn't look like a number. */
export function normaliseNumber(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

/**
 * Decide how to link. Environment variables win, so a server with no keyboard
 * can be told what to do:
 *
 *   PARCHI_LINK=qr
 *   PARCHI_LINK=code  PARCHI_NUMBER=919876543210
 *
 * Otherwise ask, if there's someone there to answer.
 */
export async function chooseLinkMethod(): Promise<LinkChoice> {
  const envMethod = (process.env.PARCHI_LINK ?? "").trim().toLowerCase();
  const envNumber = process.env.PARCHI_NUMBER ?? "";

  if (envMethod === "code") {
    const number = normaliseNumber(envNumber);
    if (!number) {
      console.log("\nPARCHI_LINK=code also needs PARCHI_NUMBER, e.g.");
      console.log("  PARCHI_NUMBER=919876543210\n");
      process.exit(1);
    }
    return { method: "code", number };
  }

  if (envMethod === "qr") return { method: "qr", number: null };

  // Asking needs someone at a keyboard. Under pm2 or systemd there isn't one,
  // and a prompt would hang forever, so fall back to QR and say why.
  if (!stdin.isTTY) {
    console.log("\nNot linked, and no terminal to ask at — showing a QR code.");
    console.log("To link by number instead, set PARCHI_LINK=code and PARCHI_NUMBER.\n");
    return { method: "qr", number: null };
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    console.log("\n  This WhatsApp number isn't linked yet.\n");
    console.log("    1   Scan a QR code        (needs a second screen)");
    console.log("    2   Type an 8-digit code  (phone only)\n");

    let method: "qr" | "code";
    for (;;) {
      const answer = (await rl.question("  Choose 1 or 2: ")).trim();
      if (answer === "1") { method = "qr"; break; }
      if (answer === "2") { method = "code"; break; }
      console.log("  Type 1 or 2.");
    }

    if (method === "qr") return { method, number: null };

    for (;;) {
      const raw = await rl.question("  WhatsApp number, country code first (e.g. 919876543210): ");
      const number = normaliseNumber(raw);
      if (number) return { method: "code", number };
      console.log("  Doesn't look right — digits only, country code first.");
    }
  } finally {
    rl.close();
  }
}

export function showQr(qr: string): void {
  console.log("\n  Scan this with your phone:");
  console.log("  WhatsApp → Settings → Linked Devices → Link a Device\n");
  qrcode.generate(qr, { small: true });
}

export function showPairingCode(code: string): void {
  const spaced = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
  console.log("\n  ┌──────────────────────────────┐");
  console.log(`  │   PAIRING CODE:  ${spaced.padEnd(10)}  │`);
  console.log("  └──────────────────────────────┘\n");
  console.log("  On the phone with that number:");
  console.log("    WhatsApp → Settings → Linked Devices → Link a Device");
  console.log("    → 'Link with phone number instead' → type the code\n");
  console.log("  It expires in about a minute. A fresh one prints automatically.\n");
}
