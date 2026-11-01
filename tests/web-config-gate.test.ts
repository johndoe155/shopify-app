/**
 * `shopify app dev` cannot start the app without a `shopify.web.toml`, and the
 * previous release shipped without one. A release gate that has never failed is
 * an assumption, so each case here breaks exactly one thing in a scratch copy of
 * the config and asserts `scripts/check-config.ts` exits non-zero and names it.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = join(__dirname, "..");
const script = join(projectRoot, "scripts/check-config.ts");
const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(mutate: (dir: string) => void): { code: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "web-config-gate-"));
  created.push(dir);
  mkdirSync(join(dir, "listing"), { recursive: true });
  for (const file of ["shopify.app.toml", "shopify.web.toml", ".env.example"]) {
    copyFileSync(join(projectRoot, file), join(dir, file));
  }
  // The gate also scans app/ for hard-coded placeholder values. Link the real one
  // rather than copying it: these cases are about the web config, and the source
  // scan is covered by tests/config.test.ts.
  symlinkSync(join(projectRoot, "app"), join(dir, "app"), "dir");
  // A linked app config, so the run isolates the web-config checks from the
  // "still a placeholder" failures that are expected until `config link` runs.
  // application_url ships as "https://example.com", which the gate treats as a
  // placeholder in its own right, so it has to be linked away too.
  const appToml = readFileSync(join(dir, "shopify.app.toml"), "utf8")
    .replace("REPLACE_WITH_CLIENT_ID", "abc123")
    .replace("https://example.com", "https://app.example.org")
    .replace(/https:\/\/REPLACE_WITH_HOST/g, "https://app.example.org");
  writeFileSync(join(dir, "shopify.app.toml"), appToml);
  mutate(dir);
  try {
    const output = execFileSync(join(projectRoot, "node_modules/.bin/tsx"), [script], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

describe("config gate covers shopify.web.toml", () => {
  it("passes on the real configuration", () => {
    const result = run(() => {});
    expect(result.output).toContain("no placeholders found");
    expect(result.code).toBe(0);
  });

  it("fails when shopify.web.toml is missing", () => {
    const result = run((dir) => rmSync(join(dir, "shopify.web.toml")));
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("shopify.web.toml is missing");
  });

  it("fails when the frontend role is missing", () => {
    const result = run((dir) => {
      writeFileSync(join(dir, "shopify.web.toml"), 'roles = ["backend"]\n\n[commands]\ndev = "npm run dev:server"\n');
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('"frontend"');
  });

  it("fails when the backend role is missing", () => {
    const result = run((dir) => {
      writeFileSync(join(dir, "shopify.web.toml"), 'roles = ["frontend"]\n\n[commands]\ndev = "npm run dev:server"\n');
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('"backend"');
  });

  it("fails when there is no dev command", () => {
    const result = run((dir) => {
      writeFileSync(join(dir, "shopify.web.toml"), 'roles = ["frontend", "backend"]\n');
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("[commands] dev is missing");
  });

  it("fails when webhooks_path disagrees with the app's webhook uri", () => {
    const result = run((dir) => {
      writeFileSync(
        join(dir, "shopify.web.toml"),
        'roles = ["frontend", "backend"]\nwebhooks_path = "/api/webhooks"\n\n[commands]\ndev = "npm run dev:server"\n',
      );
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("does not match");
  });
});
