# 训练：把 50 MB 的 NNUE 蒸馏成小网络

这个目录是**实验性**的：它把官方 Pikafish 网络当作教师，训练一个更小的学生网络，
目标是让浏览器端首屏下载从 50 MB 降到 25 MB 左右。它不是 v0.1 发布物的一部分，
不参与 `pnpm build`，也不会被 demo 引用。

核心结论：**整条链路已经打通并逐字节验证过**，剩下的只是算力与数据质量，
不再是「理解是否正确」的问题。

## 现状

| 环节 | 状态 | 证据 |
| --- | --- | --- |
| 特征索引 + 教师评估导出 | ✅ 本机实测 | `pikafish-dump`，22.6k 局面/秒；PKFD v2 记录两个视角的活跃索引、layer stack bucket、i32 内部评估 |
| 整数 parity（Python ↔ 引擎） | ✅ **通过** | `parity.py`：15,040 局面，最差偏差 **0**，覆盖全部 32 个 bucket，2 秒 |
| 浮点 parity（模型 ↔ 导出） | ✅ **通过** | `parity_float.py`：引擎/导出/量化模型三者精确一致；平滑前向 rms 17.58（仅作诊断） |
| 量化感知（QAT） | ✅ 必需 | 用教师自己的权重，平滑浮点前向与引擎差 rms 17.0 / 最大 72 内部单位；量化前向为 0 |
| 导出 `.nnue` | ✅ 实测 | `nnue_io.write_net` 重写教师网与引擎自己的 `export_net` **逐字节一致**（64,701,916 B） |
| `L1=512` 重新编译引擎 | ✅ 实测 | `training/engine/build-512/`；`ft_hash 0x6e62dc8c`、`arch_hash 0x63337196` |
| 引擎加载学生网 | ✅ **通过** | L1=512 引擎加载导出的 512 学生网，15,040 局面最差偏差 **0**；训练后的网 4,000 局面偏差 **0** |
| 数据自产（无公开数据集） | ✅ 实测 | `selfplay.py` 驱动引擎自对弈，6 个配方覆盖 **32/32** bucket，59,409 局面 |
| 训练循环 | ✅ 实测 | 3000 步（约 150 万局面）：loss 3.09 → 0.75，与教师相关系数 **0.979**、符号一致 93.5% |
| Kaggle 一键脚本 | ✅ 本机全流程 2 分钟 | `training/kaggle/run.py`，六个阶段可断点续跑 |

训练质量还没有结论：3000 步只是证明「能学」，不是「学会了」。长跑见「下一步」。

## 目录结构

```
training/
  engine/
    dump_tool.cpp       导出工具：FEN 列表 -> 特征索引 + 教师评估（不改上游源码）
    build-512/          L1=512 的引擎副本 + 目标文件 + 工具（生成物，已 gitignore）
  python/
    nnue_io.py          .nnue 读写（zstd 透明）+ 逐位精确的整数 Evaluator
    model.py            学生网络（按引擎前向实现，含量化感知的 straight-through）
    export.py           Net <-> StudentNet、列投影、导出并校验
    parity.py           整数 parity 硬门槛（对引擎）
    parity_float.py     浮点/导出 parity 硬门槛（不依赖引擎）
    train.py            训练循环、断点续训、导出
    export_student.py   从 checkpoint 导出 .nnue，并用同宽引擎复核
    selfplay.py         用引擎自对弈生成 FEN（含面向 bucket 的削子配方）
    compare_nets.py     两个网络在同一批局面上的评估差异
    test_bucket.py      校验 Python 的 bucket 计算与引擎一致（不需要引擎）
    reader.py           PKFD v2 -> numpy -> 分片
    make_student.py     从教师投影出学生网（冒烟 / 热启动基线）
  kaggle/
    kernel-metadata.json
    run.py              在 Kaggle 上一键跑：编译 -> 造局面 -> 标注 -> 分片 -> 训练 -> 导出
  tools/
    gen-fens.mjs        随机/稀疏对局生成 FEN（走 rules 包，需要 Node）
    gen-bucket-fens.py  每个 layer stack bucket 一个 FEN（已用它验证 bucket 公式）
```

