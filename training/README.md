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
| Kaggle 一键脚本 | ✅ 本机全流程 3.4 分钟 | `training/kaggle/run.py`：自举（克隆仓库、浅取上游、校验网络）+ 六个阶段，无需数据集 |
| Kaggle 端到端（20k 步） | ✅ **实测 31 分钟** | 261,217 局面 **32/32**、loss 2.875 → 0.156、导出 1200/1200 精确、引擎复核 4,000 局面 worst \|delta\| **0**、`student.nnue` 25,111,049 B |
| Kaggle 端到端（120k 步） | ✅ 实测 137 分钟 | 1,281,062 局面 **32/32**、7 个分片、`student.nnue` 25,126,271 B、导出复核同样零误差 |
| Kaggle 端到端（200k 步） | ✅ 实测 213 分钟 | 1,926,771 局面 **32/32**、10 个分片、`student.nnue` 25,136,309 B、1200/1200 精确、引擎 4,000 局面 worst \|delta\| **0** |
| 云端吞吐 | ✅ 实测 | 训练 **30.5k 局面/秒**（batch 1024）、生成约 100 局面/秒、两棵树编译 8 分钟 |

### 质量实测（同一个量法：网 vs 教师，内部单位 ×0.25 ≈ cp）

| 训练 | 真实语料 `all.bin` | 构造语料 `parity.bin` | 相关 | 符号一致 |
| --- | --- | --- | --- | --- |
| 只做投影、零训练（暖启动） | — | 343 cp | 0.265 | 45.0% |
| 3000 步（本机 59k 局面） | 67 cp | — | 0.979 | 93.5% |
| 20k 步（261k 局面） | 63 cp | 52 cp | 0.981 | 93.7% |
| 120k 步（1.28M 局面） | 55 cp | 43 cp | 0.984 | 94.2% |
| 200k 步（1.93M 局面） | **54.3 cp** | **41.9 cp** | **0.984** | 94.3% |

数据 ×1.5、步数 ×1.67 只买到 2–3% 的改善：这条曲线已经平了，**L1=512 是硬约束**，
继续堆数据不会改变结论。

数据 ×5、步数 ×6 只买到 13% 的改善，据此把 `all.bin` 按教师的 |eval| 分档后，
短板看得很清楚（120k 步的网）：

| 教师 \|eval\|（内部单位） | 局面数 | 平均差 | 符号一致 |
| --- | --- | --- | --- |
| 0–100 | 7,447 | **20.7 cp** | 71.8% |
| 100–300 | 4,912 | 51.0 cp | 83.9% |
| 300–700 | 6,862 | 64.2 cp | 92.7% |
| 700–1500 | 13,637 | 58.2 cp | 99.2% |
| 1500–4000 | 24,633 | 48.5 cp | 100% |
| >4000（被 `--target-clip` 压平） | 1,918 | 213 cp | 100% |

语料的教师评估均值是 1452 内部单位（≈363 cp）、83% 的局面 \|eval\| ≥ 200——自对弈语料
是「已决出胜负的对局集」，而棋力由均势段决定，那一档只有 7,447 个样本。

### 体积 ↔ 棋力：能压到多小？

要回答「10 MB 行不行、KB 级行不行」，得先有宽度可变的引擎。`L1` 是引擎的编译期常量，
两个宽度只差 `nnue/nnue_architecture.h` 里的一行，所以 `training/engine/build-width.sh`
能按宽度编译引擎与导出工具，并打印该宽度的架构哈希（`ft` / `arch`）——导出端要写出
引擎认的哈希，就靠这个。

同一份语料（49,709 局面）、同一 schedule（20k 步、batch 1024、热启动），只变宽度；
棋力用 300 局固定节点对局（4000 节点/步）量：

| L1 | 网（zstd） | 网（plain） | 训练 loss | 评估保真度 mean\|d\| / 相关 | Elo vs 教师 |
| --- | --- | --- | --- | --- | --- |
| 1024（教师） | 50,241,100 B | 64.7 MB | — | 0 | 0 |
| 512 | 25,136,309 B | 32.4 MB | 0.0026 | 357 / 0.970 | **−158** |
| 256 | 12,646,031 B | 16.2 MB | 0.0230 | 501 / 0.947 | −220 |
| 192 | 9,509,290 B | 12.2 MB | 0.0516 | 544 / 0.939 | **−260** |
| 128 | 6,368,708 B | 8.2 MB | 0.0997 | 559 / 0.931 | −284 |
| 64 | 3,221,603 B | 4.1 MB | 0.2375 | 598 / 0.914 | −325 |
| 64，但特征变换器清零 | 3,221,603 B | 4.1 MB | — | — | −552 |
| 32 | **引擎编译不过** | — | 0.5197 | — | — |

