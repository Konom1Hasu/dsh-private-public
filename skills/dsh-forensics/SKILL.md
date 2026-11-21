---
name: dsh-forensics
description: Use when diagnosing DeepSeek Harness itself — 会话记录解压与检索、启动日志排查、配置树对比、profile 健康检查。当用户说「dsh 又报错了」「看看上次那个会话说了什么」「对比一下两份配置」「为什么这轮失败」时用这个 skill。不用于业务代码调试。
---

# dsh-forensics — dsh 自身取证

脚本：`C:\Users\KonomiHasu\.dsh\skills\dsh-forensics\forensics.mjs`（node，标准库即可）

## 什么时候用

- dsh 报「本轮运行失败」「unknown prompt variable」「startup failed」
- 想查历史会话里说过什么（不想开 GUI 翻）
- 改完配置要对比前后差异
- 怀疑某个 profile 的配置被覆盖

## 命令

```powershell
$F = "C:\Users\KonomiHasu\.dsh\skills\dsh-forensics\forensics.mjs"

# 1) 解压并检索会话内容（按 workspace 或全部）
node $F sessions --keyword "关键词" --max 5
node $F sessions --workspace "C:\Users\KonomiHasu" --keyword "pnpm"

# 2) 扫 dsh 日志里的错误
node $F logs --pattern "unknown prompt variable|startup failed|EADDRINUSE"

# 3) 对比两份 dump-config
node $F dumpdiff before.yml after.yml

# 4) profile 健康快照
node $F health --profile web
```

## 机制要点（改脚本时别踩）

- 会话文件是 `session.v4.jsonl.zstd`，而且是**多 frame 追加压缩**：`zstdDecompressSync` 和流式解码都**只解第一个 frame**（约 200 字节的 header），必须按 zstd magic `28 B5 2F FD` 切开逐个解。
- 会话目录按 **workspace** 编码命名（`--C-Users-KonomiHasu--` 这种），**不按 profile 分**。header 里也没有 profile 字段。
- 日志在 `~/.dsh/logs/`，启动失败才写 `startup-*.log`；成功启动不写。
- `--dump-config` 是**不启动服务**的静态装配，适合反复跑；但未知 patch id 只 warn 不改，所以 dump 出来「看着对」不等于生效。

## 已知限制

- 会话解压后是完整 JSONL，大文件（17 MB 压缩 → 上百 MB 文本）要用 `--max` 限制输出。
- 时间戳是 UTC，本地时间要 +8。
- 不解压就无法 grep（二进制），这一点常被忽略。