## 快速开始（本机，Windows + MinGW 或 Linux）

```bash
# 0. 编译引擎与导出工具（首次几分钟）——见 engine/README.md
#    教师工具用官方 L1=1024；学生工具需要一份 L1=512 的引擎副本

# 1. 自对弈造局面（纯引擎，不需要 Node、不需要数据集）
python training/python/selfplay.py --engine training/engine/build-512/src/pikafish.exe \
    --out training/data/fens.txt --games 2000 --max-minutes 20 --policy search --nodes 2000

# 2. 标注（教师 = 官方 1024 网络）
training/engine/pikafish-dump dump assets/pikafish.nnue training/data/fens.txt training/data/all.bin

# 3. 分片
python -c "import sys; sys.path.insert(0,'training/python'); \
from reader import read_dump, write_shards; \
write_shards(read_dump('training/data/all.bin'), 'training/data/shards', per_shard=200000)"

# 4. 训练（从教师投影热启动，L1=512）
python training/python/train.py --shards training/data/shards \
    --init-from assets/pikafish.nnue --half 512 --steps 200000 \
    --batch-size 1024 --target-clip 4000 --save-every 2000 --out training/out/student.pt

# 5. 导出并用同宽引擎复核（--engine 可选，需要 L1=512 的 dump 工具）
python training/python/export_student.py --checkpoint training/out/student.pt \
    --out training/out/student.nnue --shards training/data/shards \
    --engine training/engine/pikafish-dump-512.exe --fens training/data/fens.txt
```

硬门槛（改动 `nnue_io.py` / `model.py` / `export.py` 后应当重跑）：

```bash
python training/python/parity.py       training/data/parity.bin assets/pikafish.nnue
python training/python/parity_float.py training/data/parity.bin assets/pikafish.nnue 400
python training/python/test_bucket.py
```

## 数据从哪来

没有公开的象棋训练集，官方训练仓库（`pikafish-nnue-pytorch`）也已 404，
所以局面由引擎自己产生：`selfplay.py` 通过 UCI 驱动引擎自对弈，用它的着法生成器
保证合法性，用 `d` 命令读回 FEN。

两种打法差别很大，两种都要：

- `--policy search`（默认）：引擎用很小的预算（`--nodes 2000`）走棋，对局像真实的
  低强度对局，教师对这些局面的评价才是学生该模仿的东西。约 950 局面/秒。
- `--policy random`：均匀随机走子（`go perft 1` 列出合法着法再随机挑）。便宜得多
  （约 4,700 局面/秒），而且随机送子很快进入残局，正好补足稀疏局面。

**layer stack bucket 决定用哪一组全连接权重**，32 个 bucket 各有一套，所以语料里
缺哪个 bucket，那一套就没被训练。bucket 只取决于双方的车数和「马+炮」数量
（`selfplay.bucket_of`，与引擎 `K6R2NC2::make_layer_stack_bucket` 一致，
`test_bucket.py` 用 32 个手工局面复核）。实测：

- 普通对局（search + random）覆盖 29/32，缺 bucket 3、16、20；
- 重削子只能覆盖另外一批（它会把车一起拿掉）；
- 因此 `selfplay.py` 支持 `--target-rooks` / `--target-nc`（**每方**，可写 `车,炮马`
  分别指定），定向凑出稀有材料。

`training/kaggle/run.py` 里的六个配方合起来覆盖 32/32（实测 59,409 局面，
每个 bucket 至少 110 个）：

| 配方 | 材料目标 | 作用 |
| --- | --- | --- |
| `search` | 正常（35% 对局轻削子） | 真实对局分布，主线数据 |
| `random` | 正常（50% 轻削子） | 便宜，补残局 |
| `rookless` | 双方 0 车、4 马炮 | 补齐 bucket 0–7 |
| `rooks2nc0` | 双方 2 车、0 马炮 | bucket 16/20 |
| `rooks2nc10` | 双方 2 车、一方 1 马炮 | bucket 16（关键：马炮数必须**不相等**） |
| `nothing` | 双方 0 车、一方 1 马炮 | bucket 3 一类 |

## Kaggle