三条结论：

1. **每减半宽度掉 40–65 Elo，而且越往下越平**：512→256 掉 62、256→128 掉 64、
   128→64 只掉 41（L1=192 夹在中间掉 40）。同时**评估误差掉得远慢于棋力**：
   512 的整体评估差是 357 内部单位，64 是 598（只差 1.7 倍），棋力却从 −158 掉到 −325
   （两倍多）。棋力对评估的**排序质量**敏感，不是对绝对误差敏感。
2. **64 是引擎允许的最小宽度**：L1=32 会在 `nnue_feature_transformer.h` 的
   `ChunkSize * OrderSize must perfectly divide TotalSize` 静态断言上编译失败。
   训练器倒是能训出 32 宽的权重（loss 0.52），但引擎加载不了——**引擎是约束**。
   于是现有架构下最小的可用网是 **3.2 MB**。
3. **KB 级做不到，除非改架构**。体积 = 62,083 × L1（特征变换器，int8）
   + 32 套 layer stack 的全连接（578 KB，与宽度无关）+ 头部。所以架构地板约
   0.45 MB（zstd），而宽度地板（L1=64）是 3.2 MB，两者差了七倍。要进 KB 级只能改
   上游的评估结构（减少 layer stack 或缩小 FC），而这个项目不改上游源码。

另外那个「特征变换器清零」的参照很有用：评估退化成常数后仍只差 −552 Elo——搜索本身
还在干活，一部分战术靠搜索树而非评估。**评估真正贡献的是那 227 Elo**（−325 vs −552）。

最后一条实践结论：**L1=512（25 MB）是甜点**。再减半体积要付 60 Elo，而首屏下载本来就
只占一次；9.5 MB 的 L1=192、12.6 MB 的 L1=256 与 6.4 MB 的 L1=128 都已经测出来了，要上线
只是往 `engine.json` 的 `engines` 里加一条（构建脚本按表循环），代价是每多一套引擎就多三套
wasm。

### 分档重加权：实测是平线

`train.py --eval-weight-power 1.0`（每档总权重相同，被 target-clip 压平的最高档跟随邻档）
在同一份 59k 语料、同一 schedule、同样 20k 步下与不加权对比：

| 档 | 不加权 | 等权 | 变化 |
| --- | --- | --- | --- |
| 0–100 | 41.9 cp | 40.6 cp | −3% |
| 100–300 | 54.6 cp | 52.4 cp | −4% |
| 300–700 | 62.4 cp | 61.6 cp | −1% |
| 700–1500 | 56.6 cp | 57.2 cp | +1% |
| 1500–4000 | 52.1 cp | 54.0 cp | +4% |
| 整体 | 55.4 cp | 55.7 cp | +0.5% |

均势段拿到 3–4%，决胜段还回去 1–4%，**总量不动**。这说明限制来自 L1=512 的容量，
不是损失函数把注意力放错了地方；重加权只是把误差从一档挪到另一档。

### 用搜索分当目标：更弱（负结果）

假设：教师下棋依据的是搜索分而不是静态评估，那么让学生模仿搜索分，应该更像
「教师会怎么走」。实验用同一份 49,709 个正常自对弈局面、同一 schedule（20k 步、
batch 1024、热启动、L1=512），只差回归目标：

| 目标 | 训练 loss | 对局 300 局（4000 节点） | Elo | 评估保真度（`all.bin`） |
| --- | --- | --- | --- | --- |
| 教师的静态评估 | 0.0026 | 44 胜 84 平 172 负（0.287） | **−158** | 357 内部单位，相关 0.970 |
| 教师的搜索分（4000 节点） | 0.036 | 33 胜 83 平 184 负（0.248） | **−192** | 404 内部单位，相关 0.957 |

搜索分这个目标宽得多（|均值| 582 cp，静态评估只有 134 cp），也更容易被固定节点
搜索自身的噪声带偏；同样的容量拟合得更差，均势段从 16.5 cp 掉到 24.1 cp，棋力掉
34 Elo。**结论：不追这条路。**（本机这组 50k 局面的静态目标基线是 −158 Elo，
而 Kaggle 上 193 万局面的同一配方是 −109 Elo，差值就是数据量。）


