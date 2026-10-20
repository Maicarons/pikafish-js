"""Student network: the engine's NNUE architecture, in float, with its own L1.

The engine is the authority for this layout.  Everything below was read from the
pinned upstream commit and then verified two ways:

* `parity.py` reproduces `Network::evaluate` unit for unit on 15k positions
  covering all 32 layer stacks.
* `parity_float.py --quantized` reproduces it *exactly* through this module, and
  `nnue_io.write_net` reproduces the official file byte for byte.

Engine forward pass, with `HalfDimensions = L1` (see `nnue_feature_transformer.h`,
`nnue_architecture.h`, `layers/*.h`):

    acc[p] = ft_bias[p] + sum(ft_weight[f][p] for f active for p)     # i16
    x[j]   = clamp(acc[j], 0, 255) * clamp(acc[j + L1/2], 0, 255) >> 9  # j < L1/2
    feat   = concat(x(stm), x(opponent))                              # L1 values
    o0     = fc0(feat) + b0                                           # 32, i32
    t0     = clamp(o0, -32768, 32767)                                 # packs_epi32
    sqr0   = clamp(t0*t0 >> 21, 0, 127)        # SqrClippedReLU(WeightScaleBits+1)
    clip0  = clamp(t0 >> 7, 0, 127)            # ClippedReLU(WeightScaleBits+1)
    o1     = fc1(concat(sqr0, clip0)) + b1                            # 32
    t1     = clamp(o1, -32768, 32767)
    sqr1   = clamp(t1*t1 >> 19, 0, 127)
    clip1  = clamp(t1 >> 6, 0, 127)
    o2     = fc2(concat(sqr0, clip0, sqr1, clip1)) + b2               # 1, sees all 128
    fwd    = o2 + o0[30] - o0[31]                                     # skip, raw i32
    value  = trunc(fwd * (600*16) / (128 * 64 * 2))
    score  = trunc(value / 16)

Three traps, all of them caught by the parity checks: the pairwise product clamps
the accumulator to **255**, not 127; `fc_2` consumes *both* layers' activations
(128 inputs) while `fc_1` sees only `fc_0`'s 64; and the skip connection takes the
raw i32 `fc_0` output, before the i16 saturation.

Why quantisation is in the forward pass
--------------------------------------
With i8 weights and integer features every intermediate value in the engine is an
exact integer, and the discretisation is *not* small: the teacher's feature
transformer has `std(w) = 21.8` over ~50 active features, so rounding `x` to an
integer moves `fc_0`'s input sum by ~100 activation units.  A model trained on the
smooth relaxation would be optimised for a different function than the one the
engine evaluates.

So the parameters live in the engine's own units and the forward pass is the
engine's arithmetic with straight-through estimators on the roundings
(`quantized=True`, the default for training).  `export.py` then only has to round
and clip.  Pass `quantized=False` for the smooth relaxation, which is what
`debug_float.py` uses to show where the two disagree.
"""

from __future__ import annotations

import torch
from torch import nn
from torch.autograd import Function

# Features::FullThreats::Dimensions + Features::K6R2NC2::Dimensions.
THREAT_FEATURES = 45_547
PSQ_FEATURES = 6 * 4 * 689  # 16_536
FT_FEATURES = THREAT_FEATURES + PSQ_FEATURES  # 62_083

HALF_DIMENSIONS = 1024  # L1 of the teacher; the student runs at 512
FT_MAX = 255  # accumulator clamp before the pairwise product
HIDDEN_MAX = 127  # int8 activation ceiling
I16 = 32767
L2 = 32
L3 = 32
LAYER_STACKS = 32
FC1_IN = L2 * 2
FC2_IN = L2 * 2 + L3 * 2
WEIGHT_SCALE_BITS = 6
OUTPUT_SCALE = 16
HIDDEN_ONE = 128
FT_BIAS_MAX = 32767

# constant part of the final rescale: 9600 / 16384
SCORE_NUM = 600 * OUTPUT_SCALE
SCORE_DEN = HIDDEN_ONE * (1 << WEIGHT_SCALE_BITS) * 2


class _StraightThrough(Function):
    """y in the forward pass, dy/dx = 1 in the backward pass."""

    @staticmethod
    def forward(ctx, x, fn):  # noqa: ANN001
        ctx.fn = fn
        return fn(x)

    @staticmethod
    def backward(ctx, grad):  # noqa: ANN001
        return grad, None