配额是每周约 30 GPU 小时（2×T4 或 1×P100，单次 12 小时）。`run.py` 分六个阶段，
每个阶段完成后在 `PIKAFISH_WORK` 留一个 `.阶段.done` 标记，被 12 小时上限打断后
直接重跑即可续训（训练阶段会用 `--resume` 读回 `student.pt`）。

```bash
# 令牌只放在本机 ~/.kaggle/kaggle.json，或环境变量 KAGGLE_USERNAME / KAGGLE_KEY
kaggle datasets create -p training/data        # 数据集：仓库 + 教师网络
kaggle kernels push -p training/kaggle         # 运行 kernel
```

主要环境变量：`PIKAFISH_REPO`、`PIKAFISH_WORK`、`PIKAFISH_NET`、`PIKAFISH_HALF`、
`PIKAFISH_STEPS`、`PIKAFISH_GEN_MINUTES`、`PIKAFISH_STAGES`（只跑其中几个阶段）、
`PIKAFISH_FORCE=1`（忽略标记重跑）。本机冒烟时可以配合 `PIKAFISH_GEN_GAMES`、
`PIKAFISH_ENGINE`、`PIKAFISH_TEACHER_TOOL`、`PIKAFISH_STUDENT_TOOL` 指向已经编好的
二进制，跳过 `build` 阶段。

本机实测耗时（150 局/配方，200 步训练）：造局面 90 秒、标注 1 秒、分片 1 秒、
训练 9 秒、导出+复核 24 秒。真正的时间花在标注与训练：教师标注约 22.6k 局面/秒
（单线程），训练在本机 GPU 上约 21k 局面/秒。

## 已确认的技术事实

全部来自钉住的上游提交 `545c4e3b`，并用引擎实测过：

- 特征集：`FullThreats` 45,547 维 + `K6R2NC2` 16,536 维 = **62,083**。
- `WeightType = i8`，**全连接层的 bias 是 i32**（只有 FT 的 bias 是 i16）；
  `OutputScale = 16`、`WeightScaleBits = 6`、`FtMaxVal = 255`。
- 文件布局（预测大小 64,701,916 与实际一致）：

  ```
  u32 version(0x6A448AFA) | u32 hash | u32 desc_len | desc
  u32 ft_hash | i16 ft_bias[L1]
  i8 threat[45547][L1] | i8 psq[16536][L1]
  × 32 个 layer stack:
      u32 arch_hash
      i32 fc_0.bias[32]  + i8 fc_0.w[32][L1]
      i32 fc_1.bias[32]  + i8 fc_1.w[32][64]
      i32 fc_2.bias[1]   + i8 fc_2.w[1][128]
  ```

- 特征变换层是**成对乘积**：`L1` 维累加器折半成 `L1/2` 个乘积，两个视角拼成 `L1`
  维（即 `TransformedFeatureDimensions == L1`）。前向细节（全部按 C++ 整数语义）：

  ```
  acc   = Σ ft_row + ft_bias                     # i16
  t     = clamp(acc, -32767, 32767)
  sqr   = clamp(trunc(t² / 2²¹), 0, 127)         # fc_0 用 2²¹，fc_1 用 2¹⁹
  clip  = clamp(trunc(t / 128), 0, 127)          # fc_1 用 64
  c1    = [sqr0, clip0]                          # 64 维
  c2    = [sqr0, clip0, sqr1, clip1]             # 128 维
  o2    = fc_2(c2) + (o0[30] - o0[31])           # 原始 i32 输出上的 skip
  value = trunc(o2 * 9600 / 16384) / 16          # 两次除法都向零截断
  ```

- 哈希把特征集与 `L1/L2/L3` 绑死，**改小 `L1` 必须用自己的常量重新编译引擎**，
  官方 wasm / 官方引擎无法加载学生网：

  | L1 | ft_hash | arch_hash | 文件头 hash |
  | --- | --- | --- | --- |
  | 1024 | `0x6E62D08C` | `0x63337116` | `0x0d51a19a` |
  | 512 | `0x6e62dc8c` | `0x63337196` | `0x0d51ad1a` |

