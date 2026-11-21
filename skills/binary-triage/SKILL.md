---
name: binary-triage
description: Use when you need to know WHAT a file is before deciding how to handle it — 魔数识别、PE/ELF/Mach-O 头解析、提取可读字符串、判断是否加壳/是否脚本。当用户说「这是什么文件」「帮我看看这个 exe」「这堆文件里哪些是二进制」「提取一下里面的字符串」时用。不用于深度反汇编（那需要 capstone/ghidra）。
---

# binary-triage — 文件类型快速判定

脚本：`C:\Users\KonomiHasu\.dsh\skills\binary-triage\triage.py`（Python 标准库）

## 什么时候用

- 拿到一个没扩展名或扩展名可疑的文件，先判断真实类型
- 批量扫描一个目录，分出「文本 / 二进制 / 压缩包 / 脚本」
- 看 PE 的节表、导入的 DLL、是不是 .NET、有没有加壳迹象
- 从二进制里捞可读字符串（URL、路径、错误信息、密钥线索）

## 命令

```powershell
$T = "C:\Users\KonomiHasu\.dsh\skills\binary-triage\triage.py"

python $T file  some.bin                 # 魔数 + 结构判定
python $T pe    app.exe                  # PE 详情：架构、节表、导入表
python $T strings  app.exe --min 6 --grep "http|api"   # 提取字符串
python $T scan  C:\some\dir              # 批量分类目录
```

## 机制要点（别踩）

- **魔数优先于扩展名**。`PK\x03\x04` 是 zip（可能伪装成 .jpg），`MZ` 是 PE，`\x7fELF` 是 ELF，`\x1f\x8b` 是 gzip。脚本先读前 16 字节再判断。
- **PE 的「加壳」判据**：节名像 `UPX0`/`.aspack`/. 或节区熵 > 7.2 → 大概率加壳。脚本用 `import math` 算熵，不需要外部工具。
- **.NET 判据**：数据目录第 15 项（CLR Runtime Header）非零。脚本会报 `is_dotnet`。
- **strings 只提取可打印 ASCII 连续串**，中文要找 UTF-16 需要 `--utf16`（脚本支持）。
- 读大文件时用 `--head` 限制字节数，别整个读进内存。

## 已知限制

- 不做反汇编、不做伪代码、不识别具体编译器版本。
- Mach-O 只认头，不解析 load command 细节。
- 加壳判定是启发式，可能误报（自解压程序也会熵高）。
- 加密文件/压缩包内部的内容看不到，需要先解压（配合 `archive-ops`）。
