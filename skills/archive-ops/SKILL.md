---
name: archive-ops
description: Use when you need to inspect or unpack archives without 7-Zip installed — zip/apk/jar/whl/nupkg/tar/gz/bz2/xz/epub/ipa。列内容、选择性解压、在包里找文件、检查压缩比。当用户说「解包这个」「看看包里有什么」「这个 apk 里有什么」「提取里面的配置」时用。
---

# archive-ops — 归档解包与检视

脚本：`C:\Users\KonomiHasu\.dsh\skills\archive-ops\archive.py`（Python 标准库，无需安装任何东西）

## 什么时候用

- 机器上**没有 7z / unzip**（这台就是），需要一个能用的解包工具
- 要快速看包里有什么，而不是全解出来
- 要在包里搜某个文件名
- APK / IPA / JAR / WHL / NUPKG / EPUB —— 它们本质都是 zip，同一个脚本通吃

## 命令

```powershell
$A = "C:\Users\KonomiHasu\.dsh\skills\archive-ops\archive.py"

python $A list  some.apk                      # 列内容（带大小、压缩比）
python $A list  big.tar.gz --limit 50         # 只列前 50 条
python $A list  pkg.zip --grep "\.json$"      # 只看匹配的条目

python $A extract some.apk -o out\dir         # 全部解压
python $A extract some.apk -o out --grep "AndroidManifest"   # 只解匹配的

python $A find  some.zip "config"             # 在包里找文件名含 config 的
python $A info  some.zip                      # 汇总：条目数、总大小、压缩算法
```

## 机制要点（别踩）

- **APK/IPA/JAR/WHL/NUPKG/EPUB 都是 zip**，`zipfile` 直接读，不需要额外工具。
- zip 里的文件名**可能是 GBK 编码**（老旧 Windows 打包），`archive.py` 已做 `cp437 → gbk` 回退，否则中文名会乱码。
- `tar.gz` 是两层：`.gz` 解出 tar，再解 tar。脚本用 `tarfile.open(..., 'r:gz')` 一次搞定，别手动解两层。
- 单文件 `.gz`（如 `a.log.gz`）不是 tar，要用 `gzip` 模块，脚本按 magic 判断走哪条路。
- **路径穿越**：包里可能有 `../../etc/passwd` 这种条目，`extract` 已做路径归一化拦截，不要绕过它。

## 已知限制

- 不支持 rar / 7z（需要外部程序，本机没有）。
- 加密 zip 会直接报错（标准库不支持解密）。
- 超大包（>2 GB）一次读进内存会吃紧，`list` 是流式的，`extract` 建议配合 `--grep` 分批。
