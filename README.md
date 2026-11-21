# dsh-private — YG 的私有化 fork 层

不改 `node_modules`，不改上游源码。所有改造活在这一层，随 npm 升级不丢。

## 结构

```
packages/dsh-private-core/
  package.json          dsh.bundle.patch 声明自己是一个组合包
  cordis.patch.yml      身份接管 + 私有行插入
  lib/index.js          cordis 插件：私有提示词段 + yg_note 工具
```

## 装进 profile（方式只有一个，错了必挂）

```powershell
cd $env:USERPROFILE\.dsh\profiles\web
pnpm add file:C:/Users/KonomiHasu/dsh-private/packages/dsh-private-core
```

**必须 `file:`，必须是硬拷贝。**

实测事实：

- `profiles\web\node_modules\@deepseek-ai` 是**空目录**（0 项）
- 真正能被解析到的那层在上一级：`profiles\node_modules\@deepseek-ai`（195 项），其中 `dsh-tools` 是指向全局 dsh 安装目录的 **Junction**
- 所以包体必须**物理落在 profiles 树内**，`import '@deepseek-ai/dsh-tools'` 才能顺着 realpath 向上找到

推论：

- **不要用 `link:`** —— symlink 的 realpath 落在 `dsh-private\` 外面，向上找不到 `@deepseek-ai/*`，`ERR_MODULE_NOT_FOUND`
- **不要把 `packages/*` 加进 `pnpm-workspace.yaml` 的 `packages`** —— workspace 成员就是 symlink，同一个死法
- pnpm 12.x 对 `pnpm add file:<dir>` 是硬拷贝，不会 symlink，所以这条路能活

然后把包名加进 `package.json` 的 `dsh.profile.bundles`（加在官方 bundle 之后）：

```json
"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@yg/dsh-private-core", ...]
```

启动：`dsh web`

## 验证（不做这一步就等于没装）

```powershell
dsh --profile web --dump-config | Select-String -Context 2,8 'private-core|system-prompt'
```

必须看到 `private-core` 条目，且 `system-prompt.personaPrefix` 是你的文本。

**为什么必须验证**：patch 写了不存在的 id，loader 只 warn 然后跳过
（`dsh-app-boot/lib/index.js:97`，schema 原文 "warned and skipped"）。
它不报错，所以你从"启动成功"里看不出任何异常。

## 回滚

```powershell
cd $env:USERPROFILE\.dsh\profiles\web
# package.json 里删掉 "@yg/dsh-private-core"，再
pnpm install
```

回滚是否干净，同样用上面那条 `--dump-config` 对比：`private-core` 条目消失、`personaPrefix` 回到 profile 自己那份的值。

## 迭代边界

| 改动 | 生效方式 |
|---|---|
| `cordis.patch.yml` | HMR 热重组，不重启 |
| `lib/index.js` | 必须重启 dsh 进程 |

## 往这层加东西的落点

| 层 | 落点 |
|---|---|
| 品牌/UI | 新增 `dsh-client-ui-brand-*` 行；`ui-settings-general` 的 welcomeNoticeVersion |
| 模型路由 | `llm-pi-ai` 的 providers（已有一份私有网关示例） |
| 工具 | `lib/index.js` 里再 `ctx.tools.register(defineTool(...))` |
| 私有技能库 | `$DSH_HOME/skills/` + `dsh-skill-filesystem` 的 path |
| 对外服务 | `host-webserver` 监听地址 + 前置鉴权（唯一必须写 host 侧代码的方向） |

完整技术文档见 [docs/PRIVATE-ARCHITECTURE.md](docs/PRIVATE-ARCHITECTURE.md)。

## 打包与部署

一条命令把整套改造部署到新 profile：

```powershell
powershell -File bootstrap.ps1 -DryRun     # 先看计划
powershell -File bootstrap.ps1             # 部署到 profile "private"
dsh --profile private
```

配置分两层，**不可混**：

| 层 | 位置 | 可否分发 |
|---|---|---|
| 通用（身份安全值、压缩、心跳、检索） | `packaging/profile-template/` | ✅ |
| 私有（provider、baseURL、密钥变量名） | `packaging/local/` → 手动放置 | ❌ |

详见 [packaging/README.md](packaging/README.md)。

## 灾备与安全改造

**改造前必读**：[docs/DISASTER-RECOVERY.md](docs/DISASTER-RECOVERY.md)

核心原则：dsh 的故障会表现为「**界面在但发不出消息**」，此时任何靠会话执行的恢复手段都失效。
所以全部恢复工具只依赖**文件、进程表、端口**三样。

```
scripts/
  snapshot.ps1        改动前快照（每文件 SHA256）
  verify.ps1          8 项检查，全绿才写 GOOD.txt
  rollback.ps1        按快照恢复，hash 校验
  restart-safe.ps1    按端口 owner 杀进程，校验新 PID
  rescue.ps1          五步合一：恢复→重打补丁→重装→重启→验证
  watchdog.ps1        离线体检，默认只报告
  apply-patches.ps1   幂等重打 node_modules 补丁（pnpm install 后必跑）
```

桌面一键入口：`DSH-RESCUE.bat`（救援）、`DSH-CHECK.bat`（体检）。

**每次改动**：`snapshot` → 改一个东西 → `verify` → 不全绿就 `rollback`。
**每次 pnpm install 之后**：`apply-patches` → `verify`。
