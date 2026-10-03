import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Analysis } from "./analysis";
import { runChecks } from "./checks";
import { POLICIES } from "./engine";
import { METRICS, SCENARIOS, runExperiment } from "./experiment";
import { buildCsvs, buildResultsMd, svgPairedVsLatest, svgS1Primary, type Meta } from "./report";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const log = (s: string) => process.stdout.write(s + "\n");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8", cwd: ROOT }).trim();
  } catch {
    return "";
  }
}

/** 預註冊文件的 commit SHA（新增該檔案的那個 commit）與原文完整性檢查。 */
function preregInfo(): Pick<Meta, "preregSha" | "preregIntegrity" | "deviations"> {
  const file = "sim/PREREGISTRATION.md";
  const sha = git(["log", "--diff-filter=A", "--format=%H", "--", file]).split("\n").filter(Boolean).pop() ?? "";
  const current = readFileSync(resolve(ROOT, file), "utf8");
  const marker = "\n## Deviations";
  const at = current.indexOf(marker);
  const deviations = at >= 0 ? current.slice(at + 1) : "";
  if (!sha) return { preregSha: "(找不到 git 紀錄)", preregIntegrity: "無法驗證（沒有 git 紀錄）", deviations };
  const committed = git(["show", `${sha}:${file}`]);
  // git() 會 trim 結尾換行，所以只比對「不含結尾空白」的部分。
  const intact = current.startsWith(committed);
  return {
    preregSha: sha,
    preregIntegrity: intact
      ? "目前的檔案以 commit 時的原文開頭（Deviations 之前的原文未被修改）"
      : "**警告：目前的檔案與 commit 時的原文不一致**",
    deviations,
  };
}

function main(): void {
  const t0 = Date.now();
  const mode = process.argv[2] === "check" ? "check" : "run";
  const R = Number(arg("--reps") ?? 300);
  const outDir = arg("--out") ? resolve(arg("--out") as string) : resolve(ROOT, "sim", "results");
  const mdPath = arg("--out") ? resolve(outDir, "RESULTS.md") : resolve(ROOT, "sim", "RESULTS.md");

  // ---- 階段 2：驗證。全過才能跑正式實驗。 ----
  log("== 驗證檢查 ==");
  const checks = runChecks();
  for (const c of checks) log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  [${c.detail}]` : ""}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    log(`\n${failed.length} 項檢查失敗，不執行正式實驗。`);
    process.exitCode = 1;
    return;
  }
  log(`${checks.length}/${checks.length} 項檢查通過。\n`);
  if (mode === "check") return;

  // ---- 階段 3：正式實驗 ----
  log(`== 正式實驗：${SCENARIOS.length} 情境 × ${POLICIES.length} 政策 × ${R} 次重複 ==`);
  const results = runExperiment(SCENARIOS, R, (id, ms) => log(`  ${id} 完成（${(ms / 1000).toFixed(1)} 秒）`));
  log("== bootstrap 與輸出 ==");
  const a = new Analysis(results, R);
  const csvs = buildCsvs(a);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "summary.csv"), csvs.summary);
  writeFileSync(resolve(outDir, "paired_diffs.csv"), csvs.paired);
  writeFileSync(resolve(outDir, "h6_decomposition.csv"), csvs.h6);
  writeFileSync(resolve(outDir, "s1_primary_metric.svg"), svgS1Primary(a));
  writeFileSync(resolve(outDir, "paired_diff_vs_latest.svg"), svgPairedVsLatest(a));

  const meta: Meta = {
    ...preregInfo(),
    baseHead: git(["rev-parse", "HEAD"]),
    R,
    runtimeSeconds: (Date.now() - t0) / 1000,
    nodeVersion: process.version,
  };
  writeFileSync(mdPath, buildResultsMd(a, meta));

  // ---- 終端機摘要 ----
  const pm = "median_wait_vulnerable" as const;
  log("\nS1 弱勢家戶等待時間中位數（小時，平均 [95% CI]）：");
  for (const p of POLICIES) {
    const v = a.summary("S1", p.name, pm);
    log(`  ${p.name.padEnd(28)} ${v.mean.toFixed(2).padStart(7)} [${v.lo.toFixed(2)}, ${v.hi.toFixed(2)}]`);
  }
  log(`\n指標數 ${METRICS.length}；輸出：${outDir}、${mdPath}`);
  log(`總執行時間 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
}

main();
