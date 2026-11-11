#!/usr/bin/env node
/**
 * dsh-soul-core 本地安装器（幂等、可回滚）
 *
 *   node install.mjs                 # 预演（不写任何东西）
 *   node install.mjs --apply         # 落盘：建 junction + 往 profile patch 追加 preset 行
 *   node install.mjs --revert        # 回滚：删 junction + 摘掉追加的那段
 *   node install.mjs --profile <dir> # 指定 profile（默认 ~/.dsh/profiles/desktop）
 *
 * 只做两件可逆的事：
 *   1. profiles/<p>/node_modules/dsh-soul-core -> 本仓库目录（junction/symlink）
 *   2. profiles/<p>/cordis.patch.yml 末尾追加一段带标记的 preset 声明（追加前备份）
 *
 * 不碰 package.json、不跑 pnpm/npm 安装、不动 dsh 的对话代码。
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = "dsh-soul-core";
const MARK_START = "# >>> dsh-soul-core preset (managed, do not edit) >>>";
const MARK_END = "# <<< dsh-soul-core preset <<<";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const revert = args.includes("--revert");
const profileIdx = args.indexOf("--profile");
const profileArg = profileIdx >= 0 ? args[profileIdx + 1] : "";

const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
const profile = resolve(profileArg || join(dshHome, "profiles", "desktop"));
const linkPath = join(profile, "node_modules", PKG);
const patchPath = join(profile, "cordis.patch.yml");

const PRESET_YML_PATH = join(HERE, "cordis.patch.yml");
const presetBlock = `${MARK_START}\n` +
  (() => {
    const yml = readFileSync(PRESET_YML_PATH, "utf8").trimEnd();
    const start = yml.indexOf("# >>> dsh-soul-core");
    const end = yml.indexOf("# <<< dsh-soul-core");
    const body = start >= 0 && end > start ? yml.slice(start, end) : yml;
    // 仓库里写的是真包名，模板里要用变量
    return body.replace(/name: 'dsh-soul-core'/g, "name: '" + PKG + "'");
  })() +
  `\n${MARK_END}\n`;

function log(...parts) {
  console.log(...parts);
}

function stripManaged(text) {
  const start = text.indexOf(MARK_START);
  if (start < 0) return text;
  const end = text.indexOf(MARK_END);
  if (end < 0) return text.slice(0, start).replace(/\s*$/, "\n");
  return (text.slice(0, start) + text.slice(end + MARK_END.length)).replace(/\n{3,}/g, "\n\n");
}

function linkExists(p) {
  try {
    const st = lstatSync(p);
    return st.isSymbolicLink() || st.isDirectory();
  } catch {
    return false;
  }
}

function makeLink() {
  const parent = dirname(linkPath);
  mkdirSync(parent, { recursive: true });
  if (process.platform === "win32") {
    execFileSync("cmd", ["/d", "/c", "mklink", "/J", linkPath, HERE], { stdio: "inherit" });
  } else {
    execFileSync("ln", ["-sfn", HERE, linkPath], { stdio: "inherit" });
  }
}

function removeLink() {
  if (process.platform === "win32") {
    try {
      rmdirSync(linkPath); // junction 用 rmdir，不会递归删目标
      return true;
    } catch {
      return false;
    }
  }
  try {
    unlinkSync(linkPath);
    return true;
  } catch {
    return false;
  }
}

function main() {
  log(`包目录   : ${HERE}`);
  log(`profile  : ${profile}`);
  log(`链接位置 : ${linkPath}`);
  log(`patch    : ${patchPath}`);
  log("");

  if (!existsSync(profile)) {
    console.error(`✗ profile 不存在：${profile}`);
    process.exit(1);
  }
  if (!existsSync(patchPath)) {
    console.error(`✗ 找不到 ${patchPath}（这不是一个 dsh profile 目录？）`);
    process.exit(1);
  }

  const patch = readFileSync(patchPath, "utf8");
  const hasBlock = patch.includes(MARK_START);
  const BLOCK_VERSION = (readFileSync(join(HERE, "cordis.patch.yml"), "utf8").match(/# block-version: \d+/) || ["# block-version: 0"])[0];
  const stale = hasBlock && !patch.includes(BLOCK_VERSION);
  const hasLink = linkExists(linkPath);

  if (revert) {
    log("== 回滚 ==");
    if (!hasBlock && !hasLink) {
      log("· 没有需要回滚的内容");
      return;
    }
    if (apply) {
      const backup = `${patchPath}.bak-soul-${Date.now()}`;
      copyFileSync(patchPath, backup);
      writeFileSync(patchPath, stripManaged(patch), "utf8");
      log(`· patch 已摘除追加段（备份：${backup}）`);
      if (hasLink) log(removeLink() ? "· junction 已删除" : "· ⚠ junction 删除失败，请手动删");
    } else {
      log("· 预演：会摘掉追加的 preset 段" + (hasLink ? " + 删除 junction" : ""));
      log("  加 --apply 才会真的执行");
    }
    return;
  }

  log("== 计划 ==");
  log(`1. ${hasLink ? "已存在，跳过" : "建立"} junction：node_modules/${PKG} -> ${HERE}`);
  log(
    `2. ${hasBlock ? (stale ? "更新" : "已是最新，跳过") : "追加"} patch 段到 cordis.patch.yml（改动前备份）`,
  );
  log("");

  if (!apply) {
    log("这是预演。确认无误后加 --apply 执行。");
    return;
  }

  if (!hasBlock) {
    const backup = `${patchPath}.bak-soul-${Date.now()}`;
    copyFileSync(patchPath, backup);
    const next = patch.replace(/\s*$/, "") + "\n\n" + presetBlock;
    writeFileSync(patchPath, next, "utf8");
    log(`✓ patch 已追加（备份：${backup}）`);
  } else if (stale) {
    // 老版本段（没有 profile 级 ui 实例）→ 原地替换成新版
    const backup = `${patchPath}.bak-soul-${Date.now()}`;
    copyFileSync(patchPath, backup);
    const start = patch.indexOf(MARK_START);
    const end = patch.indexOf(MARK_END);
    const next =
      end < 0
        ? stripManaged(patch).replace(/\s*$/, "\n\n") + presetBlock
        : patch.slice(0, start) + presetBlock.trimEnd() + "\n" + patch.slice(end + MARK_END.length);
    writeFileSync(patchPath, next, "utf8");
    log(`✓ patch 段已升级为含 profile 级 ui 实例的版本（备份：${backup}）`);
  } else {
    log("· patch 已是最新版本，跳过");
  }

  if (!hasLink) {
    makeLink();
    log("✓ junction 已建立");
  } else {
    log("· junction 已存在，跳过");
  }

  log("");
  log("完成。接下来：重启 DSH → 新建任务时在「模式/preset」里选「人格」。");
  log("注意：预设只对**新会话**生效；已有会话保留原组合（KV cache 与插件组合都稳定）。");
}

main();
