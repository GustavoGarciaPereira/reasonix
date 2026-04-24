/**
 * Precedence test for `resolveDefaults` — the glue between CLI flags
 * and `~/.reasonix/config.json`. Bugs here would look like "my config
 * doesn't do anything" or "--model was ignored"; both would be
 * invisible to the rest of the test suite, which is why this one exists.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDefaults } from "../src/cli/resolve.js";
import { writeConfig } from "../src/config.js";

// resolve.ts reads the real ~/.reasonix/config.json via readConfig().
// Redirect HOME to a temp dir for each test so we never touch the
// user's real config and we start each case with a clean slate.
describe("resolveDefaults", () => {
  let home: string;
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-resolve-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home; // node:os homedir() uses this on Windows
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (origHome === undefined) {
      // biome-ignore lint/performance/noDelete: process.env must lose the key, not hold "undefined"
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
    if (origUserProfile === undefined) {
      // biome-ignore lint/performance/noDelete: same reason as HOME
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = origUserProfile;
    }
  });

  it("empty flags + empty config → hard-coded fast preset", () => {
    const r = resolveDefaults({});
    expect(r.model).toBe("deepseek-chat");
    expect(r.harvest).toBe(false);
    expect(r.branch).toBeUndefined();
    expect(r.mcp).toEqual([]);
    expect(r.session).toBe("default");
  });

  it("config.preset 'smart' flips harvest on and switches model", () => {
    writeConfig({ preset: "smart" }, join(home, ".reasonix", "config.json"));
    const r = resolveDefaults({});
    expect(r.model).toBe("deepseek-reasoner");
    expect(r.harvest).toBe(true);
    expect(r.branch).toBeUndefined();
  });

  it("--preset max overrides config.preset=fast", () => {
    writeConfig({ preset: "fast" }, join(home, ".reasonix", "config.json"));
    const r = resolveDefaults({ preset: "max" });
    expect(r.model).toBe("deepseek-v4-pro");
    expect(r.branch).toBe(3);
  });

  it("--model wins even when --preset is set", () => {
    const r = resolveDefaults({ preset: "max", model: "deepseek-chat" });
    expect(r.model).toBe("deepseek-chat");
    // preset still controls harvest/branch
    expect(r.harvest).toBe(true);
    expect(r.branch).toBe(3);
  });

  it("--mcp overrides config.mcp wholesale (no merging)", () => {
    writeConfig(
      { mcp: ["fs=npx -y @modelcontextprotocol/server-filesystem /tmp/old"] },
      join(home, ".reasonix", "config.json"),
    );
    const r = resolveDefaults({ mcp: ["new=cmd arg"] });
    expect(r.mcp).toEqual(["new=cmd arg"]);
  });

  it("empty --mcp array falls through to config.mcp", () => {
    writeConfig(
      { mcp: ["fs=npx -y @modelcontextprotocol/server-filesystem /tmp/safe"] },
      join(home, ".reasonix", "config.json"),
    );
    const r = resolveDefaults({ mcp: [] });
    expect(r.mcp).toHaveLength(1);
    expect(r.mcp[0]).toContain("filesystem");
  });

  it("--no-config ignores the config entirely", () => {
    writeConfig({ preset: "max", mcp: ["x=cmd"] }, join(home, ".reasonix", "config.json"));
    const r = resolveDefaults({ noConfig: true });
    expect(r.model).toBe("deepseek-chat"); // fast defaults
    expect(r.mcp).toEqual([]);
  });

  it("--no-session beats config.session", () => {
    writeConfig({ session: "work" }, join(home, ".reasonix", "config.json"));
    const r = resolveDefaults({ session: false });
    expect(r.session).toBeUndefined();
  });

  it("config.session=null means ephemeral by default", () => {
    writeConfig({ session: null }, join(home, ".reasonix", "config.json"));
    const r = resolveDefaults({});
    expect(r.session).toBeUndefined();
  });

  it("--branch 5 wins; --branch 1 means 'off'", () => {
    expect(resolveDefaults({ branch: 5 }).branch).toBe(5);
    expect(resolveDefaults({ branch: 1 }).branch).toBeUndefined();
  });

  it("--branch 99 caps at 8", () => {
    expect(resolveDefaults({ branch: 99 }).branch).toBe(8);
  });
});
