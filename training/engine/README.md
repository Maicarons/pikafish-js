# 编译导出工具（dump tool）

`dump_tool.cpp` 把 FEN 列表变成训练数据（PKFD v2）：两个视角的活跃特征索引、layer
stack bucket、以及引擎自己的内部评估。它**不修改上游源码**，而是链接引擎已经编好的
目标文件（除 `main.o` 外的全部），因此特征提取与评估用的是引擎的实现本身。

## 两条编译路径

| 用途 | 网络宽度 | 命令 |
| --- | --- | --- |
| 教师（标注数据） | L1=1024（官方） | `bash training/engine/build.sh` |
| 学生（验证导出的学生网能加载） | L1=学生宽度 | `SRC=<L1 树> OUT=<工具名> bash training/engine/build.sh` |

学生宽度的那棵树需要复制一份 `upstream/src`，并把 `nnue/nnue_architecture.h` 里的
`L1 = 1024` 改成目标宽度——哈希与特征维度都和 `L1` 绑死，官方引擎**无法**加载更窄的网。
`training/kaggle/run.py` 的 `build` 阶段自动做这件事（复制到工作目录再打补丁）。

## 手工编译（一步到位）

```bash
# 1. 引擎目标文件（几分钟）
cd upstream/src && make -j4 build ARCH=x86-64

# 2. 链接工具（只编译 dump_tool.cpp 本身）
g++ -std=c++17 -O2 -DNDEBUG -DIS_64BIT -DUSE_SSE2 -msse2 -DARCH=x86-64 -flto \
    -I upstream/src training/engine/dump_tool.cpp \
    $(ls upstream/src/*.o | grep -v main.o) \
    -o training/engine/pikafish-dump -lpthread
```

若链接报 `undefined reference to omp_*`，加上 `-fopenmp`；报 `pthread` 相关则以
`-static -lpthread` 代替。`build.sh` 与 `run.py` 都会依次尝试这些组合，并在链接成功后
用 `inspect` 验证二进制能跑。

## 用法

```bash
# 标注：FEN 列表 + 网络 -> PKFD v2
training/engine/pikafish-dump dump assets/pikafish.nnue training/data/fens.txt training/data/all.bin

# 看一眼网络头（维度、哈希、L1）
training/engine/pikafish-dump inspect assets/pikafish.nnue
```

输出示例（学生网）：

```
net:  pikafish.nnue (30MiB, (62083, 512, 32, 32, 1))
ft_hash 6e62dc8c  arch_hash 63337196  l1 512  stacks 32
```

`dump` 会跳过非法局面（例如被将军的一方该走子），并在末尾打印
`wrote N positions, skipped M`。实测约 22.6k 局面/秒（单线程，教师宽度）。

## 注意

- 引擎遇到**非法 FEN 会直接退出**（exit 1，`CRITICAL ERROR ... King can be captured`），
  而不是忽略该局面；`selfplay.py` 会重启引擎并保留已采样的局面。
- 工具需要 `pikafish.nnue`（或显式传入的网络路径）才能计算评估；只取特征时也必须给一个
  同宽的网络。
- 上游的目标文件已经用 `-flto` 编译，链接时不能丢掉 `-flto`。
