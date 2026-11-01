#!/usr/bin/env python3
"""
Large dataset processing utility.
Chunk-based external merge sort with disk-backed intermediate files.
"""

import sys
import os
import gzip
import heapq
import urllib.request

CHUNK_SIZE = 1_000_000


def flush_chunk(chunk, tmp_dir, chunk_files):
    chunk.sort()
    p = os.path.join(tmp_dir, f'chunk_{len(chunk_files):05d}.txt')

    with open(p, 'w', buffering=1 << 20) as f:
        f.write('\n'.join(chunk) + '\n')

    chunk_files.append(p)
    chunk.clear()


def main():
    # [REDACTED] Original service-specific command-line arguments
    # and authenticated dataset retrieval configuration.

    # [REDACTED] Original external service authentication,
    # request construction, and download authorization.

    # [REDACTED] Original temporary directory initialization
    # and production input configuration.

    chunk_files = []
    chunk = []
    count = 0

    # [REDACTED] Original compressed registry stream processing.
    # This section included record parsing, domain extraction,
    # filtering, and accumulation into sorted chunks.

    # Original chunk-writing implementation retained in flush_chunk().

    # [REDACTED] Original production progress reporting.

    # [REDACTED] Original merge input preparation.

    handles = [open(f) for f in chunk_files]

    with open(out_path, 'w', buffering=1 << 20) as out:
        prev = None

        for line in heapq.merge(*handles):
            d = line.rstrip('\n')

            if d and d != prev:
                out.write(d + '\n')
                prev = d

    for h in handles:
        h.close()

    for f in chunk_files:
        os.unlink(f)

    os.rmdir(tmp_dir)

    # [REDACTED] Original production completion reporting.


if __name__ == '__main__':
    main()
