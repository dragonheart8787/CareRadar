// 最小化的 Node 型別宣告：repo 沒有（也不新增）@types/node，
// 這裡只宣告 sim/ 實際用到的幾個 API，讓 sim/ 能獨立通過 tsc --strict。
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
}
declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: string[],
    opts?: { encoding?: "utf8"; cwd?: string }
  ): string;
}
declare module "node:path" {
  export function resolve(...parts: string[]): string;
  export function dirname(p: string): string;
}
declare module "node:url" {
  export function fileURLToPath(url: string): string;
}
declare const process: {
  argv: string[];
  version: string;
  exitCode: number | undefined;
  stdout: { write(s: string): boolean };
};
interface ImportMeta {
  url: string;
}