### 棋力：评估误差不是棋力

54 cp 的评估误差不能直接换算成棋力，真正决定棋力的是搜索实际选出的着法，所以另写
两个工具直接量。

**每步代价**（`compare_engines.py`）：每个局面让两个引擎各搜 4000 节点拿到自己的最佳
着法，再让**教师**分别评估「学生走的那步」和「教师走的那步」，两个值相减就是学生在
教师眼里丢掉的价值（配对比较，搜索噪声与系统性偏差一并抵消）：

| 样本 | 局面数 | 着法一致 | 每步代价（均值 / 中位 / p90） |
| --- | --- | --- | --- |
| 正常对局第一批 | 760 | 61.2% | +4.2 / +1.0 / +27 cp |
| 正常对局第二批 | 1,198 | 61.4% | +7.1 / +1.0 / +29 cp |
| 噪声地板（教师自己的着法） | — | — | +1.8 / 0.0 cp |

**固定节点对局**（`match_engines.py`）：从自对弈局面出发、轮换先手，每步固定节点：

| 对局 | 局数 | 学生 | 得分率 | Elo |
| --- | --- | --- | --- | --- |
| 学生 25 MB vs 教师 50 MB（2,000 节点） | 200 | 32 胜 66 平 102 负 | 0.325 | −127 |
| 学生 25 MB vs 教师 50 MB（4,000 节点） | 300 | 40 胜 129 平 131 负 | 0.348 | −109 |
| 学生 25 MB vs 教师 50 MB（20,000 节点） | 120 | 21 胜 53 平 46 负 | 0.396 | −73 |
| 对照：教师 vs 教师（同一张网，4,000 节点） | 120 | 21 胜 71 平 28 负 | 0.471 | −20（噪声内） |

对照组说明 harness 没有系统性偏差（−20 ± 33 Elo 落在噪声里），于是
**25 MB 的学生网比 50 MB 的教师网弱约 90–110 Elo**（4000 节点、300 局的标准误约 ±21 Elo）。
差距随搜索深度收窄（−127 → −109 → −73），这与「评估噪声被搜索平均掉」一致。

对局是用自对弈局面开局、Python 侧跟踪棋盘判和棋（三次重复、六十回合），困毙按象棋
规则判负；跟踪器与引擎自己的 `d` 输出逐手比对过 398 个位置，零差异，所以和棋判定
是可信的。


## 产物：200k 步那一轮的学生网

| 项 | 值 |
| --- | --- |
| 文件 | `student.nnue`（zstd 帧，引擎可直接加载） |
| 大小 | 25,136,309 B（plain 32,389,946 B） |
| SHA-256 | `ac223f6d20e8db0ec0ecf64b8955a834086e3eb329d52908c0730fdfba5dc97f` |
| L1 / stacks / 特征 | 512 / 32 / 62,083 |
| arch hash | `0x63337196`　ft hash `0x6e62dc8c`　header `0x0d51ad1a` |

导出复核 1200/1200 精确、引擎复核 4,000 局面 worst \|delta\| 0。这张网是 **L1=512**，
教师的 50 MB 网是 L1=1024，两者互不兼容（arch hash 不同，引擎会拒绝加载）——要给它
出 wasm，需要另编一套 L1=512 的引擎。

本机留了两份：`training/out/student-l1-512-200k.nnue`（上面这张）和
`training/engine/build-512/src/pikafish.nnue`（同宽引擎旁边的副本，方便直接对局）。
两者都在 gitignore 里；权威副本是 Kaggle kernel `mccarron/pikafish-js-distill` 的输出，
用 `kernels output --file-pattern "student\.nnue$"` 取回，SHA-256 应当等于上面那串。

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
    label_search.py     用教师的搜索分给局面打标（与静态评估并列的第二种目标）
    compare_nets.py     两个网络在同一批局面上的评估差异（--bands 可分档）
    compare_engines.py  两个引擎在同一批局面上的每步代价（教师视角的「悔棋」）
    match_engines.py    两个引擎的固定节点对局，量 Elo（含和棋判定与棋盘跟踪）
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

### dump 会丢掉一部分局面，所以它同时写下自己收下的 FEN

引擎拒绝两种局面：非法 FEN，以及**轮到走方正被将军**的局面（网络对后者没有定义，
引擎从不直接评估）。实测 53,541 个自对弈局面里有 3,832 个属于后者（7.2%）。