def ste(x: torch.Tensor, fn) -> torch.Tensor:  # noqa: ANN001
    return _StraightThrough.apply(x, fn)


def _round(x: torch.Tensor) -> torch.Tensor:
    return torch.round(x)


def _floor(x: torch.Tensor) -> torch.Tensor:
    return torch.floor(x)


def _trunc(x: torch.Tensor) -> torch.Tensor:
    # C++ integer division truncates toward zero; the engine's two final
    # divisions are `/ denominator` on i64, not shifts.
    return torch.trunc(x)


def _round_clip(x: torch.Tensor, lo: int, hi: int) -> torch.Tensor:
    return torch.clamp(torch.round(x), lo, hi)


class StudentNet(nn.Module):
    """The engine's architecture with a configurable feature-transformer width.

    Every parameter is in the units the engine stores it in: the feature
    transformer and `fc_0`/`fc_1`/`fc_2` weights are int8-scale (`+/-127`), the
    biases are i32-scale, and `ft_bias` is i16-scale.
    """

    def __init__(
        self,
        features: int = FT_FEATURES,
        half: int = HALF_DIMENSIONS,
        l2: int = L2,
        l3: int = L3,
        stacks: int = LAYER_STACKS,
        dropout: float = 0.0,
    ) -> None:
        super().__init__()
        if half % 2:
            raise ValueError("half (L1) must be even: the engine folds it in pairs")
        self.half = half
        self.l2 = l2
        self.l3 = l3
        self.stacks = stacks
        self.fc1_in = l2 * 2
        self.fc2_in = l2 * 2 + l3 * 2

        # One shared bias vector: nn.EmbeddingBag's per-index bias is not what
        # the engine does.
        self.ft = nn.EmbeddingBag(features, half, mode="sum")
        self.ft_bias = nn.Parameter(torch.zeros(half))

        # Per layer stack; one is selected per position (make_layer_stack_bucket).
        self.fc0_w = nn.Parameter(torch.empty(stacks, l2, half))
        self.fc0_b = nn.Parameter(torch.empty(stacks, l2))
        self.fc1_w = nn.Parameter(torch.empty(stacks, l3, self.fc1_in))
        self.fc1_b = nn.Parameter(torch.zeros(stacks, l3))
        self.fc2_w = nn.Parameter(torch.empty(stacks, 1, self.fc2_in))
        self.fc2_b = nn.Parameter(torch.zeros(stacks, 1))
        self.dropout = nn.Dropout(dropout)
        self._init_weights()

    def _init_weights(self) -> None:
        # Scales copied from the teacher: `std(ft) = 21.8`, `std(fc0) = 15.7`,
        # `std(fc1) = 13.8`, `std(fc2) = 30.0`, and the i32 biases set the
        # operating point so the activations sit inside their clamp range.
        nn.init.uniform_(self.ft.weight, -38.0, 38.0)
        nn.init.uniform_(self.ft_bias, -30.0, 30.0)
        nn.init.uniform_(self.fc0_w, -28.0, 28.0)
        nn.init.uniform_(self.fc1_w, -24.0, 24.0)
        nn.init.uniform_(self.fc2_w, -52.0, 52.0)
        # u = (fc0(x) + b0)/128 is the value the first activation clips, so the
        # bias has to start near the middle of 0..127 rather than at zero.
        nn.init.uniform_(self.fc0_b, 500.0, 4000.0)
        nn.init.uniform_(self.fc1_b, 0.0, 1500.0)

    # -- forward -----------------------------------------------------------

    def _accumulate(
        self, indices: torch.Tensor, offsets: torch.Tensor, w: torch.Tensor, b: torch.Tensor
    ) -> torch.Tensor:
        return (
            torch.nn.functional.embedding_bag(indices, w, offsets, mode="sum") + b
        )

    def _transform(self, acc: torch.Tensor, quantized: bool) -> torch.Tensor:
        """The engine's pairwise product: clamp to 255, multiply, shift right by 9."""
        pair = self.half // 2
        lo = acc[:, :pair].clamp(0, FT_MAX)
        hi = acc[:, pair:].clamp(0, FT_MAX)
        x = lo * hi / 512.0
        return ste(x, _floor) if quantized else x

    def _dense(self, w: torch.Tensor, x: torch.Tensor) -> torch.Tensor:
        """Per-sample matmul against the layer stack each position selected."""
        return torch.bmm(w, x.unsqueeze(-1)).squeeze(-1)

    def forward(
        self,
        stm_indices: torch.Tensor,
        stm_offsets: torch.Tensor,
        oth_indices: torch.Tensor,
        oth_offsets: torch.Tensor,
        bucket: torch.Tensor | None = None,
        quantized: bool = True,
        return_internal: bool = True,
    ) -> torch.Tensor:
        """Side-to-move score, in the engine's internal units by default."""
        if quantized:
            ft_w = ste(self.ft.weight, lambda w: _round_clip(w, -128, 127))
            ft_b = ste(self.ft_bias, lambda b: _round_clip(b, -FT_BIAS_MAX, FT_BIAS_MAX))
        else:
            ft_w = self.ft.weight
            ft_b = self.ft_bias

        x = torch.cat(
            [
                self._transform(
                    self._accumulate(stm_indices, stm_offsets, ft_w, ft_b), quantized
                ),
                self._transform(
                    self._accumulate(oth_indices, oth_offsets, ft_w, ft_b), quantized
                ),
            ],
            dim=1,
        )

        if bucket is None:
            bucket = torch.zeros(x.shape[0], dtype=torch.long, device=x.device)
        bucket = bucket.long()

        def layer(w: torch.Tensor, b: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
            if quantized:
                return ste(w, lambda t: _round_clip(t, -128, 127)), ste(b, _round)
            return w, b

        w0, b0 = layer(self.fc0_w[bucket], self.fc0_b[bucket])
        o0 = self._dense(w0, x) + b0
        t0 = o0.clamp(-I16 - 1, I16)
        if quantized:
            sqr0 = ste(t0 * t0 / 2.0**21, _floor).clamp(0, HIDDEN_MAX)
            clip0 = ste(t0 / 128.0, _floor).clamp(0, HIDDEN_MAX)
        else:
            sqr0 = (t0 * t0 / 2.0**21).clamp(0, HIDDEN_MAX)
            clip0 = (t0 / 128.0).clamp(0, HIDDEN_MAX)
        c1 = torch.cat([sqr0, clip0], dim=1)

        w1, b1 = layer(self.fc1_w[bucket], self.fc1_b[bucket])
        o1 = self._dense(w1, c1) + b1
        t1 = o1.clamp(-I16 - 1, I16)
        if quantized:
            sqr1 = ste(t1 * t1 / 2.0**19, _floor).clamp(0, HIDDEN_MAX)
            clip1 = ste(t1 / 64.0, _floor).clamp(0, HIDDEN_MAX)
        else:
            sqr1 = (t1 * t1 / 2.0**19).clamp(0, HIDDEN_MAX)
            clip1 = (t1 / 64.0).clamp(0, HIDDEN_MAX)
        c2 = torch.cat([sqr0, clip0, sqr1, clip1], dim=1)

        w2, b2 = layer(self.fc2_w[bucket], self.fc2_b[bucket])
        o2 = self._dense(w2, c2) + b2

        # The skip uses fc_0's raw i32 output, before the i16 saturation.
        fwd = o2.squeeze(1) + o0[:, self.l2 - 2] - o0[:, self.l2 - 1]
        if not return_internal:
            return fwd

        if quantized:
            value = ste(fwd * SCORE_NUM / SCORE_DEN, _trunc)
            return ste(value / OUTPUT_SCALE, _trunc)
        return fwd * SCORE_NUM / SCORE_DEN / OUTPUT_SCALE

    # -- introspection -----------------------------------------------------

    @property
    def features(self) -> int:
        return self.ft.num_embeddings

    def quantized_clone_report(self) -> str:
        """Percent of each weight matrix that lands outside int8 after rounding."""
        with torch.no_grad():
            rows = [
                ("ft", self.ft.weight, 127.0),
                ("fc0", self.fc0_w, 127.0),
                ("fc1", self.fc1_w, 127.0),
                ("fc2", self.fc2_w, 127.0),
                ("ft_bias", self.ft_bias, float(FT_BIAS_MAX)),
            ]
            out = []
            for name, w, limit in rows:
                a = w.detach().abs()
                out.append(
                    f"{name:8s} mean {a.mean():8.2f} max {a.max():8.1f} "
                    f"clipped {(a > limit).float().mean().item() * 100:5.2f}%"
                )
            return "\n".join(out)

    def describe(self) -> str:
        params = sum(p.numel() for p in self.parameters())
        return (
            f"features={self.features} L1={self.half} stacks={self.stacks} "
            f"fc=({self.half})->{self.l2}->{self.l3}->1 params={params / 1e6:.2f}M"
        )
