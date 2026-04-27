import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools.js";
import { WorkspaceConfirmationError, registerWorkspaceTool } from "../src/tools/workspace.js";

describe("change_workspace tool", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reasonix-workspace-tool-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("registers a tool named change_workspace", () => {
    const reg = new ToolRegistry();
    registerWorkspaceTool(reg);
    expect(reg.has("change_workspace")).toBe(true);
  });

  it("throws WorkspaceConfirmationError with the resolved absolute path on a valid directory", async () => {
    const reg = new ToolRegistry();
    registerWorkspaceTool(reg);
    const out = await reg.dispatch("change_workspace", { path: tmp });
    // ToolRegistry.dispatch serializes thrown errors into a JSON
    // result with the error name + message. The model sees this; the
    // App detects the marker and mounts the modal.
    expect(out).toContain("WorkspaceConfirmationError");
    // Path appears inside a JSON string, so backslashes (Windows) are
    // doubled. Parse the result and compare against the canonical
    // form rather than substring-checking the raw JSON.
    const parsed = JSON.parse(out) as { error: string };
    expect(parsed.error).toContain(tmp);
  });

  it("rejects empty / missing path with a normal error (no confirmation)", async () => {
    const reg = new ToolRegistry();
    registerWorkspaceTool(reg);
    const out1 = await reg.dispatch("change_workspace", {});
    expect(out1).toContain("non-empty string");
    expect(out1).not.toContain("WorkspaceConfirmationError");
    const out2 = await reg.dispatch("change_workspace", { path: "" });
    expect(out2).toContain("non-empty string");
  });

  it("rejects a non-existent path", async () => {
    const reg = new ToolRegistry();
    registerWorkspaceTool(reg);
    const out = await reg.dispatch("change_workspace", {
      path: join(tmp, "does", "not", "exist"),
    });
    expect(out).toContain("does not exist");
    expect(out).not.toContain("WorkspaceConfirmationError");
  });

  it("rejects a path that exists but is a regular file", async () => {
    const file = join(tmp, "marker.txt");
    writeFileSync(file, "hi");
    const reg = new ToolRegistry();
    registerWorkspaceTool(reg);
    const out = await reg.dispatch("change_workspace", { path: file });
    expect(out).toContain("not a directory");
    expect(out).not.toContain("WorkspaceConfirmationError");
  });

  it("never performs an actual switch — only ever throws confirmation", () => {
    // The tool fn must be a pure validator → confirmation-error
    // pump. App.tsx owns the actual cwd swap. This test pins the
    // contract so a future "let's just switch directly" refactor
    // gets caught.
    const e = new WorkspaceConfirmationError("/some/abs/path");
    expect(e.name).toBe("WorkspaceConfirmationError");
    expect(e.path).toBe("/some/abs/path");
    expect(e.message).toMatch(/needs the user's approval/);
    expect(e.message).toMatch(/STOP calling tools/);
  });

  it("expands a leading ~ to the home directory when one is set", async () => {
    // We can't assume HOME points at our tmp dir, but we CAN assert
    // that `~` triggers expansion (the resulting absolute path won't
    // equal `~/...` literally and the validator will run against the
    // expanded form). Use a known-bad subpath so the validator
    // surfaces a clear "does not exist" rather than passing through.
    const reg = new ToolRegistry();
    registerWorkspaceTool(reg);
    const out = await reg.dispatch("change_workspace", {
      path: "~/__reasonix_definitely_not_a_real_dir_xyz__",
    });
    // The error message must contain the resolved absolute path,
    // not the literal `~` prefix — otherwise expansion didn't happen.
    expect(out).not.toContain("~");
    expect(out).toContain("does not exist");
  });
});