- 量化感知训练是**必需的**，不是优化项：用教师自己的权重，平滑浮点前向与引擎差
  rms 17.0 / 最大 72 内部单位。因此 `StudentNet` 的参数直接存放引擎单位
  （i8 量级的权重、i32 量级的 bias），前向复现引擎算术，取整处用 straight-through。
  导出时只需取整和截断，不做任何缩放换算。
- 训练目标是教师的**内部评估**（`eval_internal`），不是 cp：`UCIEngine::to_cp` 会
  除以一个随局面变化的 `a`（约 400），cp 是内部值的重新缩放视图。
- 学生网 `L1=512` 时参数量 32.38M，导出 32,389,959 B（未压缩）/ 约 25.1 MB（zstd）。

**验证训练路径是否真的对齐引擎的最快办法**：用 `--half 1024 --init-from` 从教师
加载一个同宽模型，此时 loss 必须恒为 `0.00000`（实测 40 步全为 0）。若不为 0，
说明数据管线、目标尺度或 loss 接线有问题，不必浪费 Kaggle 配额。

## 踩过的坑（会再次遇到）

- 引擎遇到**非法 FEN 会直接退出**（`CRITICAL ERROR ... King can be captured`）。
  削子时保留将帅所在纵线（第 4 列）上的所有棋子，就不会让将帅照面；真被拒了也
  只是重启一次引擎、损失一局（`selfplay.py` 会自动重启并保留已采样的局面）。
- 引擎的加载器**只认 zstd 帧**（`read_compressed_nnue` 流式解压），写一个未压缩的
  `.nnue` 会得到空描述、评估恒为 0，而不是报错。
- 一次性把 `go ...` 和 `quit` 通过管道喂给引擎时，`go` 的解析会**吞掉后面所有输入**，
  于是 `quit` 不生效、搜索无上限地跑下去。必须一条命令一问一答（`selfplay.Engine`）。
- 这个分支的 `bench` 自己解析参数（`BenchmarkCommand = "speedtest"`），猜错参数就是
  无上限长跑；验证「引擎能加载并搜索」用 `go nodes N` 更稳。
- `sf.moved` 之类的直觉在这里不适用：`go nodes` 是按节点数上限的，实测有效。
- `UCIEngine::to_cp` 随局面变化，所以别用 cp 当回归目标。

## 下一步

1. **长跑训练**：换到 Kaggle，用 `PIKAFISH_STEPS` 控制步数，先跑 20k 步看
   相关系数是否继续上升，再决定是否加到 200k。当前 3000 步的基线是
   相关系数 0.979、符号一致 93.5%、平均差 268 内部单位（约 67cp）。
2. **数据质量**：目前语料全部来自自对弈，且为了补 bucket 掺入了大量削子局面。
   真实棋谱（若有）或更强的自对弈（`--nodes` 调大）应当能明显提升。
3. **学生宽度**：`--half 384` 可以再省 25%，但 384 不是 32 的整数倍会让 `L1/2`
   成对乘积与 SIMD 填充分歧，需要先确认 `PaddedInputDimensions` 的行为。
4. **可选**：`module.FS.unlink('/pikafish.nnue')`（`packages/engine/src/worker/runtime.ts`
   初始化之后）可以省下约 50 MB 峰值内存。

## 风险与已知缺口

- **没有公开的象棋训练集**，官方训练代码仓库已 404，只能自己攒数据。
- **学生网目前明显弱于教师**：3000 步、150 万局面的成品只有 0.979 的相关系数，
  距离可用还很远；本文档不宣称任何棋力结论。
- **长捉 / 重复局面**：v0.1 的规则包对长捉按和棋处理，若将来引入真实棋谱，
  标签会带上这层偏差。
- **唯一没有实测过的环节是 Kaggle 本身**：`run.py` 的六个阶段在本机
  （Windows + MinGW + RTX 4060）全流程跑通，但 Kaggle 的 Linux 构建、
  `link_dump_tool` 的链接参数回退、以及 12 小时断点续训都还没有在真实环境验证。
- 本机训练吞吐受 Python 取数限制，必要时把 `collate` 换成
  `IterableDataset` + 后台预取。
