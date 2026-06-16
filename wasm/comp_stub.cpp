/*
  comp_stub.cpp — satisfy the cbang compression symbols that cbang's
  SystemUtilities file I/O references, WITHOUT pulling zlib/bzip2/lz4.
  Our G-code input is always uncompressed, so compressionFromPath() returns NONE
  and the (inline-templated) zlib/bzip2/lz4 compressor branches in
  CompressionFilter.h are never executed at runtime. Those backend symbols are
  linked as allowed-undefined (-sERROR_ON_UNDEFINED_SYMBOLS=0); these two
  functions are the only comp entry points actually called.
*/
#include <cbang/comp/Compression.h>

namespace cb {
  Compression compressionFromPath(const std::string &) {
    return Compression::COMPRESSION_NONE;
  }
  const char *compressionExtension(Compression) { return ""; }
}
