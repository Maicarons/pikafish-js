# 在 Kaggle 上跑训练

`run.py` 已在本机全程跑通（见 `../README.md` 的耗时表）。这里只写 Kaggle 侧需要的
准备，以及被 12 小时上限打断后怎么续。

## 1. 数据集里必须有什么

`run.py` 会从 `PIKAFISH_REPO` 读取下面这些，`upstream/` 和 `assets/` 都在
`.gitignore` 里，**只 `git clone` 是不够的**：

| 路径 | 来源 |
| --- | --- |
| `upstream/src/` | 钉住提交 `545c4e3b` 的 Pikafish 源码 |
| `assets/pikafish.nnue` | 官方教师网络，50,241,100 B，SHA-256 `bf398271…73ac` |
| `training/` | 本目录 |

## 2. 打包数据集

在本机仓库根目录操作（`upstream/` 与 `assets/` 已经存在的前提下）：

```bash
STAGE=~/pikafish-source
mkdir -p "$STAGE"
git archive HEAD | tar -x -C "$STAGE"      # 仓库里的源码（含 training/）
cp -r upstream assets "$STAGE"/            # 两个被 gitignore 的输入

cat > "$STAGE/dataset-metadata.json" <<'JSON'
{
  "title": "pikafish-js source",
  "id": "maicarons/pikafish-js-source",
  "licenses": [{ "name": "AGPL-3.0" }]
}
JSON

kaggle datasets create -p "$STAGE"         # 之后更新用 datasets version -p "$STAGE" -m "..."
```

数据集体积约 60 MB（源码 2 MB + 教师网络 50 MB），远低于上限。

## 3. 指向数据集并启动

在 `kernel-metadata.json` 里加一行数据集来源：

```json
"dataset_sources": ["maicarons/pikafish-js-source"]
```

Kaggle 把数据集挂在 `/kaggle/input/<slug>`，而工作目录必须是可写的，所以在 kernel
开头设两个环境变量（写在 kernel 的 `run.py` 顶部，或改用 Kaggle 的 Variables）：

```python
import os
os.environ.setdefault("PIKAFISH_REPO", "/kaggle/input/pikafish-js-source")
os.environ.setdefault("PIKAFISH_WORK", "/kaggle/working/train")
```

启动与取回：

```bash
kaggle kernels push   -p training/kaggle
kaggle kernels status maicarons/pikafish-js-distill
kaggle kernels output maicarons/pikafish-js-distill -p training/out/kaggle
```

## 4. 阶段、耗时与配额

配额约 30 GPU 小时/周，单次 12 小时。六个阶段各自留有 `.阶段.done` 标记，重跑时
已有的阶段直接跳过；训练阶段用 `--resume` 读回 `student.pt`（每 2000 步落盘）。

| 阶段 | 参考耗时 | 说明 |
| --- | --- | --- |
| build | 5–10 分钟 | 教师（L1=1024）与学生（L1=512）两棵树各编一次 |
| positions | 20 分钟（默认） | 六个配方，见 `../README.md` |
| label | 约 1 分钟 / 百万局面 | 教师标注，22.6k 局面/秒（单线程） |
| shards | 不到 1 分钟 | |
| train | 看 `PIKAFISH_STEPS` | 本机 21k 局面/秒；T4 预计 5–15k |
| export | 约 1 分钟 | 含写盘、回读校验、引擎复核 |

默认步数是 200,000（约 2 亿局面样本量级），明显超过一次 12 小时的额度：这正是
断点续训的用途。建议先跑小步数确认环境。

## 5. 建议的第一次运行（验证环境，约 30 分钟）

```python
os.environ["PIKAFISH_GEN_GAMES"] = "150"   # 每个配方 150 局，替代时间预算
os.environ["PIKAFISH_STEPS"] = "2000"
```

这一步应当产出 `/kaggle/working/train/report.json`、`student.nnue`，并在日志里看到
三行关键输出：

```
verified 600 positions against the written net: 600 exact, 0 bad
engine check: 4000 positions, worst |delta| 0, mismatches 0
bestmove ...
```

第二行是「导出的学生网与模型完全一致」，第三行是「L1=512 引擎真的载入并搜索了」。

确认无误后再去掉这两个变量放开长跑；中途被切断就再 `push` 一次。

## 6. 常见问题

- **`no teacher net at …`**：数据集的目录结构不对，`assets/pikafish.nnue` 必须在
  `PIKAFISH_REPO` 下面。
- **`expected exactly one L1 = 1024`**：上游源码版本不对，`nnue/nnue_architecture.h`
  里没有唯一的 `L1 = 1024`（换回了别的提交）。
- **链接失败**：`link_dump_tool` 会依次尝试 `-lpthread`、`-fopenmp -lpthread`、
  `-static …` 四种组合，日志会打印每次的错误；Kaggle 的 g++ 通常第二种就够。
- **训练很慢**：先把 `PIKAFISH_BATCH` 调到 512/1024 之间试，取数（`collate`）是
  Python 侧瓶颈，必要时改成 `IterableDataset` 预取。
