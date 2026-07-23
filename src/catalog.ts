export type Installer =
  | { type: "npm"; packages: string[]; bin: string }
  | { type: "dotnet"; package: string; bin: string }
  | { type: "go"; package: string; bin: string }
  | { type: "rustup"; component: string; bin: string };

export type ServerDefinition = {
  key: string;
  displayName: string;
  cmd: string;
  args: string[];
  languageId: string;
  markers: string[];
  extensions: string[];
  installer: Installer;
};

export const SERVERS: ServerDefinition[] = [
  { key: "typescript", displayName: "TypeScript / JavaScript", cmd: "typescript-language-server", args: ["--stdio"], languageId: "typescript", markers: ["tsconfig.json", "package.json", "jsconfig.json"], extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"], installer: { type: "npm", packages: ["typescript-language-server", "typescript"], bin: "typescript-language-server" } },
  { key: "python", displayName: "Python", cmd: "pyright-langserver", args: ["--stdio"], languageId: "python", markers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"], extensions: ["py", "pyi"], installer: { type: "npm", packages: ["pyright"], bin: "pyright-langserver" } },
  { key: "rust", displayName: "Rust", cmd: "rust-analyzer", args: [], languageId: "rust", markers: ["Cargo.toml"], extensions: ["rs"], installer: { type: "rustup", component: "rust-analyzer", bin: "rust-analyzer" } },
  { key: "go", displayName: "Go", cmd: "gopls", args: [], languageId: "go", markers: ["go.mod", "go.work"], extensions: ["go"], installer: { type: "go", package: "golang.org/x/tools/gopls@latest", bin: "gopls" } },
  { key: "csharp", displayName: "C# / .NET", cmd: "csharp-ls", args: [], languageId: "csharp", markers: ["*.sln", "*.slnx", "global.json", "Directory.Build.props", "Directory.Build.targets", "*.csproj"], extensions: ["cs"], installer: { type: "dotnet", package: "csharp-ls", bin: "csharp-ls" } },
  { key: "json", displayName: "JSON / JSONC", cmd: "vscode-json-languageserver", args: ["--stdio"], languageId: "json", markers: ["package.json", ".git"], extensions: ["json", "jsonc"], installer: { type: "npm", packages: ["vscode-langservers-extracted"], bin: "vscode-json-languageserver" } },
  { key: "yaml", displayName: "YAML", cmd: "yaml-language-server", args: ["--stdio"], languageId: "yaml", markers: [".git"], extensions: ["yaml", "yml"], installer: { type: "npm", packages: ["yaml-language-server"], bin: "yaml-language-server" } }
];

export const serverForExtension = (file: string) => {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return SERVERS.find((server) => server.extensions.includes(ext)) ?? null;
};
