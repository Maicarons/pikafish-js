/*
  dump_tool.cpp - training data generator for Pikafish NNUE distillation.

  This is NOT part of the shipped engine.  It links against the object files
  that the normal engine build already produced (everything except main.o) and
  uses the engine's own feature code, so the indices it writes are by
  construction the ones the engine accumulates.  Nothing here is reimplemented
  in Python, which is what makes the dataset trustworthy.

  Usage:
      pikafish-dump dump <net.nnue> <fens.txt> <out.bin>

  Input: one FEN per line, blank lines and lines starting with '#' ignored.

  Output (little-endian, version 2):
      char magic[4]   = "PKFD"
      u32  version    = 2
      u32  count
      u32  threat_dim = FullThreats::Dimensions  (45547)
      u32  psq_dim    = K6R2NC2::Dimensions      (16536)
      then `count` records of:
          u16 n_st_threat, u16 n_st_psq, u16 n_ot_threat, u16 n_ot_psq
          u32 layer_stack_bucket             which of the 32 FC stacks is used
          i32 eval_stm   internal units, side-to-move POV (network.evaluate)
          i32 cp_stm     centipawns after the engine's display scaling
          u16 indices[n_st_threat + n_st_psq + n_ot_threat + n_ot_psq]
                        (PSQ indices already offset by threat_dim)

  Positions the engine refuses (illegal FEN) are skipped and reported on
  stderr; `count` is the number actually written.
*/

#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

#include "attacks.h"
#include "bitboard.h"
#include "position.h"
#include "uci.h"

#include "nnue/features/full_threats.h"
#include "nnue/features/k6r2nc2.h"
#include "nnue/network.h"
#include "nnue/nnue_accumulator.h"
#include "nnue/nnue_misc.h"

using namespace Stockfish;
using namespace Stockfish::Eval::NNUE;

namespace {

bool read_fens(const std::filesystem::path& path, std::vector<std::string>& fens) {
    std::ifstream in(path);
    if (!in)
        return false;

    std::string line;
    while (std::getline(in, line)) {
        while (!line.empty() && (line.back() == '\r' || line.back() == ' '))
            line.pop_back();
        if (line.empty() || line[0] == '#')
            continue;
        fens.push_back(line);
    }
    return true;
}

void write_u32(std::ostream& os, std::uint32_t v) {
    char buf[4];
    std::memcpy(buf, &v, 4);
    os.write(buf, 4);
}

void write_u16(std::ostream& os, std::uint16_t v) {
    char buf[2];
    std::memcpy(buf, &v, 2);
    os.write(buf, 2);
}

void write_i32(std::ostream& os, std::int32_t v) {
    char buf[4];
    std::memcpy(buf, &v, 4);
    os.write(buf, 4);
}

void usage() {
    std::cerr << "usage: pikafish-dump dump <net.nnue> <fens.txt> <out.bin>\n";
}

// Prints the compile-time layout constants and the component hashes that the
// parameter stream is tagged with.  Used to pin down file offsets in
// `training/python/nnue_io.py` without guessing.
void inspect() {
    std::cerr << "ft_hash " << std::hex << FeatureTransformer::get_hash_value() << std::dec << "\n";
    std::cerr << "arch_hash " << std::hex << NetworkArchitecture::get_hash_value() << std::dec << "\n";
    std::cerr << "layer_stacks " << LayerStacks << "\n";
    std::cerr << "l1 " << L1 << " l2 " << L2 << " l3 " << L3 << "\n";
    std::cerr << "threat_dim " << Features::FullThreats::Dimensions << "\n";
    std::cerr << "psq_dim " << Features::K6R2NC2::Dimensions << "\n";
    std::cerr << "weight_scale_bits " << WeightScaleBits << "\n";
    std::cerr << "output_scale " << OutputScale << "\n";
    std::cerr << "bias_bytes " << sizeof(BiasType) << "\n";
    std::cerr << "weight_bytes " << sizeof(WeightType) << "\n";
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        usage();
        return 2;
    }

    const std::string mode = argv[1];

    if (mode == "inspect") {
        inspect();
        return 0;
    }

    if (argc < 5) {
        usage();
        return 2;
    }

    if (mode != "dump") {
        std::cerr << "unknown mode '" << mode << "'\n";
        usage();
        return 2;
    }

    const std::filesystem::path netPath = argv[2];
    const std::filesystem::path fenPath = argv[3];
    const std::filesystem::path outPath = argv[4];

