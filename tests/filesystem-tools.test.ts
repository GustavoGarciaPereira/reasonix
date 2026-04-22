import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools.js";
import { registerFilesystemTools } from "../src/tools/filesystem.js";

describe("filesystem tools (built-in, sandbox-enforced)", () => {
  let root: string;
  let tools: ToolRegistry;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "reasonix-fs-"));
    tools = new ToolRegistry();
    registerFilesystemTools(tools, { rootDir: root });
    await fs.writeFile(join(root, "hello.txt"), "line 1\nline 2\nline 3\n");
    await fs.mkdir(join(root, "src"), { recursive: true });
    await fs.writeFile(join(root, "src", "index.ts"), "export const x = 1;\n");
    await fs.writeFile(join(root, "src", "util.ts"), "export const y = 2;\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("read_file", () => {
    it("reads the full contents", async () => {
      const out = await tools.dispatch("read_file", JSON.stringify({ path: "hello.txt" }));
      expect(out).toContain("line 1");
      expect(out).toContain("line 3");
    });

    it("honors head=N to return only the first N lines", async () => {
      const out = await tools.dispatch("read_file", JSON.stringify({ path: "hello.txt", head: 2 }));
      expect(out).toBe("line 1\nline 2");
    });

    it("honors tail=N", async () => {
      const out = await tools.dispatch("read_file", JSON.stringify({ path: "hello.txt", tail: 2 }));
      expect(out).toContain("line 2");
      expect(out).toContain("line 3");
      expect(out).not.toContain("line 1");
    });

    it("rejects paths outside the sandbox root", async () => {
      const out = await tools.dispatch(
        "read_file",
        JSON.stringify({ path: "../../../etc/passwd" }),
      );
      expect(out).toMatch(/escapes sandbox/);
    });

    it("rejects absolute paths outside root", async () => {
      const out = await tools.dispatch("read_file", JSON.stringify({ path: "/etc/passwd" }));
      expect(out).toMatch(/escapes sandbox/);
    });

    it("returns a truncation notice when file exceeds maxReadBytes", async () => {
      const tiny = new ToolRegistry();
      registerFilesystemTools(tiny, { rootDir: root, maxReadBytes: 10 });
      const out = await tiny.dispatch("read_file", JSON.stringify({ path: "hello.txt" }));
      expect(out).toMatch(/truncated/);
    });

    it("refuses to read a directory as a file", async () => {
      const out = await tools.dispatch("read_file", JSON.stringify({ path: "src" }));
      expect(out).toMatch(/not a file/);
    });
  });

  describe("list_directory / directory_tree", () => {
    it("list_directory shows entries with trailing slash for dirs", async () => {
      const out = await tools.dispatch("list_directory", JSON.stringify({ path: "." }));
      expect(out).toContain("hello.txt");
      expect(out).toContain("src/");
    });

    it("directory_tree recurses", async () => {
      const out = await tools.dispatch("directory_tree", JSON.stringify({ path: "." }));
      expect(out).toContain("hello.txt");
      expect(out).toContain("src/");
      expect(out).toContain("index.ts");
      expect(out).toContain("util.ts");
    });

    it("directory_tree respects maxDepth", async () => {
      const out = await tools.dispatch(
        "directory_tree",
        JSON.stringify({ path: ".", maxDepth: 0 }),
      );
      // With depth 0 we list the top level only — no descent into src/.
      expect(out).toContain("src/");
      expect(out).not.toContain("index.ts");
    });
  });

  describe("search_files", () => {
    it("finds matching filenames recursively", async () => {
      const out = await tools.dispatch("search_files", JSON.stringify({ pattern: "index" }));
      expect(out).toContain("index.ts");
    });

    it("is case-insensitive", async () => {
      const out = await tools.dispatch("search_files", JSON.stringify({ pattern: "HELLO" }));
      expect(out).toContain("hello.txt");
    });

    it("reports no-matches cleanly", async () => {
      const out = await tools.dispatch("search_files", JSON.stringify({ pattern: "nothing123" }));
      expect(out).toBe("(no matches)");
    });
  });

  describe("get_file_info", () => {
    it("returns type + size + mtime as JSON", async () => {
      const out = await tools.dispatch("get_file_info", JSON.stringify({ path: "hello.txt" }));
      const parsed = JSON.parse(out);
      expect(parsed.type).toBe("file");
      expect(parsed.size).toBeGreaterThan(0);
      expect(parsed.mtime).toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it("reports directories", async () => {
      const out = await tools.dispatch("get_file_info", JSON.stringify({ path: "src" }));
      expect(JSON.parse(out).type).toBe("directory");
    });
  });

  describe("write_file", () => {
    it("creates a new file with contents", async () => {
      const out = await tools.dispatch(
        "write_file",
        JSON.stringify({ path: "new.md", content: "hi" }),
      );
      expect(out).toMatch(/wrote 2 chars/);
      const disk = await fs.readFile(join(root, "new.md"), "utf8");
      expect(disk).toBe("hi");
    });

    it("creates parent directories as needed", async () => {
      await tools.dispatch("write_file", JSON.stringify({ path: "a/b/c/deep.txt", content: "x" }));
      const disk = await fs.readFile(join(root, "a", "b", "c", "deep.txt"), "utf8");
      expect(disk).toBe("x");
    });

    it("rejects writes outside the sandbox", async () => {
      const out = await tools.dispatch(
        "write_file",
        JSON.stringify({ path: "../escape.txt", content: "bad" }),
      );
      expect(out).toMatch(/escapes sandbox/);
    });
  });

  describe("edit_file (flat SEARCH/REPLACE — the anti-DSML shape)", () => {
    it("replaces a unique search string", async () => {
      await fs.writeFile(join(root, "a.txt"), "foo bar baz");
      const out = await tools.dispatch(
        "edit_file",
        JSON.stringify({ path: "a.txt", search: "bar", replace: "QUX" }),
      );
      expect(out).toMatch(/edited/);
      const disk = await fs.readFile(join(root, "a.txt"), "utf8");
      expect(disk).toBe("foo QUX baz");
    });

    it("refuses when the search text is not found", async () => {
      await fs.writeFile(join(root, "a.txt"), "foo bar");
      const out = await tools.dispatch(
        "edit_file",
        JSON.stringify({ path: "a.txt", search: "baz", replace: "x" }),
      );
      expect(out).toMatch(/not found/);
    });

    it("refuses when the search text appears multiple times", async () => {
      await fs.writeFile(join(root, "a.txt"), "cat cat cat");
      const out = await tools.dispatch(
        "edit_file",
        JSON.stringify({ path: "a.txt", search: "cat", replace: "dog" }),
      );
      expect(out).toMatch(/multiple times/);
      // File unchanged.
      const disk = await fs.readFile(join(root, "a.txt"), "utf8");
      expect(disk).toBe("cat cat cat");
    });

    it("refuses an empty search", async () => {
      await fs.writeFile(join(root, "a.txt"), "x");
      const out = await tools.dispatch(
        "edit_file",
        JSON.stringify({ path: "a.txt", search: "", replace: "y" }),
      );
      expect(out).toMatch(/search cannot be empty/);
    });
  });

  describe("create_directory + move_file", () => {
    it("create_directory is idempotent (mkdir -p)", async () => {
      const a = await tools.dispatch("create_directory", JSON.stringify({ path: "d/e/f" }));
      expect(a).toMatch(/created/);
      const b = await tools.dispatch("create_directory", JSON.stringify({ path: "d/e/f" }));
      expect(b).toMatch(/created/);
      const st = await fs.stat(join(root, "d", "e", "f"));
      expect(st.isDirectory()).toBe(true);
    });

    it("move_file renames", async () => {
      const out = await tools.dispatch(
        "move_file",
        JSON.stringify({ source: "hello.txt", destination: "bye.txt" }),
      );
      expect(out).toMatch(/moved/);
      const disk = await fs.readFile(join(root, "bye.txt"), "utf8");
      expect(disk).toContain("line 1");
      await expect(fs.stat(join(root, "hello.txt"))).rejects.toThrow();
    });

    it("move_file into a new subdir creates the parent", async () => {
      await tools.dispatch(
        "move_file",
        JSON.stringify({ source: "hello.txt", destination: "archive/old.txt" }),
      );
      const disk = await fs.readFile(join(root, "archive", "old.txt"), "utf8");
      expect(disk).toContain("line 1");
    });
  });

  describe("allowWriting=false (read-only mode)", () => {
    it("skips registering write_file / edit_file / create_directory / move_file", async () => {
      const ro = new ToolRegistry();
      registerFilesystemTools(ro, { rootDir: root, allowWriting: false });
      expect(ro.has("read_file")).toBe(true);
      expect(ro.has("list_directory")).toBe(true);
      expect(ro.has("write_file")).toBe(false);
      expect(ro.has("edit_file")).toBe(false);
      expect(ro.has("create_directory")).toBe(false);
      expect(ro.has("move_file")).toBe(false);
    });
  });
});
