import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks } from "./checks";
import { runRetryChecks } from "./checks_retry";
import { POLICIES } from "./engine";
import { METRICS, SCENARIOS } from "./experiment";
import { DEFAULT_RETRY_DELAY_H, runRetryCell, type RetryResults } from "./retry";
import { RETRY_SCENARIOS, RETRY_VALUES, RetryAnalysis, buildRetryCsv, buildRetryMd } from "./retry_report";
import { bootstrapMeanCI, makeBootstrapIndices } from "./stats";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const log = (s: string) => process.stdout.write(s + "\n");
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
function git(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8", cwd: ROOT }).trim();
  } catch {
    return "";
  }
}

/** 回歸：retry_max = 0 的 S1、S4、S6、S10，與已 commit 的 results/summary.csv 逐位元相同。 */
function regression(res: RetryResults, R: number): { ok: boolean; line: string; problems: string[] } {
  const csvPath = resolve(ROOT, "sim", "results", "summary.csv");
  const csv = readFileSync(csvPath, "utf8");
  const committed = git(["show", "HEAD:sim/results/summary.csv"]);
  const problems: string[] = [];
  if (committed && csv.trim() !== committed) problems.push("工作目錄的 summary.csv 與 HEAD 不同（既有結果檔被改動過）");

  const table = new Map<string, [number, number, number]>();
  for (const line of csv.trim().split("\n").slice(1)) {
    const [sc, pol, metric, mean, lo, hi] = line.split(",");
    table.set(`${sc}|${pol}|${metric}`, [Number(mean), Number(lo), Number(hi)]);
  }
  const idx = makeBootstrapIndices(R);
  let cells = 0;
  for (const sc of RETRY_SCENARIOS) {
    for (const pol of POLICIES) {
      for (const m of METRICS) {
        const expect = table.get(`${sc}|${pol.name}|${m}`);
        if (!expect) {
          problems.push(`summary.csv 找不到 ${sc}/${pol.name}/${m}`);
          continue;
        }
        const got = bootstrapMeanCI(res[sc][0][pol.name][m], idx);
        cells++;
        if (got.mean !== expect[0] || got.lo !== expect[1] || got.hi !== expect[2]) {
          problems.push(`${sc}/${pol.name}/${m}: 重算 ${got.mean},${got.lo},${got.hi} ≠ summary.csv ${expect.join(",")}`);
        }
      }
    }
  }
  const nums = cells * 3;
  return {
    ok: problems.length === 0,
    problems,
    line: problems.length === 0
      ? `retry_max = 0 的 S1、S4、S6、S10（4 情境 × 9 政策 × ${METRICS.length} 指標 = ${cells} 格，平均與 CI 上下限共 ${nums} 個數值）與已 commit 的 \`results/summary.csv\` **逐位元相同**。`
      : `**回歸失敗**（${problems.length} 項）`,
  };
}

function main(): void {
  const t0 = Date.now();
  const R = Number(arg("--reps") ?? 300);
  const customOut = arg("--out");
  if (R !== 300 && !customOut) {
    log("R ≠ 300 時必須用 --out 指定暫存目錄（避免把非正式結果寫進 repo）。");
    process.exitCode = 1;
    return;
  }
  const outDir = customOut ? resolve(customOut) : resolve(ROOT, "sim", "results");
  const mdPath = customOut ? resolve(outDir, "SENSITIVITY_RETRY.md") : resolve(ROOT, "sim", "SENSITIVITY_RETRY.md");

  // ---- 驗證（全過才能跑正式分析）----
  log("== 原有檢查 ==");
  const base = runChecks();
  for (const c of base) log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
  log("\n== 重挑分析的新檢查 ==");
  const extra = runRetryChecks();
  for (const c of extra) log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  [${c.detail}]` : ""}`);
  const failed = [...base, ...extra].filter((c) => !c.ok);
  if (failed.length > 0) {
    log(`\n${failed.length} 項檢查失敗，不執行正式分析。`);
    process.exitCode = 1;
    return;
  }
  const checksPassed = `原有 ${base.length} 項 + 重挑新增 ${extra.length} 項檢查全部通過（含單戶層級的 retry_max = 0 ≡ 原引擎、p = 1 政策與 retry_max 無關、retry_delay = 1e6 的時間順序、無效認領比例隨 retry_max 單調不增、手工小世界）。新檢查另外做過 6 種突變測試（見 sim/README.md）。`;
  log(`\n${base.length + extra.length}/${base.length + extra.length} 項檢查通過。\n`);

  // ---- 先算 retry_max = 0 並做回歸；不過就不繼續 ----
  const res: RetryResults = {};
  const cell = (sc: string, k: number) => {
    const scn = SCENARIOS.find((s) => s.id === sc);
    if (!scn) throw new Error(`unknown scenario ${sc}`);
    const t = Date.now();
    const out = runRetryCell(sc, scn.params, POLICIES, k, DEFAULT_RETRY_DELAY_H, R);
    log(`  ${sc} retry_max=${k} 完成（${((Date.now() - t) / 1000).toFixed(1)} 秒）`);
    return out;
  };
  log("== retry_max = 0（回歸用）==");
  for (const sc of RETRY_SCENARIOS) res[sc] = { 0: cell(sc, 0) };
  let regressionLine = `（R = ${R} ≠ 300，未與 summary.csv 比對；非正式結果）`;
  if (R === 300) {
    const g = regression(res, R);
    log(g.ok ? "回歸：通過（逐位元相同）" : "回歸：失敗");
    if (!g.ok) {
      for (const p of g.problems.slice(0, 20)) log("  " + p);
      log("\n回歸不相同就是實作有誤，不放行；不產生任何結果檔。");
      process.exitCode = 1;
      return;
    }
    regressionLine = g.line;
  }

  log("\n== retry_max = 1、5 ==");
  for (const k of RETRY_VALUES.filter((x) => x !== 0)) {
    for (const sc of RETRY_SCENARIOS) res[sc][k] = cell(sc, k);
  }

  log("\n== bootstrap 與輸出 ==");
  const a = new RetryAnalysis(res, R);
  const preregSha = git(["log", "--diff-filter=A", "--format=%H", "--", "sim/PREREGISTRATION.md"]).split("\n").filter(Boolean).pop() ?? "";
  const deviationSha = git(["log", "--format=%H", "-S", "retry_max", "--", "sim/PREREGISTRATION.md"]).split("\n").filter(Boolean).pop() ?? "";
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "sensitivity_retry.csv"), buildRetryCsv(a));
  writeFileSync(
    mdPath,
    buildRetryMd(a, {
      preregSha,
      deviationSha,
      baseHead: git(["rev-parse", "HEAD"]),
      R,
      delayMin: DEFAULT_RETRY_DELAY_H * 60,
      runtimeSeconds: (Date.now() - t0) / 1000,
      nodeVersion: process.version,
      checksPassed,
      regressionLine,
    })
  );

  const pm = "median_wait_vulnerable" as const;
  log("\nS1 弱勢家戶等待時間中位數（小時，平均 [95% CI]），依 retry_max：");
  for (const p of POLICIES) {
    log(`  ${p.name.padEnd(28)} ` + RETRY_VALUES.map((k) => {
      const v = a.summary("S1", k, p.name, pm);
      return `r${k}: ${v.mean.toFixed(2)} [${v.lo.toFixed(2)}, ${v.hi.toFixed(2)}]`;
    }).join("   "));
  }
  log(`\n輸出：${outDir}/sensitivity_retry.csv、${mdPath}`);
  log(`總執行時間 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
}

main();