    Attacks::init();
    Position::init();

    auto net = std::make_unique<Network>();
    EvalFile evalFile;
    net->load(netPath.parent_path().empty() ? std::filesystem::path(".") : netPath.parent_path(),
              netPath.filename(), evalFile);
    std::cerr << "net: " << evalFile.netDescription << "\n";

    std::vector<std::string> fens;
    if (!read_fens(fenPath, fens)) {
        std::cerr << "cannot open " << fenPath.string() << "\n";
        return 1;
    }
    std::cerr << "positions: " << fens.size() << "\n";

    std::ofstream out(outPath, std::ios::binary);
    if (!out) {
        std::cerr << "cannot open " << outPath.string() << " for writing\n";
        return 1;
    }

    out.write("PKFD", 4);
    write_u32(out, 2);
    const std::streampos countPos = out.tellp();
    write_u32(out, 0);  // count, patched in at the end
    write_u32(out, Features::FullThreats::Dimensions);
    write_u32(out, Features::K6R2NC2::Dimensions);

    // One stack and one cache set, reused across positions: the cache is
    // designed for exactly this (it diffs its stored pieces against the
    // position), and the stack is reset so no move history leaks in.
    auto stack  = std::make_unique<AccumulatorStack>();
    auto caches = std::make_unique<AccumulatorCaches>(*net);

    std::uint32_t written = 0;
    std::uint32_t skipped = 0;
    std::vector<std::string> kept;

    for (const auto& fen : fens) {
        Position pos;
        StateInfo st;
        if (pos.set(fen, &st)) {
            ++skipped;
            continue;
        }

        // The network is only defined for positions where the side to move is
        // not in check; the engine never evaluates those directly.
        if (pos.checkers()) {
            ++skipped;
            continue;
        }
        kept.push_back(fen);

        stack->reset();
        caches->clear(*net);

        const Value   eval = net->evaluate(pos, *stack, *caches);
        const int     cp   = UCIEngine::to_cp(eval, pos);
        const Color   stm  = pos.side_to_move();
        const auto    stackBucket = Features::K6R2NC2::make_layer_stack_bucket(pos);

        // Both perspectives, in the order the net consumes them.
        std::uint16_t rec[4];
        std::vector<std::uint16_t> indices;
        const Color perspectives[2] = {stm, ~stm};

        for (int p = 0; p < 2; ++p) {
            const Color c = perspectives[p];

            Features::FullThreats::IndexList threats;
            Features::FullThreats::append_active_indices(c, pos, threats);

            const auto [bucket, mirror, attackBucket] = Features::K6R2NC2::make_feature_bucket(c, pos);
            (void) attackBucket;
            Features::K6R2NC2::IndexList psq;

            Bitboard occ = pos.pieces();
            while (occ) {
                const Square sq = pop_lsb(occ);
                psq.push_back(Features::K6R2NC2::make_index(c, sq, pos.piece_on(sq), bucket, mirror));
            }

            rec[2 * p]     = static_cast<std::uint16_t>(threats.size());
            rec[2 * p + 1] = static_cast<std::uint16_t>(psq.size());

            for (std::uint16_t v : threats)
                indices.push_back(v);
            for (std::uint16_t v : psq)
                indices.push_back(static_cast<std::uint16_t>(v + Features::FullThreats::Dimensions));
        }

        for (int i = 0; i < 4; ++i)
            write_u16(out, rec[i]);
        write_u32(out, static_cast<std::uint32_t>(stackBucket));
        write_i32(out, static_cast<std::int32_t>(eval));
        write_i32(out, static_cast<std::int32_t>(cp));
        for (std::uint16_t v : indices)
            write_u16(out, v);

        ++written;
        if (written % 100000 == 0)
            std::cerr << "  " << written << " positions\n";
    }

    out.seekp(countPos);
    write_u32(out, written);
    out.close();

    // The positions the engine refused (illegal FEN, or the side to move is in
    // check and the network is not defined there) are dropped, so the dump is
    // shorter than the input list.  The sidecar keeps the FENs that made it
    // in, in order, so any per-position label can be lined up with it.
    if (!kept.empty())
    {
        std::ofstream fens(outPath.string() + ".fens.txt");
        for (const auto& fen : kept)
            fens << fen << "\n";
    }

    std::cerr << "wrote " << written << " positions";
    if (skipped)
        std::cerr << ", skipped " << skipped;
    std::cerr << " -> " << outPath.string() << "\n";
    return 0;
}
