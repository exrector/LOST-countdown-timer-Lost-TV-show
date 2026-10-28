# RNNoise 0.2 (vendored)

Source: https://github.com/xiph/rnnoise/releases/download/v0.2/rnnoise-0.2.tar.gz
(sha256 `90fce4b00b9ff24c08dbfe31b82ffd43bae383d85c5535676d28b0a2b11c0d37`, tag `v0.2`
at `c9137adac37fe21ede831f8a0aa31c17560c01e7`). Only the library sources listed in its
`Makefile.am` (`RNNOISE_SOURCES`, generic C, no x86 runtime dispatch) and the headers
they include are kept, unmodified. BSD-3-Clause, see `COPYING`.

`script/build_and_run.sh` compiles them into LOSTNative; the station has no package
manager build of RNNoise and Monterey's toolchain cannot run SwiftPM here.

The 0.2 tarball omits `os_support.h`, which only the non-x86 (NEON/plain C) paths include,
so this copy builds for x86_64 — the Intel station — via `vec_avx.h`. Build on Apple
Silicon with `LOST_BUILD_ARCH=x86_64`.