所以 `pikafish-dump` 现在会额外写一个 `<out>.bin.fens.txt`，里面是**它真正写进
dump 的那些 FEN、顺序一致**。没有它，任何按局面打标的旁路数据（搜索分、胜负、
人工标注）都会和特征错位——这也是 `label_search.py` 能对上号的前提。

## Kaggle

配额是每周约 30 GPU 小时（2×T4 或 1×P100，单次 12 小时）。`run.py` 分六个阶段，
每个阶段完成后在 `PIKAFISH_WORK` 留一个 `.阶段.done` 标记，同一会话内重跑会跳过
已完成的阶段（训练阶段用 `--resume` 读回 `student.pt`）。每次 push 都是新会话，
`/kaggle/working` 从空开始，所以单次步数要控制在 12 小时以内。

不需要数据集：kernel 只上传 `training/kaggle/`，`run.py` 会自己克隆仓库、按
`engine.json` 浅取钉住的上游源码、下载并校验教师网络。旋钮放在随 kernel 上传的
`kernel-params.json` 里（Kaggle 不给脚本传参数或环境变量）。

```bash
./training/kaggle/kaggle.ps1 quota                # 读配额，不消耗
./training/kaggle/kaggle.ps1 kernels push -p training/kaggle
./training/kaggle/kaggle.ps1 kernels output mccarron/pikafish-js-distill -p training/out/kaggle
```

详见 `kaggle/README.md`。主要变量：`PIKAFISH_REPO`、`PIKAFISH_WORK`、`PIKAFISH_NET`、
`PIKAFISH_HALF`、`PIKAFISH_STEPS`、`PIKAFISH_GEN_MINUTES`、`PIKAFISH_STAGES`（只跑其中
几个阶段）、`PIKAFISH_FORCE=1`（忽略标记重跑）。本机冒烟时可以配合
`PIKAFISH_GEN_GAMES`、`PIKAFISH_ENGINE`、`PIKAFISH_TEACHER_TOOL`、
`PIKAFISH_STUDENT_TOOL` 指向已经编好的二进制，跳过 `build` 阶段。

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

1. **训练这条线到此为止**，三条路都试过了：
   - 加数据加步数：63 → 55 → 54.3 cp，已经平了（L1=512 的容量是硬约束）；
   - 按 |eval| 分档重加权：平线（±4%，总量不动）；
   - 改用教师的搜索分当目标：更弱（−34 Elo）。
   要再往下走只有换宽度或换特征，不是调参。
2. **25 MB 网已经上线（v0.2.0）**：demo 侧加了「网络」选择器（强力 / 精简），默认精简；
   引擎包加了 `variants`（网与构建成对选择），并另编了一套 L1=512 的 wasm。
   首屏下载 50 MB → 25 MB，代价是约 −109 Elo（对人类玩家无感知）。
   蒸馏网随 release 发布（`pikafish-lite.nnue`，SHA-256 钉在 `engine.json`）。
3. **还没试过的**：更小的宽度。L1=384 约 19 MB、L1=256 约 12 MB，但 384 不是 32 的整数倍
   会让 `L1/2` 成对乘积与 SIMD 填充分歧，需要先确认 `PaddedInputDimensions` 的行为；
   256 是 32 的倍数，可以用现成的配方直接试。

## 风险与已知缺口

- **没有公开的象棋训练集**，官方训练代码仓库已 404，只能自己攒数据。
- **长捉 / 重复局面**：v0.1 的规则包对长捉按和棋处理，若将来引入真实棋谱，
  标签会带上这层偏差。
- **Kaggle 侧已实测**：Linux 构建、`link_dump_tool` 的参数回退、导出复核都跑通了，
  最长一轮 213 分钟。仍未验证的是跨会话续训——每次 push 都是新会话，
  `/kaggle/working` 从空开始，训练阶段要一次跑完（`PIKAFISH_TRAIN_MINUTES` 兜底）。
- **学生网比教师弱约 100 Elo（固定节点对局，300 局）**：这是本文档唯一一条与棋力
  有关的结论，且只对「双方同样的节点数」成立——教师网更大、每节点更慢，
  在同样的*时间*预算下差距会缩小。**demo 继续用教师网**，本文档不宣称学生网可替换。
- 本机训练吞吐受 Python 取数限制，必要时把 `collate` 换成
  `IterableDataset` + 后台预取（实测单分片常驻内存时能到 35k 局面/秒）。
