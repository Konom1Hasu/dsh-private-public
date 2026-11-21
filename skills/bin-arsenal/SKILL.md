---
name: bin-arsenal
description: Use for binary reverse engineering on local samples — 壳识别、节表/导入导出、按块熵、capstone 反汇编、x86 代码模拟执行、YARA 扫描、字符串带偏移提取。当用户说「这个壳是什么」「反汇编看看」「脱壳」「dump 内存」「这块代码干什么」「扫一下特征」时用。不做动态注入（那是 frida 的活）。
---

# bin-arsenal — 静态分析 / 反汇编 / 模拟执行

脚本：`C:\Users\KonomiHasu\dsh-private\skills\bin-arsenal\arsenal.py`

依赖（已装）：`capstone 5.0.7` `pefile 2024.8` `unicorn 2.1.4` `yara 4.5.4` `z3`

## 命令

```powershell
$A = "C:\Users\KonomiHasu\dsh-private\skills\bin-arsenal\arsenal.py"

python $A info    <file>                    # 架构/壳/入口点/异常特征
python $A sections <file>                   # 节表 + 每节熵
python $A imports <file>                    # 导入表（PE）或动态符号（ELF）
python $A exports <file>
python $A strings <file> --min 6 --off      # 带文件偏移
python $A entropy <file> --block 256        # 熵曲线，找加密/压缩段
python $A disasm  <file> --va 0x401000 -n 40
python $A search  <file> --bytes 488d        # 字节特征搜索
python $A emu     <file> --va 0x401000 -n 200 --step 5000
python $A yara    <file> --rule  <规则文件或内联>
python $A carve   <file> --ext .png         # 从内存镜像/固件里切文件
```

## 壳识别怎么判（不是猜，是给依据）

组合四条独立信号，任一命中就标可疑并说明是哪条：

| 信号 | 判断 | 典型壳 |
|---|---|---|
| 节名白名单 | `UPX0/UPX1` `.aspack` `.themida` `.vmp0` `.enigma` | 对应壳 |
| 入口点不在 `.text` | EP 落在最后节或非常规段 | 加密壳 |
| 节熵 > 7.2 | 接近随机 = 压缩/加密 | UPX、AES 壳 |
| 原始大小 ≈ 0 但虚拟大小很大 | 运行时才解压 | 多数压缩壳 |
| 导入表极少（< 5 个且含 LoadLibrary/GetProcAddress） | 运行时解析 API | 加密壳常见 |

**只报有依据的**，不写「可能是壳」。给不出信号就说「未见壳特征」。

## 熵怎么读

- `< 1`：全零/填充
- `4-6`：正常代码
- `6.5-7.2`：压缩过的资源
- `> 7.2`：加密或强压缩

按块算比整节算准：整节平均 6.8 但某 256 字节块 7.9，那块才是加密的。

## 反汇编

```powershell
python $A disasm sample.exe --va 0x140001000 -n 60
python $A disasm sample.exe --file-off 0x800 --n 40     # 按文件偏移
```

支持 x86/x64/ARM/ARM64/MIPS（自动按 PE/ELF 架构选）。

**看什么**（不是逐条读）：
- `call` 的目标：是不是 `GetProcAddress` / `VirtualAlloc` / `LoadLibrary`
- `xor` 循环：解密
- `rep movs`：内存拷贝（dump 前兆）
- 大块 `mov` 立即数：常量表/密钥

## 模拟执行

```powershell
python $A emu sample.exe --va 0x140001200 -n 300 --step 20000
```

用 unicorn 跑指定地址的代码，记录指令轨迹和内存写入。

用途：
- 还原解密算法（喂输入，看输出）
- 跟踪字符串解引用
- 不启动进程验证行为

**限制**：无系统调用、无外部 API。碰到 `call [import]` 会停。

## YARA

```powershell
# 内联规则
python $A yara sample.bin --rule 'rule x { strings: $a = "MZ" condition: $a }'

# 规则文件
python $A yara samples/ --rule rules.yar
```

## carve（从镜像切文件）

```powershell
python $A carve firmware.bin --ext .png,.jpg,.zip,.gz
```

按魔数扫，把命中区间切出来各自存盘。不依赖 binwalk。

## 已知限制

- **不做动态注入/hook**——用 frida，另开
- 模拟执行碰系统调用会停，不是完整沙箱
- 壳识别是启发式，商业壳（VMProtect/Themida）只能报「疑似 + 依据」，**不要期待自动脱壳**
- 反汇编不做控制流重建（没有 CFG），交叉引用要手工找
- 大文件（>200 MB）熵和 carve 会慢，先切段

## 底线

分析样本时：
- 在隔离目录操作，不在样本所在目录原地改
- 需要执行样本时用独立虚拟机，不在这台机器上跑
- dump 出来的内存镜像单独存，不当普通文件打开
