# 在 Kaggle 上跑训练

`run.py` 已在本机全程跑通（见 `../README.md` 的耗时表）。Kaggle 侧不需要数据集，
也不需要手工设环境变量：把 `training/kaggle/` 这个目录推上去就能跑。

## 1. 上传的内容只有这个目录

`kaggle kernels push -p training/kaggle` 会把该目录里的文件作为 kernel 源码上传，
所以 `run.py` 自己把缺的东西补齐（`PIKAFISH_WORK` 默认 `/kaggle/working/train`）：

| 缺什么 | 怎么补 | 依据 |
| --- | --- | --- |
| 仓库本身 | `git clone --depth 1` 公开仓库到 `<work>/repo` | 本次 push 的分支 |
| `upstream/src/` | 浅取钉住的提交到 `<repo>/upstream` | `engine.json` 的 `upstream.commit` |
| `assets/pikafish.nnue` | 下载后按大小与 SHA-256 校验 | `engine.json` 的 `net` |

这三步都是幂等的：本机跑时三者都在，脚本直接跳过。好处是**改代码只需要再 push**，
不必为每次改动重新版本化一个 60 MB 的数据集。

拉了源码之后不会打补丁：`patches/` 里那份是给 wasm 用的，原生编译用的是干净树。

## 2. 旋钮在 `kernel-params.json`

Kaggle 运行脚本时既不给参数也不给环境变量，所以旋钮放在 `kernel-params.json` 里。
查找顺序是：`run.py` 同目录 → 当前工作目录 → **克隆下来的仓库里的副本**。最后一条
才是实际生效的那条，因为 Kaggle 并不保证把上传的其它文件放在脚本旁边；环境变量始终
优先，本机冒烟就是靠这个覆盖的。找不到任何一份时用内置默认值，日志会写
`params none, built-in defaults`。

| 键 | 含义 | 首次运行值 |
| --- | --- | --- |
| `PIKAFISH_HALF` | 学生 L1，教师是 1024 | 512 |
| `PIKAFISH_GEN_MINUTES` | 生成局面的总时长，六个配方平分 | 12 |
| `PIKAFISH_STEPS` | 训练步数 | 20000 |
| `PIKAFISH_BATCH` / `PIKAFISH_LR` | 批大小 / 学习率 | 1024 / 0.001 |
| `PIKAFISH_SAVE_EVERY` | 每多少步落盘（后可 `--resume`） | 2000 |
| `PIKAFISH_EVAL_WEIGHT` | 按 \|eval\| 分档重加权：0 关闭，1.0 每档等权 | 0 |
| `PIKAFISH_TRAIN_MINUTES` | 训练阶段最多跑多久，保证 export 还能执行 | 540 |

改完 `PIKAFISH_STEPS` 再 push 一次就是长跑。实测吞吐 29.7k 局面/秒，200k 步约 2 小时，
`TRAIN_MINUTES` 只是兜住 12 小时上限。

Python 阶段都用 `-u` 启动，日志会实时出现；否则 Kaggle 按块缓冲，训练期间看不到
任何输出。

## 3. 启动与取回

```bash
# 先确认 token 可用（读配额，不消耗）
./training/kaggle/kaggle.ps1 quota

# 推上去；进度用 status / logs 看
./training/kaggle/kaggle.ps1 kernels push -p training/kaggle
./training/kaggle/kaggle.ps1 kernels status mccarron/pikafish-js-distill
./training/kaggle/kaggle.ps1 kernels logs   mccarron/pikafish-js-distill

# 跑完后取回 student.nnue / report.json / student.pt
./training/kaggle/kaggle.ps1 kernels output mccarron/pikafish-js-distill -p training/out/kaggle
```

（`kaggle.ps1` 只是把仓库根目录的 `.env` 读进环境再转发给 `kaggle`；直接 `kaggle …`
也行，前提是环境里已有 `KAGGLE_API_TOKEN` 或已经 `kaggle auth login`。）

## 4. 阶段、耗时与配额

配额约 30 GPU 小时/周，单次 12 小时。六个阶段各自留 `.阶段.done` 标记，同一会话
内重跑会跳过已完成的阶段；训练阶段每 `SAVE_EVERY` 步写 `student.pt`，可 `--resume`。

| 阶段 | 参考耗时 | 说明 |
| --- | --- | --- |
| build | 5–10 分钟 | 教师（L1=1024）与学生（L1=512）两棵树各编一次 |
| positions | 按 `GEN_MINUTES` | 六个配方，见 `../README.md`；缺 bucket 会直接失败 |
| label | 约 1 分钟 / 百万局面 | 教师标注，22.6k 局面/秒（单线程） |
| shards | 不到 1 分钟 | |
| train | 看 `PIKAFISH_STEPS` | 本机 21k 局面/秒；Kaggle GPU 实测 **29.7k 局面/秒**（batch 1024），200k 步约 2 小时 |
| export | 约 1 分钟 | 写盘、回读校验、引擎复核 |

注意每次 push 都是**新的会话**，`/kaggle/working` 从空开始，所以跨会话续训不是
自动的；这也是建议把单次步数控制在上限内的原因。

## 5. 建议的第一次运行（约 1 小时）

就用仓库里 `kernel-params.json` 当前的值（20000 步）。日志里应当出现三行关键输出：

```
verified 600 positions against the written net: 600 exact, 0 bad
engine check: 4000 positions, worst |delta| 0, mismatches 0
bestmove ...
```

第二行是「导出的学生网与模型完全一致」，第三行是「L1=512 引擎真的载入并搜索了」。
产物在 `/kaggle/working/train/`：`report.json`、`student.nnue`、`student.pt`。

确认无误后把 `PIKAFISH_STEPS` 改成 200000 再 push。

## 6. 常见问题

- **要换参数或会话卡住了**：CLI 没有 cancel 子命令，直接
  `./training/kaggle/kaggle.ps1 kernels delete mccarron/pikafish-js-distill` 再 `push` 重建；
  删除会连会话一起结束，比等它跑完快得多。
- **日志第一段先核对**：`params <路径>` 必须是克隆仓库里的那份，后面跟着
  `steps` / `gen` / `batch`。这行缺失或写着 `built-in defaults`，说明参数没读到，
  此时 `steps` 会是 200000——v1 就是这样白跑了 59,500 步。
- **`git clone` 失败或拉不到 `upstream`**：kernel 的 Internet 必须是开的
  （`kernel-metadata.json` 里 `enable_internet: true`）。
- **缺 `zstandard`**：Kaggle 镜像是 Python 3.11，标准库没有 zstd；`run.py` 一开始
  会自己 `pip install zstandard`，日志里有 `zstd: installing zstandard` 就对了。
- **`net mismatch: … bytes / …`**：下载被截断；删掉 `.part` 重跑即可，脚本不会
  把校验失败的文件留在原位。
- **`expected exactly one L1 = 1024`**：上游源码版本不对，`nnue/nnue_architecture.h`
  里没有唯一的 `L1 = 1024`（`engine.json` 的提交被改回了别的）。
- **链接失败**：`link_dump_tool` 会依次尝试 `-lpthread`、`-fopenmp -lpthread`、
  `-static …` 四种组合，日志会打印每次的错误；Kaggle 的 g++ 通常第二种就够。
- **训练很慢**：先把 `PIKAFISH_BATCH` 调到 512/1024 之间试，取数（`collate`）是
  Python 侧瓶颈，必要时改成 `IterableDataset` 预取。
