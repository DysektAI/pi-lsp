import { describe, expect, it } from "vitest";
import { SERVERS, serverForExtension } from "../src/catalog.js";
import { selectResolvedCommand } from "../src/index.js";
import { resolvePrerequisite, windowsNpmInvocation } from "../src/installer.js";

describe("server catalog", () => {
  it("ships first-class C#/.NET support", () => {
    expect(serverForExtension("src/App/Service.cs")).toMatchObject({
      key: "csharp",
      cmd: "csharp-ls",
      installer: { type: "dotnet", package: "csharp-ls" },
    });
  });

  it("routes the initial five language families", () => {
    expect(SERVERS.map((server) => server.key)).toEqual(["typescript", "python", "rust", "go", "csharp", "json", "yaml"]);
    expect(serverForExtension("app.tsx")?.key).toBe("typescript");
    expect(serverForExtension("app.py")?.key).toBe("python");
    expect(serverForExtension("main.rs")?.key).toBe("rust");
    expect(serverForExtension("main.go")?.key).toBe("go");
    expect(serverForExtension("settings.jsonc")?.key).toBe("json");
    expect(serverForExtension("workflow.yml")?.key).toBe("yaml");
  });

  it("selects Windows-native shims", () => {
    const output = "C:\\npm\\pyright-langserver\r\nC:\\npm\\pyright-langserver.cmd\r\n";
    expect(selectResolvedCommand(output, true)).toBe("C:\\npm\\pyright-langserver.cmd");
  });

  it("resolves native prerequisites without a shell", () => {
    const executable = resolvePrerequisite("node");
    expect(executable).toBeTruthy();
    expect(executable!.toLowerCase()).toContain("node");
  });

  it("launches npm's JavaScript CLI through Node on Windows without shell quoting", () => {
    expect(windowsNpmInvocation(
      ["install", "--prefix", "C:\\Users\\A User\\lsp", "typescript"],
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    )).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
        "install", "--prefix", "C:\\Users\\A User\\lsp", "typescript",
      ],
    });
  });
});
