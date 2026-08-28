# Current UniSVQ contract

**Binding date:** 2026-08-29  
**Official source reviewed:** [`AI9Stars/UniSVQ@449e8e4f31`](https://github.com/AI9Stars/UniSVQ/tree/449e8e4f317d2c539d7135c39f66817adce3cf4c) (2026-07-13)  
**Papers:** [UniSVQ v2](https://arxiv.org/abs/2606.10520), [LC-QAT v2](https://arxiv.org/abs/2606.10531)

This document supersedes any local wording that describes UniSVQ as scalar
rounding, a file conversion, a packed UInt2 format, Hessian-only LDLQ, or a
training-free near-lossless compressor. Historical receipts remain evidence of
what was run; this contract controls current terminology and promotion claims.

## One-sentence truth

A quality-bearing UniSVQ artifact is produced by calibrated vector assignment
and reconstruction optimization. Its 2-bit coordinate stream is only the final
storage operand. Packing or contracting those coordinates does not produce the
model.

## The four levels that must stay separate

### 1. Coordinate payload

For paper defaults `b=2`, `d=4`, every four-weight group is represented by
`q in {0,1,2,3}^4`. Four base-4 coordinates fit in one byte, so the coordinate
payload is 2 bits per original weight. A UInt8 group index and four packed
UInt2 coordinates are equivalent encodings of the same 256 possibilities.

This is **vector-indexed storage**, not proof of vector quantization quality.
If reconstruction factorizes coordinate by coordinate, it remains a separable
grid despite the four-coordinate container.

### 2. PTQ assignment initialization

A real initializer needs model data and work:

1. capture activation second moments per projection (per expert for MoE),
2. apply two-sided randomized Hadamard incoherence and signs,
3. block-factor the Hessian,
4. run reverse-order LDLQ with residual/error feedback,
5. iterate assignment tuning,
6. save assignments, signs/scales, and exact transform metadata.

Torchio currently implements this level with `Index_codebook`, FP64 moment
capture, block LDLQ, 10 sweeps, and `scale_override=0.83`. That is a strong
QuIP-style vector-indexed PTQ initializer. It is actual quantization work, not
a format conversion.

### 3. UniSVQ block reconstruction

The UniSVQ paper adds per-Transformer-block reconstruction optimization after
all block projections are assigned. Quantized-prefix activations feed the
student block; the corresponding high-precision block output is the target.
The paper uses a 7:1 train/validation split, MSE, batch 16, LR `5e-5`, up to
five epochs, and early stopping.

The paper's representation is a genuinely nonseparable per-matrix affine
lattice:

```text
w_hat_g = A q_g + B,  A in R^(4x4), B in R^4
```

The 4x4 `A` couples coordinates, which is the vector capacity. Native UInt2
matmul alone computes contractions with `q`; runtime must also apply the
trained affine map and Hadamard/scaling transforms without materializing BF16
weights.

### 4. LC-QAT continuation

LC-QAT starts from a high-quality PTQ initializer and continues training under
language-model loss through hard low-bit weights and a differentiable gradient
estimator. This is end-to-end QAT, not block reconstruction and not
calibration-only PTQ.

Published main runs consume about 4B tokens. The later official repository
reports approximately 8B-token continued training and a separate approximately
8B conversational run. The reported near-FP16 Qwen3-1.7B result therefore came
from substantial training. It cannot support a claim that a new 27B model will
retain quality after a short conversion.

## Paper versus current official repository

The July repository is a later deployment-oriented implementation, not a
byte-for-byte implementation of the paper:

| Surface | Paper | `AI9Stars/UniSVQ@449e8e4` |
|---|---|---|
| Hadamard | full-dimension two-sided RHT | independent 128x128 blocks for HadaQuant |
| PTQ code family | affine `Aq+B` vector lattice | default `--codebook identical`, separable centered grid |
| PTQ trainables after assignment | affine grids/block reconstruction | `SU/SV` plus remaining trainable block params; codebook projection buffers fixed |
| QAT trainables | affine/proxy formulation in paper | latent proxy weights + `SU/SV`; checked-in codebook scale/zero frozen |
| QAT data | mainly 4B tokens | README reports later ~8B runs; actual tokens depend on world size |
| Runtime | integer-compatible affine decode | CUDA HadaQuant, block-128 transforms |

The repository README calls the update a "linear codebook." The pinned code is
the authority: do not infer a trained 4x4 matrix where the selected path uses a
fixed separable projection.

## Torchio status, exact

Implemented and tested:

- model adapters and projection classification,
- canonical calibration reader/builder,
- FP64 activation moments and MoE per-expert coverage,
- two-sided Hadamard incoherence,
- 4-coordinate Hessian-aware block LDLQ and assignment sweeps,
- BF16 reconstruction for probes,
- experimental true-affine modules (`AffineUniSVQLinear`, `AffineE8Coord2`),
- native Metal proof of packed UInt2 contraction and a simple affine epilogue.

Missing from the production runner:

- official per-block reconstruction fine-tuning,
- a trained nonseparable `4x4 A+B` path wired through all projections,
- official block-128 transform parity in the default runner and artifact,
- LC-QAT continuation,
- a packed artifact carrying every trained decoder parameter,
- a native runtime lowering of the complete trained vector operator,
- full-model quality evidence for any completed all-layer artifact.

Therefore current Torchio output must be called **Hessian-aware 2-bit
vector-indexed LDLQ initialization** until the missing training stages pass.
Do not label it a complete trained UniSVQ model.

## Best current route for Qwen3.8-27B

Quality-first route:

1. Build the exact Qwen3.8 hybrid text + MTP teacher and source-disjoint
   reasoning-rich calibration corpus.
2. Produce a paper/current-upstream matched PTQ bakeoff:
   - paper affine `Aq+B` + full RHT,
   - current official separable grid + block-128 RHT,
   - Torchio affine-E8 candidate.
3. Capture both activation covariance and an output-gradient covariance pilot.
   [KronQ](https://github.com/Intelligent-Computing-Lab-Panda/KronQ/tree/c1f84d2f556a2906bd8ac8e0faebe42a9faaf10b)
   shows that output curvature and bidirectional incoherence can rescue W2
   scalar PTQ. It is an initializer experiment, not a drop-in UniSVQ or Qwen
   implementation.
4. Run official block-output reconstruction for all 64 blocks and the MTP
   block, with held-out validation and sequential activation propagation.
5. Run a bounded LC-QAT campaign. Start with a measured pilot, but treat the
   official 4B-token paper run and later ~8B-token repo run as the quality
   reference, not as optional decoration.
6. Promote only from full-model perplexity/KL, reasoning, code, instruction,
   long-generation, and MTP acceptance evidence.
7. Pack and lower the exact winner to Metal. UInt2 is the coordinate operand;
   it cannot choose assignments or learn the vector decoder.

## Other vector/lattice methods reviewed

- **Leech Lattice VQ** ([arXiv:2603.11021](https://arxiv.org/abs/2603.11021)):
  true 24D structured lattice and strong research direction. The current
  independent implementation at
  [`pjmalandrino/llvq@209a695`](https://github.com/pjmalandrino/llvq/tree/209a69587814858554b7492d2f17b62a80d1dbaa)
  reports QTIP-level rather than decisively better normalized quality at 2.17
  bpw on Qwen3-4B; CUDA fused runtime exists, macOS fused runner does not.
  Keep as a bakeoff lane.
- **Grouped learned lattices** ([GLVQ](https://github.com/xzhang9308/GLVQ)):
  learn group-specific generation matrices with Babai rounding. Relevant to
  decoder capacity, but older and without a proven Apple/Qwen3.8 path.
- **KronQ** ([arXiv:2607.07964](https://arxiv.org/abs/2607.07964)):
  fresh output-curvature/BiIP evidence and real packed W2 artifacts. Its public
  models are Llama and its runtime is scalar int2; adapt its curvature signal,
  not its artifact format.
- **QUASAR** ([arXiv:2608.13966](https://arxiv.org/abs/2608.13966)):
  fresh QAT evidence for continuously refreshed saliency-weighted affine
  reconstruction, reporting 29% lower held-out KL at 2 bits versus named
  baselines. Relevant to the QAT optimizer, pending code and a vector-aware
  adaptation.
- **RRQ** adds residual precision layers to an existing 2-bit base. It does not
  improve the base initializer and is outside the laptop-size target.

## Claim checklist

Before writing "UniSVQ" for an artifact, record:

- exact upstream or local algorithm revision,
- coordinate dimension and bits,
- separable grid or nonseparable trained decoder,
- transform scope (full or block-128), signs, `SU/SV`, and decoder metadata,
- calibration identity and token count,
- Hessian and (if used) output-curvature identity,
- block-reconstruction schedule and validation result,
- QAT tokens, steps, world size, trainable parameter set, and objective,
- packed physical bytes including metadata,
- runtime path with no BF16 shadow,
- full-model quality and speed receipts.

If those fields are absent, use a narrower term such as "packed UInt2
transport," "fixed-grid LDLQ initializer," or "UniSVQ-family experiment."
