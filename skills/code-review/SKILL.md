---
name: code-review
description: Use before claiming a change is done, or when reviewing existing code for real problems — 边界条件、错误处理、资源释放、并发、注入面、以及踩过的具体语言陷阱。当用户说「审查一下」「这段有没有问题」「改完了检查下」「有没有坑」时用。不做代码风格批评（缩进/命名），只报能出事的。
---

# code-review — 只报能出事的

脚本：`C:\Users\KonomiHasu\dsh-private\skills\code-review\review.py`

## 为什么单独做一个

「改动后自检」只跑语法检查和测试。语法过了、测试绿了，代码照样能出事：

- 资源没关，跑几千次后句柄耗尽
- 异常被吞，错误静默变成错误数据
- SQL/命令拼接，输入里有引号就完蛋
- 并发下共享状态没保护

这些都不会让测试变红，只会让线上变红。

## 命令

```powershell
$R = "C:\Users\KonomiHasu\dsh-private\skills\code-review\review.py"

python $R scan  <文件或目录>              # 全量扫，按严重度分级
python $R diff  <git仓库>                # 只审 git diff 里的改动
python $R focus <文件> --rule sql,exec   # 只跑指定规则
python $R rules                          # 列出所有规则
```

## 检查清单（人工必看，脚本查不出的部分）

### 边界条件
- 空输入 / 空数组 / 单元素 / 超大输入
- 0、负数、`null`、`undefined`、空字符串
- 路径不存在 / 无权限 / 是目录不是文件
- 网络：超时、断连、返回非 JSON、返回 200 但内容是错误页

### 错误处理
- **有没有把异常吞掉**：`catch {}` / `except: pass` / `|| true`
- 失败时返回值能不能区分「空结果」和「出错了」
- 有没有 fail-open（审查失败当成通过）

### 资源
- 文件 / socket / DB 连接 / 子进程有没有在 `finally` 里关
- 循环里打开的资源有没有在循环内关
- 临时文件有没有清理

### 并发
- 共享状态有没有锁
- 有没有「先查再改」的竞态
- 异步函数里的错误有没有被 await 捕获

### 注入面
- SQL：拼接 vs 参数化
- 命令：`shell=True` / 字符串拼接 vs 数组参数
- 路径：用户输入直接 join vs 规范化后校验前缀
- 模板：用户输入进 `innerHTML` / `eval` / `exec`

### 语言陷阱（踩过的，写进规则了）
- **PowerShell**：函数内 `Write-Output` 会被 `$x = f()` 捕获（改用 `Write-Host`）
- **PowerShell**：`-File` 模式下 `ValueFromRemainingArguments` 不填充（读 `$args`）
- **PowerShell 5.1**：读无 BOM 的 UTF-8 会按 ANSI 解析，中文注释破坏语法
- **JSON**：`package.json` 带 BOM 会让 Node 报 `Unexpected token`
- **JS**：`if (!x) return {ok:true}` 在审查/校验里就是 fail-open

## 输出格式

```
[严重] file.js:42  命令拼接进 shell，参数未转义
[高]   db.py:88    except: pass —— SQL 错误被吞，上层拿到空结果
[中]   net.js:12   超时没设，挂死时整个 worker 占住
[低]   main.py:7   TODO 残留
```

严重度定义：
- **严重**：能被外部输入触发，或直接导致数据损坏/越权
- **高**：出错时静默、结果不可信
- **中**：资源泄漏、性能悬崖、特定条件下挂死
- **低**：可维护性

## 已知限制

- 只做文本模式匹配，**不做数据流分析**——跨函数的污点传播查不出来，那要靠人看
- 不认自定义框架的约定
- 正则可能有误报，报出来要人确认
- 不支持二进制/混淆代码

## 用法建议

改完代码、跑完测试之后、说「完成」之前，跑一次 `scan` 或 `diff`。

**报出来的每一条都要处理或明确说明为什么不处理**——不能默默无视。
